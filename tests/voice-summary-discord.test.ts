import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionFlagsBits, type Client, type Guild, type ChatInputCommandInteraction, type VoiceState } from 'discord.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { VoiceConnection } from '@discordjs/voice';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../src/sleep/session/session-manager.js';
import { VoiceCommands } from '../src/voice-summary/discord.js';
import { VoiceSummaryService } from '../src/voice-summary/service.js';
import { voiceConfig } from '../src/voice-summary/config.js';
import { combinedCommands } from '../src/commands.js';

const owner='123456789012345678',other='223456789012345678',channelId='323456789012345678',guildId='423456789012345678';
function fixture(consentMode='individual') {
  const root=mkdtempSync(join(tmpdir(),'voice-discord-'));const sent:unknown[]=[];
  let sendAllowed=true;
  const channel={id:channelId,type:ChannelType.GuildVoice,members:new Collection<string,unknown>(),
    permissionsFor:()=>({has:(permissions:bigint|bigint[])=>sendAllowed || !(Array.isArray(permissions)?permissions:[permissions]).includes(PermissionFlagsBits.SendMessages)}),
    send:async(value:unknown)=>{if(!sendAllowed)throw new Error('Synthetic Send Messages denial');sent.push(value);return {};}};
  const guild={id:guildId,ownerId:owner,members:{fetch:async(input:string|{user:string;force:boolean})=>members.get(typeof input==='string'?input:input.user)!,fetchMe:async()=>({})},
    channels:{fetch:async()=>channel,cache:new Collection([[channelId,channel]])}};
  const member=(id:string)=>({id,user:{bot:false},guild,voice:{channel},displayName:id===owner?'Ali':'Siti',roles:{cache:new Collection()},permissions:{has:()=>false}});
  const members=new Map([[owner,member(owner)],[other,member(other)]]);
  for(const [id,value] of members)channel.members.set(id,value);
  const connection=Object.assign(new EventEmitter(),{joinConfig:{channelId,guildId,selfDeaf:true,selfMute:false},state:{status:'ready'},rejoin:()=>true,
    receiver:{subscribe:()=>new PassThrough()}});
  const sessions={getConnection:()=>connection} as unknown as SessionManager;
  const service=new VoiceSummaryService(root,voiceConfig({VOICE_SUMMARY_PROVIDER:'openai',VOICE_SUMMARY_ENABLED:'true',VOICE_SUMMARY_CONSENT_MODE:consentMode,VOICE_SUMMARY_API_KEY:'synthetic'}),{
    transcribe:async()=>{throw new Error('No test should upload audio');},summarize:async()=>{throw new Error('No test should invoke summary');},
  });
  const client={user:{id:'523456789012345678'},rest:{post:async(_route:string,options:{signal?:AbortSignal;body?:unknown;files?:unknown})=>{
    options.signal?.throwIfAborted();sent.push(options.body);return {};
  }}};
  const commands=new VoiceCommands(client as unknown as Client,sessions,service,
    {guildId,ownerId:owner,channels:[],roles:[],accessMode:'owner',provider:'stub',token:'synthetic',model:undefined,reasoningEffort:undefined},new Set());
  const interaction=(command:string,userId=owner,textChannel=channelId)=>({guild,guildId,channelId:textChannel,id:String(Date.now()),createdTimestamp:Date.now(),user:{id:userId},
    options:{getSubcommand:()=>command,getBoolean:()=>false,getInteger:()=>undefined},deferReply:async()=>{},reply:async()=>{},editReply:async()=>{}} as unknown as ChatInputCommandInteraction);
  return {root,sent,channel,guild,members,client,connection:connection as unknown as VoiceConnection,service,commands,interaction,
    denySend:()=>{sendAllowed=false;},close:()=>{service.close();rmSync(root,{recursive:true,force:true});}};
}

