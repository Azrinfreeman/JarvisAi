import { readTranscriptResponse, wav } from './transcription.js';
import { UserError } from '../errors.js';

export function localWav(audio:Buffer) {
  if(audio.length<44 || audio.toString('ascii',0,4)!=='RIFF' || audio.toString('ascii',8,12)!=='WAVE'
    || audio.readUInt16LE(22)!==1 || audio.readUInt32LE(24)!==48000 || audio.readUInt16LE(34)!==16
    || audio.readUInt32LE(40)!==audio.length-44 || (audio.length-44)%2)throw new UserError('Invalid local speech WAV format.');
  const input=audio.subarray(44);const samples=input.length/2;const output=Buffer.alloc(Math.floor(samples/3)*2);
  const radius=24;const cutoff=7200/48000;const coefficients:number[]=[];
  for(let offset=-radius;offset<=radius;offset++) {
    const sinc=offset===0 ? 2*cutoff : Math.sin(2*Math.PI*cutoff*offset)/(Math.PI*offset);
    coefficients.push(sinc*(0.5+0.5*Math.cos(Math.PI*offset/radius)));
  }
  const gain=coefficients.reduce((total,value)=>total+value,0);
  for(let sample=0;sample<output.length/2;sample++) {
    let value=0;
    for(let offset=-radius;offset<=radius;offset++) {
      const index=sample*3+offset;
      if(index>=0 && index<samples)value+=input.readInt16LE(index*2)*coefficients[offset+radius]!/gain;
    }
    output.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(value))),sample*2);
  }
  const result=wav(output,16000);output.fill(0);return result;
}

export function validLocalEndpoint(endpoint:string) {
  try {
    const url=new URL(endpoint);
    return url.protocol==='http:' && url.hostname==='127.0.0.1' && Number(url.port)>=1024 && Number(url.port)<=65535
      && !url.username && !url.password && !url.search && !url.hash && /^\/[a-f\d-]{36}\/inference$/.test(url.pathname);
  } catch {return false;}
}

export async function transcribeLocal(audio:Buffer,settings:{endpoint:string;languages:string[];glossary:string},signal:AbortSignal,request=fetch) {
  if(!validLocalEndpoint(settings.endpoint))throw new UserError('Local speech endpoint was not created by this request.');
  const converted=localWav(audio);
  try {
    const body=new FormData();body.set('file',new Blob([new Uint8Array(converted)],{type:'audio/wav'}),'speech.wav');
    body.set('response_format','json');body.set('language',settings.languages.length===1 ? settings.languages[0]! : 'auto');
    body.set('translate','false');body.set('temperature','0');
    if(settings.glossary)body.set('prompt',settings.glossary);
    const response=await request(settings.endpoint,{method:'POST',body,signal,redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw new UserError('Local transcription failed. Check the local engine and GPU/CPU selection. No API fallback was used.');}
    return await readTranscriptResponse(response);
  } finally {converted.fill(0);}
}
