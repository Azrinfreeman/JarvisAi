import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import OpusScript from 'opusscript';
import type { VoiceConnection } from '@discordjs/voice';
import { VoiceBuffer, releaseSnapshot, type VoiceSnapshot } from '../src/voice-summary/buffer.js';
import { VoiceCapture } from '../src/voice-summary/capture.js';
import { chunkWav, transcribeAudio } from '../src/voice-summary/transcription.js';
import { voiceConfig } from '../src/voice-summary/config.js';
import { VoiceUsage } from '../src/voice-summary/usage.js';
import { VoiceSummaryService, voiceIntent, summarySegments } from '../src/voice-summary/service.js';
import { speechEnvironment, transcribeSnapshot } from '../src/voice-summary/speech-client.js';

const user='123456789012345678';
function connection() {
  const streams=new Map<string,PassThrough>();
  const value=Object.assign(new EventEmitter(),{state:{status:'ready'},joinConfig:{guildId:'guild',channelId:'voice',selfDeaf:true,selfMute:false},
    receiver:{subscribe:(id:string)=>{const stream=new PassThrough();streams.set(id,stream);return stream;}},
    rejoin:(config:{selfDeaf:boolean})=>{value.joinConfig.selfDeaf=config.selfDeaf;return true;}});
  return {value:value as unknown as VoiceConnection,streams};
}
function audioPacket() {
  const codec=new OpusScript(48000,2,OpusScript.Application.VOIP);
  const pcm=Buffer.alloc(3840);
  for(let sample=0;sample<960;sample++) {
    const amplitude=Math.round(Math.sin(sample*0.05)*8000);
    pcm.writeInt16LE(amplitude,sample*4);pcm.writeInt16LE(amplitude,sample*4+2);
  }
  try {return codec.encode(pcm,960);} finally {codec.delete();}
}

test('voice buffer enforces exact cutoff, epoch, coverage and bounded event headroom',()=>{
  const buffer=new VoiceBuffer(0);
  buffer.add(user,Buffer.from([1]),1000);buffer.add(user,Buffer.from([2]),299990);buffer.add(user,Buffer.from([3]),300050);
  assert.throws(()=>buffer.snapshot(300,200000,300100),/full requested window/);
  const snapshot=buffer.snapshot(300,300000,300100);
  assert.equal(snapshot.epoch,buffer.epoch);assert.equal(snapshot.start,0);
  assert.deepEqual(snapshot.chunks.flatMap(chunk=>chunk.frames.map(frame=>frame.packet[0])),[1,2]);
  buffer.clear();assert.equal(snapshot.chunks[0]!.frames[0]!.packet[0],1);
  const held=snapshot.chunks[0]!.frames[0]!.packet;releaseSnapshot(snapshot);assert.ok(held.every(byte=>byte===0));
});

test('voice buffer prunes silent periods, rejects capacity and keeps separate overlapping speakers',()=>{
  const buffer=new VoiceBuffer(0,3);
  buffer.add('first',Buffer.from([1]),100);buffer.add('second',Buffer.from([2]),100);
  assert.throws(()=>buffer.add('first',Buffer.from([3,4]),101),/capacity/);
  const snapshot=buffer.snapshot(10,10100,10100);assert.equal(snapshot.chunks.length,2);releaseSnapshot(snapshot);
  buffer.prune(306000);assert.equal(buffer.snapshot(10,306000,306000).chunks.length,0);
  assert.throws(()=>buffer.prune(0),/clock changed/);
});

