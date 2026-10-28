import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SettingsStore } from '../src/settings.js';
import { BotSupervisor } from '../src/dashboard/supervisor.js';
import { ownsProcess, type ProcessIdentity, type RuntimeIdentity } from '../src/integration/runtime-control.js';

const id='123456789012345678';
async function fixture(run: (context: ReturnType<typeof setup>) => Promise<void>) {
  const root=mkdtempSync(join(tmpdir(),'rainbot-supervisor-'));
  try { await run(setup(root)); } finally { rmSync(root,{recursive:true,force:true}); }
}
function setup(root: string) {
  const settings=new SettingsStore(root,{});
  mkdirSync(join(root,'assets')); mkdirSync(join(root,'data/dashboard'),{recursive:true});
  writeFileSync(join(root,'.env'),`DISCORD_BOT_TOKEN=synthetic-discord-token\nDISCORD_APPLICATION_ID=${id}\nDISCORD_GUILD_ID=${id}\nOWNER_DISCORD_ID=${id}\nAI_PROVIDER=stub\n`);
  for (const name of ['rain-loop','rain-soft-loop','rain-indoor-loop','rain-glass-loop','rain-heavy-loop','sunny-birds-loop','thunder-distant-a','thunder-distant-b','thunder-distant-c','thunder-distant-d']) writeFileSync(join(root,'assets',name+'.pcm'),'fixture');
  let running=false; let launches=0; let stops=0;
  const identity: RuntimeIdentity={pid:111,created:'creation-one',instance:'test-instance',root,revision:settings.effective().revision};
  const info = (pid: number): ProcessIdentity => ({pid,parentPid:pid===222 ? 111 : 1,created:pid===111 ? identity.created : 'worker-one',executable:process.execPath,directory:root,commandLine:`node ${join(root,pid===111 ? 'src/main.ts' : 'src/integration/ai-worker.ts')}`});
  const dependencies={
    inspect:async (pid: number) => running && [111,222].includes(pid) ? info(pid) : null,
    request:async (_root: string,_identity: RuntimeIdentity,action: 'identity'|'shutdown') => {
      if (action==='shutdown') {stops++;running=false;}
      return {...identity,workerPid:222};
    },
    launch:async () => {
      launches++;running=true;
      mkdirSync(join(root,`data/frontend/${id}`),{recursive:true});
      writeFileSync(join(root,`data/frontend/${id}/runtime.lock`),'111');
      writeFileSync(join(root,'data/dashboard/runtime.json'),JSON.stringify(identity));
      return 111;
    }, timeout:100,interval:1,
  };
  return {root,settings,identity,info,dependencies,get launches(){return launches;},get stops(){return stops;},setRunning(value: boolean){running=value;}};
}
async function finish(supervisor: BotSupervisor, operation: {id: string}) {
  for (let i=0;i<200;i++) { const value=supervisor.getOperation(operation.id)!; if (value.status!=='pending') return value; await delay(5); }
  throw new Error('Operation did not finish');
}

test('concurrent Start requests create one bot and a new supervisor can recover management',async () => fixture(async ctx => {
  const supervisor=new BotSupervisor(ctx.settings,ctx.dependencies);
  const first=supervisor.begin('start'); const duplicate=supervisor.begin('start');
  assert.equal(first.id,duplicate.id); assert.equal((await finish(supervisor,first)).status,'completed');
  assert.equal(ctx.launches,1);
  const reopened=new BotSupervisor(ctx.settings,ctx.dependencies);
  assert.equal((await reopened.status()).state,'running');
  const again=await finish(reopened,reopened.begin('start'));
  assert.equal(again.status,'failed'); assert.equal(ctx.launches,1);
}));

