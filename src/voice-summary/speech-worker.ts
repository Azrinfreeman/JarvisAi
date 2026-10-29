import { chunkWav, transcribeAudio } from './transcription.js';
import { voiceConfig } from './config.js';
import { safeError } from '../errors.js';
import type { SpeechChunk } from './buffer.js';
import { transcribeLocal } from './local-transcription.js';

if (!process.send) throw new Error('Speech worker requires local IPC.');
const config=voiceConfig();
const jobs=new Map<string,{audio:Buffer;controller:AbortController;submitted:boolean}>();
const send=(message:unknown) => { if (process.connected) process.send!(message,()=>{}); };
function clear(id:string) { const job=jobs.get(id); job?.controller.abort(); job?.audio.fill(0); jobs.delete(id); }
process.once('disconnect',()=>process.exit(0));
process.once('SIGTERM',()=>process.exit(0));
process.once('exit',()=>{for(const id of jobs.keys()) clear(id);});
process.on('message',(raw:unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const message=raw as {type?:unknown;id?:unknown;chunk?:SpeechChunk;exportAudio?:unknown};
  if (typeof message.id !== 'string' || !/^[a-f\d-]{36}$/.test(message.id)) return;
  const id=message.id;
  if (message.type === 'cancel') { clear(id); return; }
  if (message.type === 'decode') {
    if (jobs.size>=2 || jobs.has(id)) { send({type:'failed',id,error:'Speech worker is busy.'}); return; }
    const chunk=message.chunk;
    if (!chunk || !Number.isFinite(chunk.start) || !Number.isFinite(chunk.end) || chunk.end<chunk.start || chunk.end-chunk.start>25000
      || !Array.isArray(chunk.frames) || !chunk.frames.length || chunk.frames.length>2500
      || chunk.frames.some((frame,index) => !frame || !Buffer.isBuffer(frame.packet) || frame.packet.length<1 || frame.packet.length>8192
        || !Number.isFinite(frame.at) || frame.at<chunk.start || frame.at>chunk.end || index>0 && frame.at<chunk.frames[index-1]!.at)
      || chunk.frames.reduce((bytes,frame)=>bytes+frame.packet.length,0)>4*1024*1024) { send({type:'failed',id,error:'Invalid speech audio chunk.'}); return; }
    try {
      const audio=chunkWav(chunk);
      jobs.set(id,{audio,controller:new AbortController(),submitted:false});
      send({type:'prepared',id,seconds:(audio.length-44)/96000,...(message.exportAudio === true ? {audio} : {})});
    } catch(error) { send({type:'failed',id,error:safeError(error)}); }
    finally { for (const frame of chunk.frames) frame.packet.fill(0); }
  } else if (message.type === 'submit') {
    const job=jobs.get(id); if (!job || job.submitted) return;
    job.submitted=true;
    const signal=AbortSignal.any([job.controller.signal,AbortSignal.timeout(config.provider==='local'?120000:60000)]);
    const inference=config.provider==='local'
      ? transcribeLocal(job.audio,{endpoint:process.env.VOICE_SUMMARY_LOCAL_ENDPOINT||'',languages:config.languages,glossary:config.glossary},signal)
      : transcribeAudio(job.audio,config,signal);
    void inference
      .then(text=>send({type:'transcribed',id,text})).catch(error=>send({type:'failed',id,error:safeError(error)})).finally(()=>clear(id));
  }
});