test('capture requires every consent, receives active speakers, and invalidates membership changes',async()=>{
  let now=0;const capture=new VoiceCapture(()=>now);const fake=connection();let invalidated=0;
  capture.on('invalidated',()=>invalidated++);
  try {
    capture.start('guild','voice',[user,'second'],fake.value);
    assert.equal(fake.streams.size,0);assert.equal(fake.value.joinConfig.selfDeaf,true);
    await capture.accept(user);assert.equal(fake.streams.size,0);
    await capture.accept('second');assert.equal(capture.state,'listening');assert.equal(fake.value.joinConfig.selfDeaf,false);
    now=1000;fake.streams.get(user)!.write(Buffer.from([1]));
    now=11000;const snapshot=capture.snapshot(10);assert.equal(snapshot.chunks.length,1);releaseSnapshot(snapshot);
    capture.membership([user,'second','new']);assert.equal(capture.state,'waiting');assert.equal(capture.coverageSeconds,0);
    assert.equal(capture.pending.length,3);assert.equal(fake.value.joinConfig.selfDeaf,true);assert.ok(invalidated>0);
    assert.throws(()=>capture.snapshot(10),/not active/);
  } finally {capture.stop();}
});

test('capture disconnect and receive errors fail closed without automatic restart',async()=>{
  const capture=new VoiceCapture(()=>1000);const fake=connection();
  try {
    capture.start('guild','voice',[user],fake.value);await capture.accept(user);
    fake.streams.get(user)!.emit('error',new Error('Synthetic receive failure'));
    assert.equal(capture.state,'paused');assert.equal(capture.epoch,undefined);
    await assert.rejects(capture.accept(user),/new listening session/);
    capture.stop();capture.start('guild','voice',[user],fake.value);await capture.accept(user);
    (fake.value as unknown as {state:{status:string}}).state.status='disconnected';
    fake.value.emit('stateChange');assert.equal(capture.state,'paused');
    assert.equal(fake.value.joinConfig.selfDeaf,true);
  } finally {capture.stop();}
});

test('server consent preserves coverage, departed speech and names across joins, leaves and empty intervals',async()=>{
  let now=0;const capture=new VoiceCapture(()=>now);const fake=connection();
  try {
    capture.start('guild','voice',[user,'second'],fake.value,false,'server');
    assert.equal(fake.streams.size,0);
    await capture.acceptServerConsent();
    assert.equal(capture.state,'listening');assert.equal(capture.pending.length,0);
    now=1000;fake.streams.get(user)!.write(Buffer.from([1]));now=11000;
    const snapshot=capture.snapshot(10);assert.equal(snapshot.chunks.length,1);releaseSnapshot(snapshot);
    capture.rememberNames(new Map([[user,'Ali'],['second','Siti']]));
    const epoch=capture.epoch,revision=capture.consentRevision;
    const departed=fake.streams.get(user)!;
    capture.membership([user,'second','new']);
    assert.equal(capture.state,'listening');assert.equal(capture.epoch,epoch);
    assert.equal(capture.coverageSeconds,11);assert.equal(fake.value.joinConfig.selfDeaf,false);
    assert.equal(capture.consentRevision,revision);assert.equal(capture.pending.length,0);
    now=11001;fake.streams.get('new')!.write(Buffer.from([2]));
    capture.membership(['new']);assert.equal(departed.destroyed,true);
    departed.emit('data',Buffer.from([9]));departed.emit('error',new Error('Late intentional destruction'));departed.emit('end');
    assert.equal(capture.state,'listening');assert.equal(capture.speakerNames.get(user),'Ali');
    now=12000;const retained=capture.snapshot(12);
    assert.deepEqual(retained.chunks.flatMap(chunk=>chunk.frames.map(frame=>frame.packet[0])),[1,2]);releaseSnapshot(retained);
    capture.membership([]);assert.equal(capture.state,'listening');assert.equal(capture.participants,0);
    capture.membership(['new']);assert.notEqual(fake.streams.get('new')!.destroyed,true);
    now=318000;const expired=capture.snapshot(10);assert.equal(expired.chunks.length,0);releaseSnapshot(expired);
    capture.rememberNames(new Map());assert.equal(capture.speakerNames.has(user),false);
    await assert.rejects(capture.acceptServerConsent(),/new announced/);
    capture.membership(Array.from({length:11},(_,i)=>String(i)));
    assert.equal(capture.state,'paused');assert.equal(capture.epoch,undefined);
    capture.membership(['new']);assert.equal(capture.state,'paused');
    await assert.rejects(capture.accept('new'),/new listening session/);
    capture.stop();
    await assert.rejects(capture.acceptServerConsent(),/new announced/);
    capture.start('guild','voice',[user],fake.value);
    await assert.rejects(capture.acceptServerConsent(),/new announced/);
    assert.equal(capture.state,'waiting');assert.equal(capture.pending.length,1);
  } finally {capture.stop();}
});