test('voice slash command contract includes explicit consent and bounded test controls',()=>{
  const command=combinedCommands.find(value=>value.name==='voice-summary')!;
  const options=command.options!;
  assert.deepEqual(options.map(option=>option.name),['start','consent','withdraw','stop','status','summarize','transcript','test']);
  assert.ok(command.description.length<=100);
  assert.ok(options.every(option=>option.description.length<=100));
});

test('start requires a controller and posts notice before capture; ordinary participants can consent and withdraw',async()=>{
  const ctx=fixture();
  try {
    await assert.rejects(ctx.commands.interaction(ctx.interaction('start',other)),/controller/);
    assert.equal(ctx.sent.length,0);assert.equal(ctx.service.capture.state,'off');
    await ctx.commands.interaction(ctx.interaction('start'));assert.equal(ctx.sent.length,1);assert.equal(ctx.service.capture.state,'waiting');
    assert.match(String((ctx.sent[0] as {content:string}).content),/Everyone must use/);
    await ctx.commands.interaction(ctx.interaction('consent',other));assert.equal(ctx.service.capture.state,'waiting');
    await ctx.commands.interaction(ctx.interaction('withdraw',other));assert.equal(ctx.service.capture.state,'off');
  } finally {ctx.close();}
});

test('voice requests reject cross-channel delivery, missing permissions and unauthorized AI members',async()=>{
  const ctx=fixture();
  try {
    await assert.rejects(ctx.commands.interaction(ctx.interaction('transcript',owner,'another-channel')),/own text chat/);
    ctx.service.capture.start(guildId,channelId,[owner,other],ctx.connection);
    await assert.rejects(ctx.commands.interaction(ctx.interaction('transcript',other)),/AI access/);
    ctx.denySend();await assert.rejects(ctx.commands.interaction(ctx.interaction('status')),/Send Messages/);
  } finally {ctx.close();}
});

test('server beta mode announces before receiving, skips individual consent and preserves withdrawal',async()=>{
  const ctx=fixture('server');let subscriptions=0;
  ctx.connection.receiver.subscribe=()=>{
    assert.equal(ctx.sent.length,1);
    assert.match((ctx.sent[0] as {content:string}).content,/prior consent.*server beta testers/);
    subscriptions++;return new PassThrough() as unknown as ReturnType<typeof ctx.connection.receiver.subscribe>;
  };
  try {
    await assert.rejects(ctx.commands.interaction(ctx.interaction('start',other)),/controller/);
    await ctx.commands.interaction(ctx.interaction('start'));
    assert.equal(ctx.service.capture.state,'listening');assert.equal(subscriptions,2);
    assert.equal(ctx.service.capture.pending.length,0);
    ctx.denySend();await ctx.commands.interaction(ctx.interaction('withdraw',other));
    assert.equal(ctx.service.capture.state,'off');assert.equal(ctx.service.capture.epoch,undefined);
  } finally {ctx.close();}
});

test('server beta mode never captures if its public listening notice fails',async()=>{
  const ctx=fixture('server');let subscriptions=0;
  ctx.connection.receiver.subscribe=()=>{subscriptions++;return new PassThrough() as unknown as ReturnType<typeof ctx.connection.receiver.subscribe>;};
  ctx.channel.send=async()=>{throw new Error('Synthetic notice failure');};
  try {
    await assert.rejects(ctx.commands.interaction(ctx.interaction('start')),/notice failure/);
    assert.equal(subscriptions,0);assert.equal(ctx.service.capture.state,'off');
  } finally {ctx.close();}
});

test('server joins and leaves update status without posting participant notices or resetting coverage',async()=>{
  const ctx=fixture('server');
  try {
    await ctx.commands.interaction(ctx.interaction('start'));const epoch=ctx.service.capture.epoch;
    ctx.sent.length=0;
    const event=(id:string)=>({id,guild:ctx.guild,channelId} as unknown as VoiceState);
    ctx.channel.members.delete(other);ctx.denySend();
    ctx.commands.voiceState(event(other),{...event(other),channelId:null} as VoiceState);
    assert.equal(ctx.service.capture.participants,1);assert.equal(ctx.service.capture.state,'listening');
    ctx.channel.members.set(other,ctx.members.get(other)!);
    ctx.commands.voiceState({...event(other),channelId:null} as VoiceState,event(other));
    ctx.commands.voiceState(event(other),event(other));
    assert.equal(ctx.service.capture.participants,2);assert.equal(ctx.service.capture.epoch,epoch);
    assert.equal(ctx.sent.length,0);
  } finally {ctx.close();}
});

