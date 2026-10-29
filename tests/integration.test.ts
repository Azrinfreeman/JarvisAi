import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AIClient } from '../src/integration/ai-client.js';
import { workerEnvironment, validToWorker, validFromWorker, type AskInput } from '../src/integration/protocol.js';
import { commandOwner, DispatchGate } from '../src/integration/routing.js';
import { combinedCommands } from '../src/commands.js';
import { Conversations } from '../src/storage.js';
import { conversationKey } from '../src/chat.js';
import { handleSleep } from '../src/integration/sleep-handler.js';
import { SessionStore } from '../src/sleep/storage/session-store.js';
import { SessionManager } from '../src/sleep/session/session-manager.js';

const identity = {guildId:'111111111111111111',channelId:'222222222222222222',userId:'333333333333333333',visibility:'private' as const};
let event = 444444444444444440n;
const input = (prompt = 'Hello'): AskInput => ({identity,prompt,eventKey:`interaction:555555555555555555:${event++}`});
test('unreadable saved connection leaves AI unavailable without a restart loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'combined-credential-'));
  writeFileSync(join(dir, 'chatgpt.dpapi'), 'invalid-encrypted-credential');
  const client = new AIClient({env:{...process.env, AI_PROVIDER:'chatgpt', AI_DATA_DIR:dir}, restartMs:20});
  const phases: string[] = [];
  client.on('status', status => phases.push(status.phase));
  client.start();
  try {
    const timeout = AbortSignal.timeout(30000);
    while (client.status.phase !== 'unavailable') await once(client, 'status', {signal:timeout});
    assert.match(client.status.label, /npm run auth -- login/);
    while (client.workerPid) await delay(50);
    await delay(200);
    assert.deepEqual(phases, ['starting', 'unavailable']);
    assert.equal(client.workerPid, undefined);
  } finally { await close(client, dir); }
});
async function ready(client: AIClient) {
  const timeout = AbortSignal.timeout(20000);
  while (client.status.phase !== 'ready') await once(client,'status',{signal:timeout});
}
async function close(client: AIClient, dir?: string) {
  client.close();
  await delay(500);
  if (dir) rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
test('single command owner preserves all commands and atomically suppresses replay',() => {
  assert.deepEqual(combinedCommands.map(c => c.name),['ask','reset','status','help','sleep','voice-summary','nickname']);
  assert.equal(commandOwner('voice-summary'),'voice-summary');
  assert.equal(commandOwner('nickname'),'nickname');
  assert.equal(commandOwner('sleep'),'sleep'); assert.equal(commandOwner('ask'),'ai'); assert.equal(commandOwner('other'),undefined);
  const gate = new DispatchGate(); assert.equal(gate.claim('one'),true); assert.equal(gate.claim('one'),false);
});
test('worker environment excludes Discord credentials and unrelated inherited secrets',() => {
  const env = workerEnvironment({PATH:'runtime',DISCORD_TOKEN:'secret',DISCORD_BOT_TOKEN:'secret',OPENAI_API_KEY:'secret',NODE_OPTIONS:'injected',AI_PROVIDER:'stub',AI_DATA_DIR:'local'});
  assert.deepEqual(env,{PATH:'runtime',AI_DATA_DIR:'local',AI_PROVIDER:'stub'});
});
test('IPC validates scope, event keys, message kinds, output attachment caps and payload lengths',() => {
  assert.ok(validToWorker({type:'ask',id:'x',input:input()}));
  for (const change of [{identity:{...identity,guildId:'other'}},{prompt:'x'.repeat(4001)},{eventKey:'arbitrary'}]) {
    assert.ok(!validToWorker({type:'ask',id:'x',input:{...input(),...change}}));
  }
  assert.ok(!validToWorker({type:'shell',id:'x',command:'anything'}));
  assert.ok(!validFromWorker({type:'result',id:'x',payload:{content:'x'.repeat(2001)}}));
  assert.ok(!validFromWorker({type:'result',id:'x',payload:{content:'',files:[{attachment:Buffer.alloc(8*1024*1024+1),name:'x',description:'x'}]}}));
});
test('real isolated stub worker commits only after delivery, resolves references once, and rejects failed-turn/replay saves',async () => {
  const dir=mkdtempSync(join(tmpdir(),'combined-ai-'));
  const client = new AIClient({env:{...process.env,AI_PROVIDER:'stub',AI_DATA_DIR:dir}}); client.start();
  try {
    await ready(client);
    const store = new Conversations(join(dir,'conversations.sqlite'));
    try {
      const request=input('Explain'); request.hasReference=true;
      let reads=0,deliveries=0;
      assert.equal(await client.ask(request,async payload => {
        deliveries++; assert.match(payload.content,/selected message/);
        assert.deepEqual(store.get(conversationKey(identity)),[]);
      },async () => { reads++; return {text:'selected message'}; }),true);
      assert.equal(reads,1); assert.equal(deliveries,1);
      assert.equal(store.get(conversationKey(identity)).length,2);
      assert.equal(await client.ask(request,async () => { throw new Error('Replay delivered'); }),false);
      await delay(5100);
      await assert.rejects(client.ask(input('Undelivered'),async () => { throw new Error('Delivery failure'); }),/delivery failed/);
      assert.equal(store.get(conversationKey(identity)).length,2);
      await client.reset(identity); assert.deepEqual(store.get(conversationKey(identity)),[]);
    } finally { store.close(); }
  } finally { await close(client,dir); }
});
test('duplicate worker result messages invoke one delivery callback',async () => {
  const client = new AIClient({entry:fileURLToPath(new URL('./fixtures/duplicate-worker.ts',import.meta.url))}); client.start();
  try { await ready(client); let sends=0; await client.ask(input(),async payload => {
    sends++; assert.deepEqual(payload.files![0]!.attachment,Buffer.from([1,2,3])); assert.equal(payload.embeds!.length,2); await delay(20);
  }); assert.equal(sends,1); }
  finally { await close(client); }
});
test('ordinary AI member cannot change sleep state; rejection is private and no ambience announcement is sent',async () => {
  const calls: string[]=[];
  const interaction: any = {
    inGuild:()=>true,guildId:identity.guildId,guild:{ownerId:'owner',members:{fetch:async () => ({id:identity.userId,permissions:{has:()=>false},roles:{cache:{some:()=>false}}})}},user:{id:identity.userId},
    options:{getSubcommand:()=> 'on',getSubcommandGroup:()=> 'rain'},
    deferReply:async () => calls.push('private defer'),editReply:async (text: string) => {calls.push(text);},followUp:async () => calls.push('announcement'),
  };
  const sessions: any = {setMode:async () => { throw new Error('Unauthorized voice change'); }};
  await handleSleep(interaction,sessions,new Set());
  assert.equal(calls.length,2); assert.match(calls[1]!,/Only the server owner/);
});
test('worker startup failure remains contained and client can stop without a running Discord client',async () => {
  const dir=mkdtempSync(join(tmpdir(),'combined-locked-'));
  const {writeFileSync}=await import('node:fs'); writeFileSync(join(dir,'runtime.lock'),'someone-else');
  const client=new AIClient({env:{...process.env,AI_PROVIDER:'stub',AI_DATA_DIR:dir},restartMs:10000}); client.start();
  try {
    while (client.status.phase !== 'unavailable' && client.status.phase !== 'restarting') await once(client,'status',{signal:AbortSignal.timeout(10000)});
    await assert.rejects(client.ask(input(),async () => {}),/unavailable|starting/);
  } finally { await close(client,dir); }
});

test('worker crash releases only its own orphan lock, rejects the old request and recovers without replay',async () => {
  const dir=mkdtempSync(join(tmpdir(),'combined-crash-'));
  const client=new AIClient({entry:fileURLToPath(new URL('./fixtures/crash-worker.ts',import.meta.url)),env:{...process.env,AI_DATA_DIR:dir},restartMs:30});
  const sessions=new SessionStore(join(dir,'sessions.sqlite'));
  const manager=new SessionManager({},sessions,{sunnyAssetPath:resolve('assets/sunny-birds-loop.pcm'),rainVolume:0.5});
  let destroyed=0;
  const voice:any={state:{status:'ready'},subscribe:()=>({unsubscribe(){}}),destroy(){destroyed++;}};
  manager.getConnection=()=>voice;
  sessions.save({guildId:identity.guildId,channelId:identity.channelId,mode:'sunny',state:'active',rainStyle:'variety'});
  manager.applyAudio(identity.guildId);
  const player=manager.getRuntime(identity.guildId).player;
  client.start(); let deliveries=0;
  let heartbeat=0; const timer=setInterval(()=>heartbeat++,10);
  try {
    await ready(client);
    await assert.rejects(client.ask(input(),async()=>{deliveries++;}),/restarted/);
    await ready(client);
    assert.equal(deliveries,0);
    await client.ask(input(),async payload=>{deliveries++;assert.equal(payload.content,'Recovered');});
    assert.equal(deliveries,1); assert.ok(heartbeat>5);
    assert.equal(manager.getRuntime(identity.guildId).player,player);
    assert.equal(manager.getConnection(identity.guildId),voice); assert.equal(destroyed,0);
    assert.equal(sessions.get(identity.guildId)!.mode,'sunny');
  } finally { clearInterval(timer); manager.shutdown(); sessions.close(); await close(client,dir); }
});

test('authorized ambience change produces one private acknowledgment and one intentional public announcement',async () => {
  const calls:string[]=[];
  const interaction:any={inGuild:()=>true,guildId:identity.guildId,guild:{ownerId:identity.userId,members:{fetch:async()=>({id:identity.userId})}},user:{id:identity.userId},
    options:{getSubcommand:()=> 'on',getSubcommandGroup:()=> 'sunny'},
    deferReply:async(options:any)=>{assert.equal(options.flags,64);calls.push('defer');},
    editReply:async()=>calls.push('private'),followUp:async(options:any)=>{assert.equal(options.flags,undefined);calls.push('public');}};
  await handleSleep(interaction,{setMode:async()=>{calls.push('mode');return 'Sunny on';}} as any,new Set());
  assert.deepEqual(calls,['defer','mode','private','public']);
});