test('server-consent readiness reconciles latest members but cannot resume after withdrawal or overflow',async()=>{
  for(const change of ['stop','membership','empty','overflow'] as const) {
    let release!:()=>void;const fake=connection();
    const capture=new VoiceCapture(()=>0,async()=>{await new Promise<void>(resolve=>{release=resolve;});return fake.value;});
    try {
      capture.start('guild','voice',[user],fake.value,false,'server');
      const pending=capture.acceptServerConsent();
      if(change==='stop')capture.stop();
      else capture.membership(change==='membership'?['new']:change==='empty'?[]:Array.from({length:11},(_,i)=>String(i)));
      release();
      if(change==='stop' || change==='overflow') {
        await assert.rejects(pending,/session changed/);
        assert.equal(capture.state,change==='stop'?'off':'paused');assert.equal(capture.epoch,undefined);
        assert.equal(fake.streams.size,0);assert.equal(fake.value.joinConfig.selfDeaf,true);
      } else {
        await pending;assert.equal(capture.state,'listening');assert.equal(capture.pending.length,0);
        assert.deepEqual([...fake.streams.keys()],change==='empty'?[]:['new']);
      }
    } finally {capture.stop();}
  }
});

test('voice packet object limits reject tiny packet floods before byte capacity is reached',()=>{
  const buffer=new VoiceBuffer(0,1024,3,2);
  buffer.add('first',Buffer.from([1]),100);buffer.add('first',Buffer.from([1]),101);
  assert.throws(()=>buffer.add('first',Buffer.from([1]),102),/packet capacity/);
  buffer.add('second',Buffer.from([1]),102);
  assert.throws(()=>buffer.add('third',Buffer.from([1]),103),/packet capacity/);
  buffer.prune(306000);buffer.add('first',Buffer.from([1]),306000);buffer.clear();
});

test('rapid rejoining waits for the receiver to release a destroyed cached stream',async()=>{
  const fake=connection(),subscriptions=new Map<string,PassThrough>();
  fake.value.receiver.subscribe=((id:string)=>{
    const existing=subscriptions.get(id);if(existing)return existing;
    const stream=new PassThrough();subscriptions.set(id,stream);
    stream.once('close',()=>subscriptions.delete(id));return stream;
  }) as unknown as typeof fake.value.receiver.subscribe;
  const capture=new VoiceCapture(()=>11000);
  try {
    capture.start('guild','voice',[user],fake.value,false,'server');await capture.acceptServerConsent();
    const old=subscriptions.get(user)!;
    capture.membership([]);capture.membership([user]);capture.membership([]);capture.membership([user]);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(old.destroyed,true);assert.notEqual(subscriptions.get(user),old);
    assert.equal(subscriptions.get(user)!.destroyed,false);assert.equal(capture.state,'listening');
    capture.membership([]);capture.membership([user]);capture.stop();
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(subscriptions.size,0);assert.equal(capture.state,'off');
  } finally {capture.stop();}
});