test('accepted server request posts to original channel after requester leaves or moves voice',async()=>{
  for(const moved of [false,true]) {
    const ctx=fixture('server');
    try {
      await ctx.commands.interaction(ctx.interaction('start'));ctx.sent.length=0;
      ctx.service.process=async options=>{
        const epoch=ctx.service.capture.epoch!;
        ctx.channel.members.delete(owner);
        ctx.members.get(owner)!.voice.channel=(moved?{...ctx.channel,id:'another-channel'}:null) as unknown as typeof ctx.channel;
        await options.guard();
        assert.equal(options.names.get(owner),'Ali');
        await options.deliver({content:'Preserved summary'},{signal:new AbortController().signal,epoch});
      };
      await ctx.commands.interaction(ctx.interaction('summarize'));
      assert.equal(ctx.sent.length,1);assert.match(JSON.stringify(ctx.sent[0]),/Preserved summary/);
      assert.equal(ctx.service.capture.participants,1);
    } finally {ctx.close();}
  }
});

test('accepted server request rejects revoked requester visibility or bot send permissions',async()=>{
  for(const denied of ['requester','bot'] as const) {
    const ctx=fixture('server');
    try {
      await ctx.commands.interaction(ctx.interaction('start'));ctx.sent.length=0;
      ctx.service.process=async options=>{
        if(denied==='bot')ctx.denySend();
        else ctx.channel.permissionsFor=(member?:unknown)=>({has:()=>member!==ctx.members.get(owner)});
        await options.deliver({content:'Must not post'},{signal:new AbortController().signal,epoch:ctx.service.capture.epoch!});
      };
      await assert.rejects(ctx.commands.interaction(ctx.interaction('summarize')),denied==='bot'?/Send Messages/:/no longer have access/);
      assert.equal(ctx.sent.length,0);
    } finally {ctx.close();}
  }
});

