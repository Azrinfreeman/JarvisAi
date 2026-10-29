import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { VoiceCapture } from './capture.js';
import { releaseSnapshot, type VoiceSnapshot } from './buffer.js';
import { transcribeSnapshot } from './speech-client.js';
import { VoiceUsage } from './usage.js';
import type { VoiceConfig } from './config.js';
import type { VoiceSummaryInput } from './summary.js';
import { UserError } from '../errors.js';

export type VoiceResult={content:string;files?:Array<{name:string;attachment:Buffer;description:string}>};
type Dependencies={transcribe:typeof transcribeSnapshot;summarize:(input:VoiceSummaryInput,signal:AbortSignal)=>Promise<string>};

export function voiceIntent(prompt:string,minutes=5):{action:'summarize'|'transcript';seconds:number}|undefined {
  const text=prompt.trim().toLowerCase().replace(/[.!?]+$/,'');
  const match=/^(?:please\s+|tolong\s+)?(summari[sz]e|ringkaskan|ringkasan|transcript|transkrip|tunjuk transkrip)\s+(?:the\s+)?(?:(?:last|past)\s+([45])\s+minutes?\s+(?:of\s+)?)?(?:voice(?:\s+(?:chat|conversation))?|perbualan\s+voice)(?:\s+(?:for\s+)?(?:the\s+)?(?:last|past)\s+([45])\s+minutes?|\s+([45])\s+minit\s+tadi)?$/.exec(text);
  if (!match) return;
  return {action:/trans/.test(match[1]!) ? 'transcript' : 'summarize',seconds:Number(match[2]??match[3]??match[4]??minutes)*60};
}

export function transcriptText(input:VoiceSummaryInput) {
  return input.segments.map(segment=>`[${segment.id} ${segment.start.toFixed(1)}–${segment.end.toFixed(1)}s] ${segment.speaker}: ${segment.text}`).join('\n');
}

export function summarySegments(segments:VoiceSummaryInput['segments']) {
  const previous=new Map<string,VoiceSummaryInput['segments'][number]>();
  return segments.flatMap(segment=>{
    const last=previous.get(segment.speaker);previous.set(segment.speaker,segment);
    if(!last || last.end<=segment.start)return [{...segment}];
    const earlier=last.text.trim().split(/\s+/),current=segment.text.trim().split(/\s+/);
    const normalized=(text:string)=>text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}']/gu,'');
    for(let count=Math.min(20,earlier.length,current.length);count>=3;count--) {
      if(earlier.slice(-count).every((word,index)=>normalized(word)===normalized(current[index]!))) {
        const text=current.slice(count).join(' ');return text ? [{...segment,text}] : [];
      }
    }
    return [{...segment}];
  });
}