test('server membership changes preserve an immutable request through transcription and summarization',async()=>{
  for(const stage of ['transcribe','summarize'] as const) {
    const directory=mkdtempSync(join(tmpdir(),'voice-continuity-'));let now=0;
    const capture=new VoiceCapture(()=>now),fake=connection();
    let reached!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{reached=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let delivered=0;
    const service=new VoiceSummaryService(directory,voiceConfig({VOICE_SUMMARY_ENABLED:'true'}),{
      transcribe:async(snapshot)=>{
        if(stage==='transcribe'){reached();await gate;}
        assert.deepEqual(snapshot.chunks.map(chunk=>chunk.speakerId),[user]);
        return {segments:[{id:'s0',speaker:user,start:0,end:1,text:'Meet at nine.'}],audio:[]};
      },
      summarize:async(input)=>{assert.match(input.segments[0]!.speaker,/Ali/);if(stage==='summarize'){reached();await gate;}return 'Meeting at nine.';},
    },capture);
    try {
      capture.start('guild','voice',[user],fake.value,false,'server');await capture.acceptServerConsent();
      now=1000;fake.streams.get(user)!.write(Buffer.from([1]));now=11000;
      const pending=service.process({seconds:10,ageMs:0,requester:user,test:false,transcript:false,audio:false,
        names:new Map([[user,'Ali']]),guard:async()=>{},deliver:async(result)=>{assert.match(result.content,/Meeting at nine/);delivered++;}});
      await started;capture.membership(['new']);fake.streams.get('new')!.write(Buffer.from([2]));
      release();await pending;assert.equal(delivered,1);assert.equal(capture.state,'listening');
    } finally {release();service.close();rmSync(directory,{recursive:true,force:true});}
  }
});

test('continuous speech chunks retain 200 ms overlap and summary deduplication preserves raw recognition',()=>{
  const buffer=new VoiceBuffer(0);
  for(let at=0;at<26000;at+=20)buffer.add(user,Buffer.from([1]),at);
  const snapshot=buffer.snapshot(30,30000,30000);
  assert.equal(snapshot.chunks.length,2);
  assert.ok(snapshot.chunks[1]!.start<snapshot.chunks[0]!.end);
  const segments=[{id:'s0',speaker:'Ali',start:0,end:25,text:'Kita jumpa esok pukul sembilan malam'},
    {id:'s1',speaker:'Ali',start:24.3,end:30,text:'pukul sembilan malam bukan pagi'}];
  assert.equal(summarySegments(segments)[1]!.text,'bukan pagi');
  assert.equal(segments[1]!.text,'pukul sembilan malam bukan pagi');
  assert.equal(summarySegments([{...segments[0]!}, {...segments[1]!,start:26}])[1]!.text,segments[1]!.text);
  releaseSnapshot(snapshot);buffer.clear();
});

test('capture rejects consent belonging to an older announcement or session revision',async()=>{
  const capture=new VoiceCapture(()=>1000);const fake=connection();
  try {
    capture.start('guild','voice',[user],fake.value);const revision=capture.consentRevision;
    await assert.rejects(capture.accept(user,revision,capture.announcedAt-1),/notice changed/);
    capture.stop();capture.start('guild','voice',[user],fake.value,true);
    await assert.rejects(capture.accept(user,revision,Date.now()),/notice changed/);
    assert.equal(capture.state,'waiting');assert.equal(fake.streams.size,0);
  } finally {capture.stop();}
});

test('failed reception readiness clears consent and restores deafening',async()=>{
  const fake=connection();const capture=new VoiceCapture(()=>0,async()=>{throw new Error('Synthetic readiness timeout');});
  try {
    capture.start('guild','voice',[user],fake.value);
    await assert.rejects(capture.accept(user),/readiness timeout/);
    assert.equal(capture.state,'paused');assert.equal(capture.pending.length,1);assert.equal(fake.value.joinConfig.selfDeaf,true);
  } finally {capture.stop();}
});

test('disconnect while waiting invalidates earlier participant consent',async()=>{
  const fake=connection();const capture=new VoiceCapture(()=>0);
  try {
    capture.start('guild','voice',[user,'second'],fake.value);await capture.accept(user);
    assert.equal(capture.pending.length,1);
    (fake.value as unknown as {state:{status:string}}).state.status='disconnected';fake.value.emit('stateChange');
    assert.equal(capture.state,'paused');assert.equal(capture.pending.length,2);
    (fake.value as unknown as {state:{status:string}}).state.status='ready';fake.value.emit('stateChange');
    await assert.rejects(capture.accept('second'),/new listening session/);assert.equal(fake.streams.size,0);
  } finally {capture.stop();}
});

test('WAV encoding trims audio exactly at the requested cutoff',()=>{
  const result=chunkWav({speakerId:user,start:0,end:10,frames:[{at:0,packet:audioPacket()}]});
  assert.equal(result.length,44+10*96);
});

test('voice intents are bounded and do not turn ordinary text summaries into recording actions',()=>{
  assert.deepEqual(voiceIntent('ringkaskan perbualan voice 5 minit tadi'),{action:'summarize',seconds:300});
  assert.deepEqual(voiceIntent('summarize the last 4 minutes of voice chat'),{action:'summarize',seconds:240});
  assert.deepEqual(voiceIntent('tunjuk transkrip voice 5 minit tadi'),{action:'transcript',seconds:300});
  for(const prompt of ['summarize this','start recording','summarize last 60 minutes of voice','ringkaskan voice 5 minit tadi and rename @Ali','if I ask summarize voice'])assert.equal(voiceIntent(prompt),undefined);
});

test('actual Opus decoding produces bounded mono WAV with preserved silence offsets',()=>{
  const packet=audioPacket();const result=chunkWav({speakerId:user,start:0,end:1020,frames:[{at:0,packet},{at:1000,packet}]});
  assert.equal(result.subarray(0,4).toString(),'RIFF');assert.equal(result.readUInt16LE(22),1);assert.equal(result.readUInt32LE(24),48000);
  assert.equal(result.length,44+1020*96);assert.ok(result.subarray(44,44+1920).some(byte=>byte!==0));
  assert.ok(result.subarray(44+1920,44+96000).every(byte=>byte===0));
});

test('speech adapter sends explicit API audio and language hints without paid retry or fallback',async()=>{
  let calls=0;
  const audio=chunkWav({speakerId:user,start:0,end:20,frames:[{at:0,packet:audioPacket()}]});
  const settings={key:'synthetic-speech-key',model:'gpt-transcribe',languages:['ms','en'],glossary:'Sabah, Azrin'};
  const result=await transcribeAudio(audio,settings,new AbortController().signal,async(url,options)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');
    assert.deepEqual(options?.headers,{Authorization:'Bearer synthetic-speech-key'});
    const form=options?.body as FormData;assert.equal(form.get('model'),'gpt-transcribe');assert.deepEqual(form.getAll('languages[]'),['ms','en']);
    assert.ok(form.get('file') instanceof Blob);return Response.json({text:'Bah, bukan esok pagi.'});
  });
  assert.equal(result,'Bah, bukan esok pagi.');assert.equal(calls,1);
  await assert.rejects(transcribeAudio(audio,settings,new AbortController().signal,async()=>{calls++;return new Response('private details',{status:429});}),/No automatic retry/);
  assert.equal(calls,2);
  await assert.rejects(transcribeAudio(audio,settings,new AbortController().signal,async()=>Response.json({text:123})),/invalid transcript/);
});