test('server membership changes do not cancel a result already queued for Discord delivery',async()=>{
  const ctx=fixture('server');let queued!:()=>void,release!:()=>void;
  const reached=new Promise<void>(resolve=>{queued=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  try {
    await ctx.commands.interaction(ctx.interaction('start'));ctx.sent.length=0;
    ctx.client.rest.post=async(_route,options)=>{queued();await gate;options.signal?.throwIfAborted();ctx.sent.push(options.body);return {};};
    ctx.service.process=async options=>{
      const controller=new AbortController();const abort=()=>controller.abort();
      ctx.service.capture.on('invalidated',abort);
      try {await options.deliver({content:'Queued summary'},{signal:controller.signal,epoch:ctx.service.capture.epoch!});}
      finally {ctx.service.capture.off('invalidated',abort);}
    };
    const pending=ctx.commands.interaction(ctx.interaction('summarize'));await reached;
    ctx.channel.members.delete(other);ctx.service.capture.membership([owner]);release();await pending;
    assert.equal(ctx.sent.length,1);
  } finally {release();ctx.close();}
});

test('noncontroller cannot stop the session but can explicitly withdraw consent',async()=>{
  const ctx=fixture();
  try {
    ctx.service.capture.start(guildId,channelId,[owner,other],ctx.connection);
    await assert.rejects(ctx.commands.interaction(ctx.interaction('stop',other)),/controller/);
    assert.equal(ctx.service.capture.state,'waiting');
    await ctx.commands.interaction(ctx.interaction('withdraw',other));assert.equal(ctx.service.capture.state,'off');
  } finally {ctx.close();}
});

test('withdrawal stops capture even if notice send permission was revoked',async()=>{
  const ctx=fixture();
  try {
    ctx.service.capture.start(guildId,channelId,[owner],ctx.connection);
    await ctx.service.capture.accept(owner);assert.equal(ctx.service.capture.state,'listening');
    ctx.denySend();await ctx.commands.interaction(ctx.interaction('withdraw'));
    assert.equal(ctx.service.capture.state,'off');assert.equal(ctx.service.capture.epoch,undefined);
  } finally {ctx.close();}
});

test('a consent command delayed during member lookup cannot authorize a replacement session',async()=>{
  const ctx=fixture();let release:()=>void=()=>{};let lookedUp:()=>void=()=>{};
  try {
    ctx.service.capture.start(guildId,channelId,[owner,other],ctx.connection);
    const original=ctx.guild.members.fetch;
    const reached=new Promise<void>(resolve=>{lookedUp=resolve;});
    ctx.guild.members.fetch=async(id)=>{lookedUp();await new Promise<void>(resolve=>{release=resolve;});return original(id);};
    const pending=ctx.commands.interaction(ctx.interaction('consent'));
    await reached;ctx.service.capture.stop();ctx.service.capture.start(guildId,channelId,[owner,other],ctx.connection,true);release();
    await assert.rejects(pending,/notice changed/);assert.equal(ctx.service.capture.state,'waiting');assert.equal(ctx.service.capture.pending.length,2);
  } finally {ctx.close();}
});

test('an old result cannot post when stop/start happens during the delivery permission lookup',{timeout:5000},async()=>{
  const ctx=fixture();let release:()=>void=()=>{};let checked:()=>void=()=>{};
  try {
    ctx.service.capture.start(guildId,channelId,[owner,other],ctx.connection);
    await ctx.service.capture.accept(owner);await ctx.service.capture.accept(other);
    const epoch=ctx.service.capture.epoch!;
    const reached=new Promise<void>(resolve=>{checked=resolve;});
    ctx.service.process=async options=>{
      let first=true;
      ctx.guild.members.fetchMe=async()=>{if(first){first=false;checked();await new Promise<void>(resolve=>{release=resolve;});}return {};};
      await options.deliver({content:'Old private conversation',files:[{name:'voice.txt',attachment:Buffer.from('Old'),description:'Old'}]},
        {signal:new AbortController().signal,epoch});
    };
    const pending=ctx.commands.interaction(ctx.interaction('transcript'));
    await reached;ctx.service.capture.stop();ctx.service.capture.start(guildId,channelId,[owner,other],ctx.connection);
    await ctx.service.capture.accept(owner);await ctx.service.capture.accept(other);release();
    await assert.rejects(pending,/Listening.*changed/);assert.equal(ctx.sent.length,0);
  } finally {ctx.close();}
});

test('withdrawal aborts a result waiting in the REST delivery queue',{timeout:5000},async()=>{
  const ctx=fixture();let queued:()=>void=()=>{};
  try {
    ctx.service.capture.start(guildId,channelId,[owner,other],ctx.connection);
    await ctx.service.capture.accept(owner);await ctx.service.capture.accept(other);
    const reached=new Promise<void>(resolve=>{queued=resolve;});
    ctx.client.rest.post=async(_route,options)=>{
      assert.ok(options.signal);queued();
      await new Promise<void>((_resolve,reject)=>options.signal!.addEventListener('abort',()=>reject(new Error('Synthetic aborted REST queue')),{once:true}));
      ctx.sent.push(options.body);return {};
    };
    ctx.service.process=async options=>{
      const controller=new AbortController();ctx.service.capture.once('invalidated',()=>controller.abort());
      await options.deliver({content:'Old conversation',files:[{name:'voice.txt',attachment:Buffer.from('private'),description:'raw'}]},
        {signal:controller.signal,epoch:ctx.service.capture.epoch!});
    };
    const pending=ctx.commands.interaction(ctx.interaction('transcript'));await reached;ctx.service.capture.stop();
    await assert.rejects(pending,/aborted REST queue/);assert.equal(ctx.sent.length,0);
  } finally {ctx.close();}
});
