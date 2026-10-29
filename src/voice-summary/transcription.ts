import OpusScript from 'opusscript';
import { UserError } from '../errors.js';
import type { SpeechChunk } from './buffer.js';

export function chunkWav(chunk:SpeechChunk):Buffer {
  const decoder=new OpusScript(48000,2,OpusScript.Application.VOIP);
  const maxSamples=25*48000;
  const cutoff=Math.min(maxSamples,Math.max(0,Math.round((chunk.end-chunk.start)*48)));
  const pcm=Buffer.alloc(maxSamples*2);
  let sampleEnd=0;
  try {
    for (const frame of chunk.frames) {
      let decoded:Buffer;
      try { decoded=decoder.decode(frame.packet); } catch { throw new UserError('A voice packet could not be decoded. No complete transcript was produced.'); }
      const offset=Math.max(sampleEnd,Math.round((frame.at-chunk.start)*48));
      const samples=decoded.length/4;
      if (!Number.isInteger(samples) || samples < 1 || samples > 5760 || offset+samples > maxSamples) throw new UserError('Invalid voice timing or audio length. No complete transcript was produced.');
      const allowed=Math.max(0,Math.min(samples,cutoff-offset));
      for (let sample=0;sample<allowed;sample++) pcm.writeInt16LE(Math.round((decoded.readInt16LE(sample*4)+decoded.readInt16LE(sample*4+2))/2),(offset+sample)*2);
      sampleEnd=Math.min(cutoff,offset+samples);
    }
    if (!sampleEnd) throw new UserError('No speech audio was available.');
    return wav(pcm.subarray(0,sampleEnd*2));
  } finally { decoder.delete(); pcm.fill(0); }
}

export function wav(pcm:Buffer,sampleRate=48000) {
  const header=Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36+pcm.length,4); header.write('WAVE',8); header.write('fmt ',12);
  header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22); header.writeUInt32LE(sampleRate,24);
  header.writeUInt32LE(sampleRate*2,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34);
  header.write('data',36); header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

export async function transcribeAudio(audio:Buffer, settings:{key:string;model:string;languages:string[];glossary:string}, signal:AbortSignal, request=fetch) {
  if (!settings.key) throw new UserError('Add the protected voice-summary API key in Settings first.');
  if (audio.length > 25*1024*1024) throw new UserError('Transcription audio exceeds the upload limit.');
  const body=new FormData(); body.set('file',new Blob([new Uint8Array(audio)],{type:'audio/wav'}),'speech.wav');
  body.set('model',settings.model); body.set('response_format','json');
  for (const language of settings.languages) body.append('languages[]',language);
  if (settings.glossary) body.set('prompt',`Malay conversation, possibly mixed with English. Relevant names and terms: ${settings.glossary}`);
  const response=await request('https://api.openai.com/v1/audio/transcriptions',{
    method:'POST',headers:{Authorization:`Bearer ${settings.key}`},body,signal,redirect:'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new UserError(response.status === 429 ? 'Speech API quota or rate limit reached. No automatic retry was made.'
      : [401,403].includes(response.status) ? 'Speech API credentials were not authorized. Check the voice-summary key.'
      : [400,404].includes(response.status) ? 'Speech model, language hints or audio options were rejected. Check voice-summary settings.'
      : 'Speech transcription failed. No automatic paid retry or provider fallback was made.');
  }
  return readTranscriptResponse(response);
}

export async function readTranscriptResponse(response:Response) {
  if (!response.body) throw new UserError('Speech engine returned no response.');
  let bytes=0; const parts:Uint8Array[]=[];
  for await (const part of response.body) { bytes+=part.length; if (bytes>128000) throw new UserError('Speech API response exceeded the limit.'); parts.push(part); }
  let result:unknown;
  try { result=JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new UserError('Speech API returned invalid JSON.'); }
  const text=(result as {text?:unknown})?.text;
  if (typeof text !== 'string' || text.length>12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new UserError('Speech API returned an invalid transcript.');
  return text.trim();
}