test('speech worker environment excludes Discord, text provider grants and unrelated secrets',()=>{
  const env=speechEnvironment(voiceConfig({VOICE_SUMMARY_PROVIDER:'openai',VOICE_SUMMARY_API_KEY:'synthetic-speech'}),{
    DISCORD_BOT_TOKEN:'secret',OPENAI_API_KEY:'text-secret',CHATGPT_MODEL:'text-model',OTHER_SECRET:'other',NODE_OPTIONS:'--inspect',SystemRoot:'C:/Windows',
  });
  assert.equal(env.VOICE_SUMMARY_API_KEY,'synthetic-speech');assert.equal(env.SystemRoot,'C:/Windows');
  for(const key of ['DISCORD_BOT_TOKEN','OPENAI_API_KEY','CHATGPT_MODEL','OTHER_SECRET','NODE_OPTIONS'])assert.equal(env[key],undefined);
});

test('speech worker decodes locally and waits for budget approval before any API submission',async()=>{
  const child=fork(new URL('../src/voice-summary/speech-worker.ts',import.meta.url),[],{execArgv:['--import','tsx'],
    env:speechEnvironment(voiceConfig({VOICE_SUMMARY_PROVIDER:'openai',VOICE_SUMMARY_API_KEY:'synthetic-not-a-real-key'})),serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});
  try {
    const id=randomUUID();const result=new Promise<Record<string,unknown>>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Worker decode timed out')),10000);
      child.once('error',reject);child.once('message',message=>{clearTimeout(timer);resolve(message as Record<string,unknown>);});
    });
    child.send({type:'decode',id,exportAudio:true,chunk:{speakerId:user,start:0,end:20,frames:[{at:0,packet:audioPacket()}]}});
    const prepared=await result;assert.equal(prepared.type,'prepared');assert.equal(prepared.id,id);assert.equal(prepared.seconds,0.02);
    assert.ok(Buffer.isBuffer(prepared.audio));child.send({type:'cancel',id});
  } finally {const exited=once(child,'exit');child.kill();await exited;}
});

