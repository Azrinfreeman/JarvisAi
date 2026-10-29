import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runtimeArguments, runtimeEntry, stateRoot } from '../app-paths.js';
import { UserError } from '../errors.js';
import type { VoiceConfig } from './config.js';
import type { VoiceSnapshot } from './buffer.js';
import type { VoiceSummaryInput } from './summary.js';
import { LocalSpeechEngine } from './local-engine.js';

export function speechEnvironment(config:VoiceConfig, env=process.env):NodeJS.ProcessEnv {
  const result:NodeJS.ProcessEnv={};
  for (const key of ['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','PATH','Path','RAINBOT_STATE_ROOT','RAINBOT_RESOURCE_ROOT']) if (env[key] !== undefined) result[key]=env[key];
  return {...result,VOICE_SUMMARY_PROVIDER:config.provider,VOICE_SUMMARY_LOCAL_DEVICE:config.localDevice,
    ...(config.provider==='openai'?{VOICE_SUMMARY_API_KEY:config.key}:{}),VOICE_SUMMARY_MODEL:config.model,
    VOICE_SUMMARY_LANGUAGES:config.languages.join(','),VOICE_SUMMARY_GLOSSARY:config.glossary};
}

export async function transcribeSnapshot(snapshot:VoiceSnapshot,config:VoiceConfig,signal:AbortSignal,
  reserve:(seconds:number)=>void,exportAudio=false,root=stateRoot) {
  signal.throwIfAborted();
  const segments:VoiceSummaryInput['segments']=[];
  const audio:Array<{name:string;attachment:Buffer;description:string}>=[];
  if (!snapshot.chunks.length) return {segments,audio};
  const local=config.provider==='local'?new LocalSpeechEngine(root,config.localDevice):undefined;
  if(local)await local.start(signal);
  let child:ChildProcess;
  try {child=fork(runtimeEntry(stateRoot,'src/voice-summary/speech-worker.ts'),[],{
    execArgv:runtimeArguments,env:{...speechEnvironment(config),...(local?{VOICE_SUMMARY_LOCAL_ENDPOINT:local.endpoint}:{})},windowsHide:true,serialization:'advanced',stdio:['ignore','ignore','ignore','ipc'],
  });}catch(error){await local?.close();throw error;}
  type Pending={resolve:()=>void;reject:(error:Error)=>void;prepared:boolean;index:number};
  const pending=new Map<string,Pending>();
  let failure:Error | undefined;
  const fail=(error:Error) => { failure=error; for (const job of pending.values()) job.reject(error); pending.clear(); };
  const abort=()=>fail(new UserError('Voice transcription was cancelled or timed out.'));
  child.on('error',()=>fail(new UserError('Speech worker could not start. Check the bundled runtime.')));
  child.on('exit',()=>fail(new UserError('Speech worker exited. No automatic paid retry was made.')));
  signal.addEventListener('abort',abort,{once:true});
  const send=(message:object) => {
    if (!child.connected) throw new UserError('Speech worker disconnected.');
    child.send(message, error=>{if(error) fail(new UserError('Speech worker disconnected.'));});
  };
  child.on('message',(raw:unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const message=raw as {id?:string;type?:string;seconds?:number;text?:string;error?:string;audio?:Buffer};
    const job=message.id ? pending.get(message.id) : undefined;
    if (!job || signal.aborted) return;
    try {
      if (message.type==='prepared' && !job.prepared) {
        if (!Number.isFinite(message.seconds) || message.seconds!<=0 || message.seconds!>25) throw new UserError('Invalid decoded speech duration.');
        job.prepared=true;
        if(config.provider==='openai')reserve(message.seconds!);
        if (exportAudio) {
          if (!Buffer.isBuffer(message.audio) || message.audio.length>2400044) throw new UserError('Invalid speech review audio.');
          audio.push({name:`voice-test-${job.index+1}.wav`,attachment:message.audio,description:'Explicitly requested short voice test recording'});
        }
        send({type:'submit',id:message.id});
      } else if (message.type==='transcribed' && job.prepared) {
        if (typeof message.text!=='string' || message.text.length>12000) throw new UserError('Invalid speech transcript response.');
        const chunk=snapshot.chunks[job.index]!;
        if (message.text.trim()) segments.push({id:`s${job.index}`,speaker:chunk.speakerId,
          start:Math.max(0,(chunk.start-snapshot.start)/1000),end:Math.min((snapshot.end-snapshot.start)/1000,(chunk.end-snapshot.start)/1000),text:message.text});
        pending.delete(message.id!); job.resolve();
      } else if (message.type==='failed') {
        throw new UserError(typeof message.error==='string' && message.error.length<=600 ? message.error : 'Speech processing failed.');
      }
    } catch(error) { fail(error as Error); }
  });
  if (signal.aborted) abort();
  let next=0;
  const run=async () => {
    while (next<snapshot.chunks.length) {
      signal.throwIfAborted(); if (failure) throw failure;
      const index=next++; const id=randomUUID();
      await new Promise<void>((resolve,reject)=>{
        pending.set(id,{resolve,reject,prepared:false,index});
        try { send({type:'decode',id,chunk:snapshot.chunks[index],exportAudio}); } catch(error) { pending.delete(id);reject(error); }
      });
    }
  };
  try {
    await Promise.all(config.provider==='local'?[run()]:[run(),run()]);
    if (segments.reduce((length,segment)=>length+segment.text.length,0)>60000) throw new UserError('The transcript exceeded the review limit. Use a shorter test.');
    return {segments:segments.sort((first,second)=>first.start-second.start),audio};
  } catch(error) { for (const file of audio) file.attachment.fill(0); throw error; }
  finally {
    signal.removeEventListener('abort',abort);
    fail(new UserError('Speech request ended.'));
    if (child.connected) child.disconnect();
    if (child.exitCode===null && child.signalCode===null) child.kill();
    await local?.close();
  }
}
