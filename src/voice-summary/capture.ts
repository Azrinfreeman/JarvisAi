import { EventEmitter } from 'node:events';
import { EndBehaviorType, entersState, VoiceConnectionStatus, type VoiceConnection, type AudioReceiveStream } from '@discordjs/voice';
import { UserError } from '../errors.js';
import { VoiceBuffer, type VoiceSnapshot } from './buffer.js';

export class VoiceCapture extends EventEmitter {
  state:'off'|'waiting'|'listening'|'paused'='off';
  message='Voice listening is off.';
  channelId?:string;
  guildId?:string;
  exportAudio=false;
  private consentMode:'individual'|'server'='individual';
  private members=new Set<string>();
  private consent=new Set<string>();
  private buffer?:VoiceBuffer;
  private connection?:VoiceConnection;
  private streams=new Map<string,AudioReceiveStream>();
  private closingStreams=new WeakSet<AudioReceiveStream>();
  private names=new Map<string,string>();
  private revision=0;
  announcedAt=0;
  private enabling=false;
  private eviction?:ReturnType<typeof setInterval>;
  constructor(private clock=()=>performance.now(),private waitReady=(connection:VoiceConnection)=>entersState(connection,VoiceConnectionStatus.Ready,15000)) { super(); }
  get participants() { return this.members.size; }
  get serverConsent() { return this.consentMode==='server'; }
  get speakerNames() { return new Map(this.names); }
  rememberNames(names:Map<string,string>) {
    for(const [id,name] of names) if(this.members.has(id))this.names.set(id,name);
    this.pruneNames();
  }
  private pruneNames() {
    const retained=new Set([...this.members,...this.buffer?.speakers??[]]);
    for(const id of this.names.keys())if(!retained.has(id))this.names.delete(id);
  }
  get consentRevision() {return this.revision;}
  get epoch() { return this.buffer?.epoch; }
  get coverageSeconds() { return this.buffer ? Math.floor(this.buffer.coverage(this.clock())) : 0; }
  get pending() { return [...this.members].filter(id=>!this.consent.has(id)); }
  private changed() { this.emit('changed'); }
  private connectionChanged=() => {
    const status=this.connection?.state.status;
    if (status!==VoiceConnectionStatus.Ready && (this.state==='listening' || this.state==='waiting'
      && (!this.enabling || status===VoiceConnectionStatus.Disconnected || status===VoiceConnectionStatus.Destroyed))) this.pause('Voice connection changed. Start a new listening session after recovery.');
  };
  private clearBuffer() {
    this.revision++;
    clearInterval(this.eviction);this.eviction=undefined;
    this.buffer?.clear(); this.buffer=undefined;
    for (const id of this.streams.keys()) this.removeStream(id);
    this.pruneNames();
    this.emit('invalidated');
  }
  private removeStream(id:string) {
    const stream=this.streams.get(id);
    this.streams.delete(id);
    if(stream) {stream.removeAllListeners('data');stream.removeAllListeners('end');stream.destroy();}
  }
  private subscribe(id:string) {
    const connection=this.connection!;
    const stream=connection.receiver.subscribe(id,{end:{behavior:EndBehaviorType.Manual}});
    // The receiver removes its cached subscription on close, after destroy returns.
    if(stream.destroyed) {
      if(!this.closingStreams.has(stream)) {
        this.closingStreams.add(stream);
        stream.once('close',()=>{
          if(this.connection===connection && this.state==='listening' && this.members.has(id) && !this.streams.has(id)) {
            try {this.subscribe(id);}catch {this.pause('Voice reception could not update participants. Restart listening.');}
          }
        });
      }
      return;
    }
    this.streams.set(id,stream);
    const current=()=>this.streams.get(id)===stream && this.connection===connection && this.state==='listening' && this.members.has(id);
    stream.on('data',(packet:Buffer)=>{
      if(!current())return;
      try {this.buffer?.add(id,packet,this.clock());}
      catch(error) {this.pause(error instanceof UserError?error.message:'Voice reception failed. Start a new listening session.');}
    });
    // Keep the guarded error listener to consume errors queued before intentional destruction.
    stream.on('error',()=>{if(current())this.pause('Voice receive/decryption failed. Start a new listening session.');});
    stream.on('end',()=>{if(current())this.pause('Voice reception ended. Start a new listening session.');});
  }
  start(guildId:string,channelId:string,members:string[],connection:VoiceConnection,exportAudio=false,consentMode:'individual'|'server'='individual') {
    if (this.state!=='off') throw new UserError('Stop the existing voice-summary session before starting another.');
    if (!members.length || members.length>10) throw new UserError('Voice summaries support one to ten human participants.');
    this.guildId=guildId; this.channelId=channelId; this.members=new Set(members); this.consent.clear();
    this.revision++;this.announcedAt=Date.now();
    this.exportAudio=exportAudio; this.connection=connection; this.consentMode=consentMode;
    connection.on('stateChange',this.connectionChanged);
    this.state='waiting'; this.message=consentMode==='server'?'Preparing listening under prior server-wide consent. No audio is being captured yet.':'Waiting for every participant to use /voice-summary consent. No audio is being captured.'; this.changed();
  }
  membership(members:string[]) {
    if (this.state==='off') return false;
    const next=new Set(members);
    if (next.size===this.members.size && [...next].every(id=>this.members.has(id))) return false;
    if(this.serverConsent) {
      this.members=next;
      this.consent=this.state==='paused'?new Set():new Set(next);
      if(next.size>10) this.pause('Listening paused: at most ten human participants are supported.');
      else if(this.state==='listening') {
        try {
          for(const id of this.streams.keys())if(!next.has(id))this.removeStream(id);
          for(const id of next)if(!this.streams.has(id))this.subscribe(id);
        } catch {this.pause('Voice reception could not update participants. Restart listening.');}
      }
      this.pruneNames();this.changed();return true;
    }
    this.pause('Participants changed. Everyone must consent again before a new capture window starts.');
    this.members=next;
    this.announcedAt=Date.now();
    if (!next.size || next.size>10) { this.message='Listening paused: one to ten human participants are required.'; }
    else if(this.consentMode==='individual') this.state='waiting';
    this.changed(); return true;
  }
  async acceptServerConsent(expectedRevision=this.revision) {
    if(this.consentMode!=='server' || this.state!=='waiting' || expectedRevision!==this.revision || this.enabling) throw new UserError('Start a new announced server-consent session before listening.');
    const first=this.members.values().next().value;
    if(!first)throw new UserError('No participants are available for listening.');
    for(const member of this.members)this.consent.add(member);
    return this.accept(first,expectedRevision);
  }
  async accept(userId:string,expectedRevision=this.revision,createdAt=Date.now()) {
    if(expectedRevision!==this.revision || createdAt<this.announcedAt)throw new UserError('This listening notice changed after your consent command. Review the current notice and consent again.');
    if (!this.members.has(userId) || this.state==='off') throw new UserError('Join the active listening channel before consenting.');
    if (this.state==='paused') throw new UserError('Start a new listening session before consenting.');
    if (this.state==='listening') return 'You already consented to this listening session.';
    if (this.enabling) throw new UserError('Voice reception is being enabled. Check status shortly.');
    this.consent.add(userId);
    if (this.pending.length) { this.changed();return `Consent saved for this session. Waiting for ${this.pending.length} participant(s).`; }
    if (!this.members.size || this.members.size>10 || !this.connection) throw new UserError('No valid listening channel is ready.');
    const revision=this.revision; const connection=this.connection;
    this.enabling=true;
    try {
    if (!connection.rejoin({...connection.joinConfig,selfDeaf:false})) throw new UserError('Voice reception could not be enabled. Stop and start a new listening session.');
    await this.waitReady(connection);
    if (revision!==this.revision || this.state!=='waiting' || connection!==this.connection) throw new UserError('Listening session changed while enabling voice reception.');
    this.buffer=new VoiceBuffer(this.clock());
    this.eviction=setInterval(()=>{
      try { this.buffer?.prune(this.clock());this.pruneNames(); } catch {this.pause('Voice capture timing failed. Restart listening.');}
    },1000);this.eviction.unref();
      this.state='listening';
      for (const userId of this.members) this.subscribe(userId);
      this.message=`Listening with ${this.consentMode==='server'?'prior server-wide':'individual participant'} consent. Only requested windows are sent for transcription. Recognition and network coverage are best effort.`;
      this.changed(); return this.consentMode==='server'?'Voice listening started under prior server-wide consent. Anyone can /voice-summary withdraw.':'Everyone consented. Voice listening started; wait four or five minutes before requesting that full window.';
    } catch(error) {
      if(revision===this.revision && connection===this.connection)this.pause('Voice reception could not start. Restart the listening session.');
      throw error;
    } finally { this.enabling=false; }
  }
  pause(message:string) {
    if (this.state==='off') return;
    this.clearBuffer(); this.consent.clear(); this.state='paused'; this.message=message;
    if (this.connection && this.connection.state.status!==VoiceConnectionStatus.Destroyed) this.connection.rejoin({...this.connection.joinConfig,selfDeaf:true});
    this.changed();
  }
  stop(message='Voice listening stopped. Audio buffers and pending results were discarded.') {
    this.clearBuffer(); this.consent.clear();
    const connection=this.connection; this.connection=undefined;
    connection?.off('stateChange',this.connectionChanged);
    if (connection && connection.state.status!==VoiceConnectionStatus.Destroyed) connection.rejoin({...connection.joinConfig,selfDeaf:true});
    this.state='off';this.message=message;this.members.clear();this.names.clear();this.channelId=undefined;this.guildId=undefined;this.exportAudio=false;this.consentMode='individual';this.changed();
  }
  snapshot(seconds:number,ageMs=0):VoiceSnapshot {
    if (this.state!=='listening' || !this.buffer || !this.connection || this.connection.state.status!==VoiceConnectionStatus.Ready) throw new UserError('Voice listening is not active. Ask a controller to start and obtain participant consent first.');
    if (!Number.isFinite(ageMs) || ageMs<0 || ageMs>5000) throw new UserError('This voice request is too old. Send a new request.');
    const now=this.clock();
    return this.buffer.snapshot(seconds,now-ageMs,now);
  }
}