test('speech client refuses a decoded chunk when its local budget reservation fails',async()=>{
  const snapshot:VoiceSnapshot={epoch:'epoch',start:0,end:1000,chunks:[{speakerId:user,start:0,end:20,frames:[{at:0,packet:audioPacket()}]}]};
  await assert.rejects(transcribeSnapshot(snapshot,voiceConfig({VOICE_SUMMARY_PROVIDER:'openai',VOICE_SUMMARY_API_KEY:'synthetic'}),AbortSignal.timeout(10000),()=>{throw new Error('Synthetic budget rejection');}),/budget rejection/);
  releaseSnapshot(snapshot);
});

test('monthly usage reserves conservatively, persists without transcript and rolls over',()=>{
  const directory=mkdtempSync(join(tmpdir(),'voice-usage-'));const path=join(directory,'usage.sqlite');
  let date=new Date('2026-10-28T00:00:00Z');const usage=new VoiceUsage(path,60,()=>date);
  try {
    usage.reserve(30.1);assert.equal(usage.seconds,31);assert.throws(()=>usage.reserve(30),/allowance/);
    usage.reserve(29);assert.equal(usage.seconds,60);date=new Date('2026-11-01T00:00:00Z');assert.equal(usage.seconds,0);usage.reserve(1);
  } finally {usage.close();}
  const reopened=new VoiceUsage(path,60,()=>date);assert.equal(reopened.seconds,1);reopened.close();rmSync(directory,{recursive:true,force:true});
});

test('voice service delivers raw transcript without history and invalidates a late result after withdrawal',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'voice-service-'));let now=0;const capture=new VoiceCapture(()=>now);const fake=connection();
  let started:()=>void=()=>{};let finish:()=>void=()=>{};let delay=false;let summaries=0;let delivered=0;
  const config=voiceConfig({VOICE_SUMMARY_PROVIDER:'openai',VOICE_SUMMARY_ENABLED:'true',VOICE_SUMMARY_API_KEY:'synthetic'});
  const service=new VoiceSummaryService(directory,config,{summarize:async()=>{summaries++;return 'Summary';},transcribe:async(_snapshot,_config,signal,reserve)=>{
    reserve(1);started();if(delay)await new Promise<void>(resolve=>{finish=resolve;});
    return {segments:[{id:'s0',speaker:user,start:0,end:1,text:'Sembilan malam, bukan pagi.'}],audio:[]};
  }},capture);
  try {
    capture.start('guild','voice',[user],fake.value);await capture.accept(user);now=1000;fake.streams.get(user)!.write(Buffer.from([1]));now=11000;
    const options={seconds:10,ageMs:0,requester:user,test:true,transcript:true,audio:false,names:new Map([[user,'Ali']]),guard:async()=>{},
      deliver:async(result:{content:string})=>{delivered++;assert.match(result.content,/bukan pagi/);}};
    await service.process(options);assert.equal(summaries,0);assert.equal(delivered,1);
    assert.doesNotMatch(readFileSync(join(directory,'data/voice-summary-status.json'),'utf8'),/bukan pagi/);
    delay=true;const pendingStarted=new Promise<void>(resolve=>{started=resolve;});
    const pending=service.process({...options,requester:'second'});await pendingStarted;capture.stop();finish();
    await assert.rejects(pending,/cancel|abort/i);assert.equal(delivered,1);
  } finally {service.close();rmSync(directory,{recursive:true,force:true});}
});