export class VoiceSummaryService {
  readonly capture:VoiceCapture;
  private usage?:VoiceUsage;
  private job?:AbortController;
  private cooldown=new Map<string,number>();
  private cache=new Map<string,{at:number;text:string}>();
  private timer:ReturnType<typeof setInterval>;
  private closed=false;
  private disposed=false;
  private publishing=false;
  constructor(readonly root:string,readonly config:VoiceConfig,private deps:Dependencies,capture=new VoiceCapture()) {
    this.capture=capture;
    capture.on('invalidated',()=>{this.job?.abort();this.cache.clear();});
    capture.on('changed',()=>this.publish());
    this.timer=setInterval(()=>this.publish(),5000);this.timer.unref();this.publish();
  }
  private ledger() { return this.usage ??= new VoiceUsage(join(this.root,'data/voice-summary/usage.sqlite'),this.config.monthlyMinutes*60); }
  status() {
    return {updatedAt:new Date().toISOString(),state:this.job ? 'processing' : this.capture.state,
      channelId:this.capture.channelId,coverageSeconds:this.capture.coverageSeconds,participants:this.capture.participants,
      model:this.config.model,message:this.capture.message,usageSeconds:this.usage?.seconds ?? 0};
  }
  private publish() {
    if (this.disposed || this.publishing) return;
    this.publishing=true;
    for(const [key,entry] of this.cache)if(entry.at<Date.now()-305000)this.cache.delete(key);
    try {
      const directory=join(this.root,'data');mkdirSync(directory,{recursive:true});
      const path=join(directory,'voice-summary-status.json');
      writeFileSync(path+'.tmp',JSON.stringify(this.status()),{mode:0o600});renameSync(path+'.tmp',path);
    } catch { this.capture.pause('Voice status could not be saved. Check local data access before starting a new session.'); }
    finally { this.publishing=false; }
  }
  async process(options:{seconds:number;ageMs:number;requester:string;test:boolean;transcript:boolean;audio:boolean;
    names:Map<string,string>;guard:()=>Promise<void>;deliver:(result:VoiceResult,context:{signal:AbortSignal;epoch:string})=>Promise<void>}) {
    if (this.closed) throw new UserError('The bot is shutting down.');
    if (!this.config.enabled || this.config.provider==='openai' && !this.config.key) throw new UserError('Enable voice summaries in Settings; cloud transcription also requires the separate speech API key. Restart after saving.');
    if (this.job) throw new UserError('A voice-summary request is already processing in this channel.');
    if (Date.now()-(this.cooldown.get(options.requester)??0)<30000) throw new UserError('Wait 30 seconds before another voice request.');
    if (options.audio && (!options.test || !this.capture.exportAudio)) throw new UserError('Audio review exports were not enabled when participants consented. Start a session with allow-test-audio enabled first.');
    const snapshot=this.capture.snapshot(options.seconds,options.ageMs);
    const controller=new AbortController();this.job=controller;this.cooldown.set(options.requester,Date.now());this.publish();
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(this.config.provider==='local'?600000:120000)]);
    const assertCurrent=async()=>{
      signal.throwIfAborted();
      if (snapshot.epoch!==this.capture.epoch) throw new UserError('The listening session changed. No result was posted.');
      await options.guard();signal.throwIfAborted();
      if(snapshot.epoch!==this.capture.epoch)throw new UserError('The listening session changed. No result was posted.');
    };
    const audio:NonNullable<VoiceResult['files']>=[];
    try {
      await assertCurrent();
      const segments:VoiceSummaryInput['segments']=[];
      const now=Date.now();
      for (const [key,entry] of this.cache) if (entry.at<now-300000) this.cache.delete(key);
      const missing:Array<{index:number;key:string}>=[];
      const recognized=new Map<number,string>();
      for (let index=0;index<snapshot.chunks.length;index++) {
        const chunk=snapshot.chunks[index]!;
        const digest=createHash('sha256').update(snapshot.epoch).update(chunk.speakerId).update(this.config.model).update(this.config.languages.join(',')).update(this.config.glossary);
        for(const frame of chunk.frames)digest.update(String(frame.at)).update(frame.packet);
        const key=digest.digest('hex');const cached=options.test ? undefined : this.cache.get(key);
        if(cached)recognized.set(index,cached.text);else missing.push({index,key});
      }
      if(missing.length) {
        const part:VoiceSnapshot={...snapshot,chunks:missing.map(entry=>snapshot.chunks[entry.index]!)};
        const result=await this.deps.transcribe(part,this.config,signal,seconds=>this.ledger().reserve(seconds),options.audio,this.root);
        audio.push(...result.audio);signal.throwIfAborted();
        for(let partIndex=0;partIndex<missing.length;partIndex++) {
          const entry=missing[partIndex]!;
          const text=result.segments.find(segment=>segment.id===`s${partIndex}`)?.text ?? '';
          recognized.set(entry.index,text);
          if(!options.test) {
            this.cache.set(entry.key,{at:Date.now()-performance.now()+snapshot.chunks[entry.index]!.end,text});
            while(this.cache.size>400 || [...this.cache.values()].reduce((size,value)=>size+value.text.length,0)>120000)this.cache.delete(this.cache.keys().next().value!);
          }
        }
      }
      for(let index=0;index<snapshot.chunks.length;index++) {
        const chunk=snapshot.chunks[index]!;const text=recognized.get(index);
        if (text) segments.push({id:`s${index}`,speaker:`${options.names.get(chunk.speakerId)??'Unknown participant'} [${chunk.speakerId}]`,
          start:Math.max(0,(chunk.start-snapshot.start)/1000),end:Math.min(options.seconds,(chunk.end-snapshot.start)/1000),text});
        if(segments.reduce((size,segment)=>size+segment.text.length,0)>60000)throw new UserError('Transcript is too long. Try a shorter test.');
      }
      await assertCurrent();
      const input={segments,language:this.config.language};
      const header=`${options.test?'Voice transcription test':'Voice conversation'} — ${options.seconds} seconds ending ${new Date(Date.now()-performance.now()+snapshot.end).toISOString()}\nSpeech model: ${this.config.model} (${this.config.provider==='local'?`local ${this.config.localDevice}`:'OpenAI API'}). Times are approximate; network loss and recognition errors may affect results.`;
      if (!segments.length) { await options.deliver({content:`${header}\n\nNo recognizable speech was received. Silence is not proof that reception works; use a short test with known speech.`},{signal,epoch:snapshot.epoch});return; }
      const raw=`${header}\n\nRaw recognized transcript (not independently verified):\n${transcriptText(input)}`;
      let content=options.transcript || options.test ? raw : `${header}\n\n${await this.deps.summarize({...input,segments:summarySegments(segments)},signal)}`;
      await assertCurrent();
      const files:NonNullable<VoiceResult['files']>=[...audio];
      if (options.transcript || options.test) files.unshift({name:'voice-transcript.txt',attachment:Buffer.from(raw,'utf8'),description:'Raw recognized transcript for accuracy review'});
      if (content.length>1800) {
        if(!options.transcript && !options.test)files.unshift({name:'voice-summary.txt',attachment:Buffer.from(content,'utf8'),description:'Complete voice conversation summary'});
        content=content.slice(0,1700)+'\n[Complete result attached]';
      }
      await options.deliver({content,files},{signal,epoch:snapshot.epoch});
    } finally {
      controller.abort();releaseSnapshot(snapshot);for(const file of audio)file.attachment.fill(0);
      if(this.job===controller)this.job=undefined;
      if(this.closed){this.usage?.close();this.usage=undefined;}
      this.publish();
    }
  }
  close() {
    this.closed=true;clearInterval(this.timer);this.capture.stop();this.cache.clear();
    if(!this.job){this.usage?.close();this.usage=undefined;}
    this.publish();this.disposed=true;
  }
}