test('Stop verifies the frontend and worker and sends cooperative shutdown once',async () => fixture(async ctx => {
  const supervisor=new BotSupervisor(ctx.settings,ctx.dependencies);
  await finish(supervisor,supervisor.begin('start'));
  const stopped=await finish(supervisor,supervisor.begin('stop'));
  assert.equal(stopped.status,'completed'); assert.equal(ctx.stops,1);
  // The supervisor never removes the bot's lock, credentials, or session data itself.
  assert.equal(readFileSync(join(ctx.root,`data/frontend/${id}/runtime.lock`),'utf8'),'111');
}));

test('foreign locks and stale locks block Start without deletion or another launch',async () => fixture(async ctx => {
  const dir=join(ctx.root,'data/ai'); mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'runtime.lock'),'333');
  const supervisor=new BotSupervisor(ctx.settings,ctx.dependencies);
  assert.equal((await supervisor.status()).state,'blocked');
  assert.equal((await finish(supervisor,supervisor.begin('start'))).status,'failed');
  assert.equal(ctx.launches,0); assert.ok(existsSync(join(dir,'runtime.lock')));
  const external=new BotSupervisor(ctx.settings,{...ctx.dependencies,inspect:async () => ctx.info(333)});
  assert.equal((await external.status()).state,'external');
}));

test('explicit recovery clears stale runtime locks and allows startup',async () => fixture(async ctx => {
  const paths=[join(ctx.root,'data/ai/runtime.lock'),join(ctx.root,`data/frontend/${id}/runtime.lock`),join(ctx.root,'data/runtime.lock')];
  for (const path of paths) {
    mkdirSync(join(path,'..'),{recursive:true});
    writeFileSync(path,'333');
  }
  const supervisor=new BotSupervisor(ctx.settings,ctx.dependencies);
  assert.equal((await supervisor.clearStaleLocks()).cleared,3);
  assert.ok(paths.every(path => !existsSync(path)));
  assert.equal((await supervisor.status()).state,'stopped');
  assert.equal((await finish(supervisor,supervisor.begin('start'))).status,'completed');
  assert.equal(ctx.launches,1);
}));

test('recovery preserves all locks if any owner is alive or cannot be inspected',async () => fixture(async ctx => {
  const stale=join(ctx.root,'data/runtime.lock');
  const active=join(ctx.root,'data/ai/runtime.lock');
  mkdirSync(join(active,'..'),{recursive:true});
  writeFileSync(stale,'333'); writeFileSync(active,'222');
  for (const inspect of [async (pid: number) => pid === 222 ? ctx.info(pid) : null,async () => {throw new Error('Process access denied');}]) {
    const supervisor=new BotSupervisor(ctx.settings,{...ctx.dependencies,inspect});
    await assert.rejects(supervisor.clearStaleLocks());
    assert.ok(existsSync(stale)); assert.ok(existsSync(active));
  }
}));

test('recovery rejects invalid and changed locks',async () => fixture(async ctx => {
  const path=join(ctx.root,'data/runtime.lock');
  writeFileSync(path,'invalid');
  const supervisor=new BotSupervisor(ctx.settings,ctx.dependencies);
  await assert.rejects(supervisor.clearStaleLocks(),/invalid owner/);
  writeFileSync(path,'333');
  const changed=new BotSupervisor(ctx.settings,{...ctx.dependencies,inspect:async () => {writeFileSync(path,'444');return null;}});
  await assert.rejects(changed.clearStaleLocks(),/changed during recovery/);
  assert.equal(readFileSync(path,'utf8'),'444');
}));

test('recovery rejects active recorded launches and pending operations',async () => fixture(async ctx => {
  const supervisor=new BotSupervisor(ctx.settings,ctx.dependencies);
  const operation=supervisor.begin('start');
  await assert.rejects(supervisor.clearStaleLocks(),/current bot operation/);
  await finish(supervisor,operation);
  await assert.rejects(supervisor.clearStaleLocks(),/still running/);
  assert.ok(existsSync(join(ctx.root,`data/frontend/${id}/runtime.lock`)));
}));

