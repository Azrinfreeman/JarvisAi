import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { LocalSpeechEngine } from '../src/voice-summary/local-engine.js';
import { transcribeLocal } from '../src/voice-summary/local-transcription.js';
import { wav } from '../src/voice-summary/transcription.js';
import { stateRoot } from '../src/app-paths.js';
import { safeError, UserError } from '../src/errors.js';
import OpusScript from 'opusscript';
import { voiceConfig } from '../src/voice-summary/config.js';
import { transcribeSnapshot } from '../src/voice-summary/speech-client.js';
import { releaseSnapshot, type VoiceSnapshot } from '../src/voice-summary/buffer.js';

const root=process.argv.includes('--desktop')?join(process.env.LOCALAPPDATA!,'RainBot'):stateRoot;
const device=process.argv.includes('--cpu')?'cpu':'vulkan';
const engine=new LocalSpeechEngine(root,device);const started=performance.now();
const pipeline=process.argv.includes('--pipeline');
try {
  const signal=AbortSignal.timeout(180000);if(!pipeline)await engine.start(signal);const loaded=performance.now();
  const response=await fetch('https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav',{signal});
  if(!response.ok)throw new UserError('Could not download the public-domain JFK speech sample.');
  const sample=Buffer.from(await response.arrayBuffer());
  if(sample.readUInt32LE(24)!==16000 || sample.readUInt16LE(22)!==1)throw new UserError('Unexpected smoke audio format.');
  const data=sample.indexOf(Buffer.from('data'));const input=sample.subarray(data+8,data+8+sample.readUInt32LE(data+4));
  const pcm=Buffer.alloc(input.length*3);
  for(let index=0;index<input.length/2;index++)for(let repeat=0;repeat<3;repeat++)pcm.writeInt16LE(input.readInt16LE(index*2),(index*3+repeat)*2);
  let text:string;
  if(pipeline) {
    const codec=new OpusScript(48000,2,OpusScript.Application.VOIP);
    const snapshot:VoiceSnapshot={epoch:'synthetic',start:0,end:pcm.length/96,chunks:[{speakerId:'synthetic',start:0,end:pcm.length/96,frames:[]}]};
    try {
      for(let offset=0;offset<pcm.length;offset+=1920) {
        const stereo=Buffer.alloc(3840);
        for(let sample=0;sample<960 && offset+sample*2<pcm.length;sample++) {
          const value=pcm.readInt16LE(offset+sample*2);stereo.writeInt16LE(value,sample*4);stereo.writeInt16LE(value,sample*4+2);
        }
        snapshot.chunks[0]!.frames.push({at:offset/96,packet:codec.encode(stereo,960)});stereo.fill(0);
      }
      const config=voiceConfig({VOICE_SUMMARY_PROVIDER:'local',VOICE_SUMMARY_LOCAL_DEVICE:device,VOICE_SUMMARY_LANGUAGES:'en'});
      const result=await transcribeSnapshot(snapshot,config,signal,()=>{throw new Error('Local transcription must not reserve API usage.');},false,root);
      text=result.segments.map(segment=>segment.text).join('\n');
    } finally {codec.delete();releaseSnapshot(snapshot);pcm.fill(0);}
  } else {
    const audio=wav(pcm);pcm.fill(0);
    text=await transcribeLocal(audio,{endpoint:engine.endpoint,languages:['en'],glossary:''},signal);audio.fill(0);
  }
  if(!/ask not/i.test(text) || !/country/i.test(text))throw new UserError('Local speech smoke did not recognize the known English sample. Malay accuracy remains untested.');
  const result={passed:true,pipeline,device,model:'large-v3-q5_0',sample:'public-domain JFK English speech; no Discord recording',loadSeconds:pipeline?null:(loaded-started)/1000,
    totalSeconds:(performance.now()-started)/1000,text,noSpeechApiUsed:true};
  await mkdir(join(stateRoot,'output/local-speech'),{recursive:true});
  await writeFile(join(stateRoot,`output/local-speech/${pipeline?'pipeline-':''}smoke.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch(error) {console.error(safeError(error));process.exitCode=1;}
finally {await engine.close();}
