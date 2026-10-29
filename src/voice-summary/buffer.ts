import { randomUUID } from 'node:crypto';
import { UserError } from '../errors.js';

export type AudioFrame = {at:number;packet:Buffer};
export type SpeechChunk = {speakerId:string;start:number;end:number;frames:AudioFrame[]};
export type VoiceSnapshot = {epoch:string;start:number;end:number;chunks:SpeechChunk[]};

export class VoiceBuffer {
  readonly epoch = randomUUID();
  private frames = new Map<string,AudioFrame[]>();
  private bytes = 0;
  private count = 0;
  private lastTime: number;
  constructor(readonly started:number, private maxBytes = 64 * 1024 * 1024, private maxFrames=200000,private maxSpeakerFrames=32000) { this.lastTime=started; }
  prune(now:number) {
    if (now < this.lastTime) throw new UserError('Voice capture clock changed. Restart listening.');
    this.lastTime=now;
    for (const [speaker,frames] of this.frames) {
      let removed=0;
      while (removed < frames.length && frames[removed]!.at < now-305000) {
        this.bytes-=frames[removed]!.packet.length; frames[removed]!.packet.fill(0); removed++;
      }
      if (removed) frames.splice(0,removed);
      this.count-=removed;
      if (!frames.length) this.frames.delete(speaker);
    }
  }
  add(speaker:string, packet:Buffer, at:number) {
    this.prune(at);
    if (!Buffer.isBuffer(packet) || packet.length < 1 || packet.length > 8192) throw new UserError('Invalid received voice packet. Listening was stopped.');
    if (this.bytes+packet.length > this.maxBytes) throw new UserError('Voice audio capacity was reached. Restart listening with fewer speakers.');
    const frames=this.frames.get(speaker) ?? [];
    if(this.count>=this.maxFrames || frames.length>=this.maxSpeakerFrames)throw new UserError('Voice packet capacity was reached. Listening must restart.');
    frames.push({at,packet:Buffer.from(packet)}); this.frames.set(speaker,frames); this.bytes+=packet.length;
    this.count++;
  }
  coverage(now:number) { return Math.max(0,Math.min(300,(now-this.started)/1000)); }
  get speakers() { return [...this.frames.keys()]; }
  snapshot(seconds:number,end:number,now:number):VoiceSnapshot {
    this.prune(now);
    if (!Number.isFinite(seconds) || seconds < 10 || seconds > 300 || !Number.isFinite(end)
      || end > now || end-seconds*1000 < Math.max(this.started,now-305000)) {
      throw new UserError(`The full requested window is not available. Listening coverage: ${Math.floor(this.coverage(now))} seconds. Wait for coverage or use /voice-summary test.`);
    }
    const start=end-seconds*1000;
    const chunks:SpeechChunk[]=[];
    for (const [speakerId,frames] of this.frames) {
      const selected=frames.filter(frame => frame.at >= start && frame.at < end);
      let current:SpeechChunk | undefined;
      for (const frame of selected) {
        if (!current || frame.at-current.start >= 24500 || frame.at-current.end > 1000) {
          const overlap=current && frame.at-current.end<=1000 ? current.frames.filter(previous=>previous.at>=frame.at-200)
            .map(previous=>({at:previous.at,packet:Buffer.from(previous.packet)})) : [];
          current={speakerId,start:overlap[0]?.at??frame.at,end:frame.at,frames:overlap}; chunks.push(current);
        }
        current.frames.push({at:frame.at,packet:Buffer.from(frame.packet)});
        current.end=Math.min(end,frame.at+120);
      }
    }
    if (chunks.length > 200) { releaseSnapshot({epoch:this.epoch,start,end,chunks}); throw new UserError('Too many speech turns for one request. Use a shorter test or fewer speakers.'); }
    return {epoch:this.epoch,start,end,chunks:chunks.sort((first,second) => first.start-second.start)};
  }
  clear() {
    for (const frames of this.frames.values()) for (const frame of frames) frame.packet.fill(0);
    this.frames.clear(); this.bytes=0;this.count=0;
  }
}

export function releaseSnapshot(snapshot:VoiceSnapshot) {
  for (const chunk of snapshot.chunks) for (const frame of chunk.frames) frame.packet.fill(0);
  snapshot.chunks.length=0;
}