test('recovery with no runtime locks leaves settings locks untouched',async () => fixture(async ctx => {
  const path=join(ctx.settings.directory,'settings.lock');
  writeFileSync(path,'');
  const supervisor=new BotSupervisor(ctx.settings,ctx.dependencies);
  assert.equal((await supervisor.clearStaleLocks()).cleared,0);
  assert.ok(existsSync(path));
}));

test('PID reuse, wrong directory, wrong entry, and worker parent mismatch reject Stop',async () => fixture(async ctx => {
  await ctx.dependencies.launch();
  for (const patch of [
    {created:'reused-pid'}, {directory:tmpdir()}, {commandLine:'node unrelated.ts'},
  ]) {
    const supervisor=new BotSupervisor(ctx.settings,{...ctx.dependencies,inspect:async pid => ({...ctx.info(pid),...(pid===111 ? patch : {})})});
    assert.equal((await finish(supervisor,supervisor.begin('stop'))).status,'failed');
  }
  const wrongWorker=new BotSupervisor(ctx.settings,{...ctx.dependencies,inspect:async pid => ({...ctx.info(pid),...(pid===222 ? {parentPid:999} : {})})});
  assert.equal((await finish(wrongWorker,wrongWorker.begin('stop'))).status,'failed');
  assert.equal(ctx.stops,0);
  assert.equal(ownsProcess({...ctx.info(111),commandLine:'node --eval "src/main.ts"'},ctx.root,'src/main.ts'),false);
}));

test('startup timeout persists the launched PID and blocks a second attempt',async () => fixture(async ctx => {
  let launches=0;
  const supervisor=new BotSupervisor(ctx.settings,{...ctx.dependencies,timeout:15,
    launch:async () => {launches++;ctx.setRunning(true);return 111;}});
  assert.equal((await finish(supervisor,supervisor.begin('start'))).status,'failed');
  assert.equal((await supervisor.status(true)).state,'blocked');
  assert.equal((await finish(supervisor,supervisor.begin('start'))).status,'failed');
  assert.equal(launches,1);
}));

test('shutdown timeout does not escalate and leaves Start blocked',async () => fixture(async ctx => {
  await ctx.dependencies.launch();
  let requests=0;
  const supervisor=new BotSupervisor(ctx.settings,{...ctx.dependencies,timeout:15,
    request:async () => {requests++;return {...ctx.identity,workerPid:222};}});
  const result=await finish(supervisor,supervisor.begin('stop'));
  assert.equal(result.status,'failed'); assert.match(result.message,/No process was force-stopped/);
  assert.equal((await supervisor.status(true)).state,'running');
  assert.equal((await finish(supervisor,supervisor.begin('start'))).status,'failed');
  assert.equal(ctx.launches,1); assert.ok(requests>=2);
}));

test('cross-dashboard operations serialize using an exclusive installation lock',async () => fixture(async ctx => {
  const first=new BotSupervisor(ctx.settings,ctx.dependencies); const second=new BotSupervisor(ctx.settings,ctx.dependencies);
  let release!: () => void;
  const held=first.exclusive(() => new Promise<void>(resolve => {release=resolve;}));
  await assert.rejects(second.exclusive(() => 'conflict'),/Another dashboard/);
  release();await held;
  assert.equal(await second.exclusive(() => 'saved'),'saved');
}));

test('a runtime from another installed build requires shutdown through its original app',async () => fixture(async ctx => {
  await ctx.dependencies.launch();
  writeFileSync(join(ctx.root,'data/dashboard/runtime.json'),JSON.stringify({...ctx.identity,build:{protocol:1,resources:join(ctx.root,'older-build'),runtime:process.execPath}}));
  const supervisor=new BotSupervisor(ctx.settings,ctx.dependencies);
  const status=await supervisor.status(true);
  assert.equal(status.state,'external');assert.match(status.message,/another app version/);
  assert.equal(ctx.stops,0);
}));
