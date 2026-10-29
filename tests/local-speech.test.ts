import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { voiceConfig } from '../src/voice-summary/config.js';
import { speechEnvironment } from '../src/voice-summary/speech-client.js';
import { nativeEnvironment, downloadVerified, localReady, LocalSpeechSetup } from '../src/voice-summary/local-setup.js';
import { localWav, transcribeLocal, validLocalEndpoint } from '../src/voice-summary/local-transcription.js';
import { wav } from '../src/voice-summary/transcription.js';
import { voiceNotice } from '../src/voice-summary/discord.js';

const endpoint='http://127.0.0.1:54321/12345678-1234-1234-1234-123456789abc/inference';
function tone(frequency:number) {
  const pcm=Buffer.alloc(4800*2);
  for(let sample=0;sample<4800;sample++)pcm.writeInt16LE(Math.round(Math.sin(2*Math.PI*frequency*sample/48000)*12000),sample*2);
  return wav(pcm);
}
function energy(audio:Buffer) {
  let sum=0;const samples=(audio.length-44)/2;
  for(let index=40;index<samples-40;index++)sum+=audio.readInt16LE(44+index*2)**2;
  return Math.sqrt(sum/Math.max(1,samples-80));
}

test('local is the default and speech/native workers exclude every API credential',()=>{
  const config=voiceConfig({VOICE_SUMMARY_API_KEY:'never-pass-me',OPENAI_API_KEY:'text-secret'});
  assert.equal(config.provider,'local');assert.equal(config.key,'');assert.equal(config.model,'large-v3-q5_0');
  assert.equal(speechEnvironment(config).VOICE_SUMMARY_API_KEY,undefined);
  const native=nativeEnvironment('C:/local-engine',{SystemRoot:'C:/Windows',DISCORD_BOT_TOKEN:'secret',OPENAI_API_KEY:'secret',VOICE_SUMMARY_API_KEY:'secret',NODE_OPTIONS:'--inspect'});
  for(const field of ['DISCORD_BOT_TOKEN','OPENAI_API_KEY','VOICE_SUMMARY_API_KEY','NODE_OPTIONS'])assert.equal(native[field],undefined);
});

test('local WAV resampling preserves speech frequencies and suppresses aliases',()=>{
  const low=localWav(tone(1000)),high=localWav(tone(20000));
  assert.equal(low.readUInt32LE(24),16000);assert.equal(low.readUInt16LE(22),1);assert.equal(low.length,44+1600*2);
  assert.ok(energy(low)>7000);assert.ok(energy(high)<energy(low)*0.02);
  assert.throws(()=>localWav(Buffer.from('not audio')),/Invalid local speech WAV/);
});

test('local transcription accepts only the private loopback route and never sends authorization',async()=>{
  const audio=tone(1000);let calls=0;
  assert.equal(validLocalEndpoint(endpoint),true);
  for(const url of ['https://api.openai.com/v1/audio/transcriptions','http://localhost:54321/inference','http://127.0.0.1:80/'+endpoint.split('/').slice(3).join('/'),endpoint+'?redirect=external',endpoint.replace('127.0.0.1','user@127.0.0.1')])assert.equal(validLocalEndpoint(url),false);
  const text=await transcribeLocal(audio,{endpoint,languages:['ms'],glossary:'Selangor'},new AbortController().signal,async(url,options)=>{
    calls++;assert.equal(url,endpoint);assert.equal(options?.headers,undefined);assert.equal(options?.redirect,'error');
    const form=options?.body as FormData;assert.equal(form.get('language'),'ms');assert.equal(form.get('translate'),'false');
    const bytes=Buffer.from(await (form.get('file') as Blob).arrayBuffer());assert.equal(bytes.readUInt32LE(24),16000);
    return Response.json({text:'Kita jumpa pukul sembilan malam.'});
  });
  assert.equal(calls,1);assert.match(text,/sembilan malam/);
  await assert.rejects(transcribeLocal(audio,{endpoint:'http://example.com/inference',languages:['ms'],glossary:''},new AbortController().signal,async()=>{throw new Error('Must not fetch');}),/endpoint/);
});

test('local engine errors are explicit and do not invoke a cloud fallback',async()=>{
  let calls=0;
  await assert.rejects(transcribeLocal(tone(1000),{endpoint,languages:['ms','en'],glossary:''},new AbortController().signal,
    async()=>{calls++;return new Response('',{status:500});}),/No API fallback/);
  assert.equal(calls,1);
});

test('download verification enforces exact size, checksum and cancellation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'local-download-'));const bytes=Buffer.from('synthetic-model');
  const digest=createHash('sha256').update(bytes).digest('hex');
  try {
    const path=join(root,'model.bin');let progress=0;
    await downloadVerified('https://example.com/model',path,bytes.length,digest,new AbortController().signal,value=>{progress=value;},async()=>new Response(bytes));
    assert.deepEqual(readFileSync(path),bytes);assert.equal(progress,bytes.length);
    await assert.rejects(downloadVerified('https://example.com/model',join(root,'corrupt'),bytes.length,'0'.repeat(64),new AbortController().signal,()=>{},async()=>new Response(bytes)),/checksum/);
    await assert.rejects(downloadVerified('https://example.com/model',join(root,'oversized'),2,digest,new AbortController().signal,()=>{},async()=>new Response(bytes)),/exceeded/);
    const controller=new AbortController();controller.abort();
    await assert.rejects(downloadVerified('https://example.com/model',join(root,'cancelled'),bytes.length,digest,controller.signal,()=>{},async()=>new Response(bytes)));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('checking missing local setup never starts a download and notices describe the selected destination',async()=>{
  const root=mkdtempSync(join(tmpdir(),'local-status-'));
  try {
    assert.equal(await localReady(root),false);assert.equal((await new LocalSpeechSetup(root).status()).state,'missing');
    assert.match(voiceNotice(true),/transcribed locally/);assert.doesNotMatch(voiceNotice(true),/audio is sent to OpenAI/);
    assert.match(voiceNotice(false),/audio is sent to OpenAI/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('an old readiness poll cannot overwrite an active setup and cancellation waits for cleanup',async()=>{
  let release:((ready:boolean)=>void)|undefined;let first=true;let cleaned=false;
  class FakeSetup extends LocalSpeechSetup {
    protected async install(signal:AbortSignal) {
      try {await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true}));}
      finally {await new Promise(resolve=>setTimeout(resolve,5));cleaned=true;}
    }
  }
  const setup=new FakeSetup('unused',async()=>{if(!first)return false;first=false;return new Promise<boolean>(resolve=>{release=resolve;});});
  const stale=setup.status();await setup.begin();release!(false);
  assert.equal((await stale).state,'downloading');assert.equal((await setup.status()).state,'downloading');
  setup.cancel();assert.equal(cleaned,false);await setup.wait();assert.equal(cleaned,true);assert.equal((await setup.status()).state,'failed');
});
