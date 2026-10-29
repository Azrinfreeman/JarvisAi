import { ChannelType, MessageFlags, PermissionFlagsBits, Routes, type Client, type Guild, type VoiceChannel, type GuildMember, type ChatInputCommandInteraction, type Message, type VoiceState } from 'discord.js';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { SessionManager } from '../sleep/session/session-manager.js';
import { authorized, type botConfig } from '../config.js';
import { isController } from '../sleep/auth/controller.js';
import { UserError } from '../errors.js';
import { VoiceSummaryService, voiceIntent, type VoiceResult } from './service.js';
import { localReady } from './local-setup.js';

export function voiceNotice(local:boolean,serverConsent=false) {
  return 'Voice summaries: a rolling five-minute audio buffer is held in memory (plus five seconds of event-delivery headroom). '
    +(local?'Audio is transcribed locally on the bot’s PC; summaries send the recognized text to the configured AI provider. '
      :'Requested audio is sent to OpenAI for transcription and recognized text to the configured AI provider for summaries. ')
    +'Results appear in this voice channel’s text chat, which may be readable outside the call. '
    +(serverConsent?'The server owner has configured prior consent for all server beta testers. Listening starts after this notice without individual /consent commands and continues as participants join or leave. '
      :'Everyone must use /voice-summary consent. No audio is captured before everyone opts in. ')
    +'/voice-summary withdraw stops listening and clears pending audio/results; controllers can also /voice-summary stop.';
}

export class VoiceCommands {
  private busy=false;
  private receipts=new Map<string,number>();
  constructor(private client:Client,private sessions:SessionManager,readonly service:VoiceSummaryService,
    private access:ReturnType<typeof botConfig>,private controllerRoles:Set<string>) {}
  private async memberChannel(guild:Guild,userId:string) {
    const member=await guild.members.fetch(userId);
    const channel=member.voice.channel;
    if (!channel || channel.type!==ChannelType.GuildVoice) throw new UserError('Join a standard voice channel first.');
    return {member,channel};
  }
  private participants(channel:VoiceChannel) {return [...channel.members.values()].filter(member=>!member.user.bot).map(member=>member.id);}
  private sync(channel:VoiceChannel) {
    this.service.capture.membership(this.participants(channel));
    this.service.capture.rememberNames(new Map([...channel.members.values()].filter(member=>!member.user.bot)
      .map(member=>[member.id,member.displayName.replace(/[\r\n\x00-\x1f]/g,' ').slice(0,80)])));
  }
  private async channel(guild:Guild,userId:string,channelId?:string) {
    if (guild.id!==this.access.guildId) throw new UserError('Voice summaries are available only in the configured server.');
    const result=await this.memberChannel(guild,userId);
    if (channelId && channelId!==result.channel.id) throw new UserError('Use this command in your voice channel’s own text chat.');
    const me=await guild.members.fetchMe();
    if (!result.channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.SendMessages])) throw new UserError('I need View Channel, Connect and Send Messages in this voice channel.');
    return result;
  }
  private checkAI(member:GuildMember,channel:VoiceChannel) {
    if (!authorized(this.access,{guildId:member.guild.id,userId:member.id,channelId:channel.id,roles:[...member.roles.cache.keys()]})) throw new UserError('AI access is restricted by the configured member, role and channel rules.');
  }
  async interaction(interaction:ChatInputCommandInteraction) {
    if (!interaction.guild) throw new UserError('Use voice summaries in the configured server.');
    const command=interaction.options.getSubcommand();
    const capture=this.service.capture;
    const consentRevision=capture.consentRevision;
    if(command==='stop' || command==='withdraw') {
      if(interaction.guildId!==this.access.guildId)throw new UserError('Use voice summaries in the configured server.');
      const {member,channel}=await this.memberChannel(interaction.guild,interaction.user.id);
      if(capture.guildId!==interaction.guildId || capture.channelId!==channel.id)throw new UserError('There is no listening session in your voice channel.');
      if(command==='stop' && !isController(member,interaction.guild.ownerId,this.controllerRoles))throw new UserError('Only an authorized sleep controller can stop listening. Anyone can withdraw their own consent.');
      capture.stop();
      const content=command==='withdraw'?'A participant withdrew consent. Listening stopped and pending audio/results were discarded.':'Voice listening stopped. Audio buffers and pending results were discarded. Ambience is preserved.';
      await channel.send({content,allowedMentions:{parse:[]}}).catch(()=>{});
      await interaction.reply({content,flags:MessageFlags.Ephemeral});return;
    }
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    const {member,channel}=await this.channel(interaction.guild,interaction.user.id,
      ['summarize','transcript','test'].includes(command) ? interaction.channelId : undefined);
    const controller=isController(member,interaction.guild.ownerId,this.controllerRoles);
    if(command==='start') {
      if(!controller)throw new UserError('Only an authorized sleep controller can start listening.');
      if(!this.service.config.enabled || this.service.config.provider==='openai' && !this.service.config.key)throw new UserError('Enable voice summaries in Settings; cloud transcription also requires its speech API key. Restart after saving.');
      if(this.busy)throw new UserError('A listening operation is already in progress.');
      if(capture.state!=='off')throw new UserError('Stop the current listening session before starting another.');
      this.busy=true;
      try {
        if(this.service.config.provider==='local' && !await localReady(this.service.root))throw new UserError('Use Set up local transcription in Settings before starting a local listening session.');
        const existing=this.sessions.getConnection(interaction.guildId!);
        if(!existing) await this.sessions.join(interaction.guild,channel,'silent');
        const connection=this.sessions.getConnection(interaction.guildId!);
        if(!connection || connection.joinConfig.channelId!==channel.id || connection.state.status!==VoiceConnectionStatus.Ready)throw new UserError('The bot must be ready in this voice channel. Use /sleep join and check /sleep status.');
        const exportAudio=interaction.options.getBoolean('allow-test-audio')??false;
        const serverConsent=this.service.config.consentMode==='server';
        await channel.send({content:voiceNotice(this.service.config.provider==='local',serverConsent)+(exportAudio?' This session also permits explicitly requested short test audio exports to this channel.':' Test audio exports are disabled.'),allowedMentions:{parse:[]}});
        const fresh=await this.channel(interaction.guild,member.id);
        if(fresh.channel.id!==channel.id)throw new UserError('Your voice channel changed. Start again.');
        capture.start(interaction.guildId!,channel.id,this.participants(channel),connection,exportAudio,this.service.config.consentMode);
        this.sync(channel);
        const response=serverConsent?await capture.acceptServerConsent():'Listening session announced. Every participant, including you, must now use /voice-summary consent.';
        await interaction.editReply(response);
      } finally {this.busy=false;}
      return;
    }
    if(capture.guildId!==interaction.guildId || capture.channelId!==channel.id) {
      if(command==='status') {await interaction.editReply('No listening session exists in your voice channel.');return;}
      throw new UserError('There is no listening session in your voice channel.');
    }
    this.sync(channel);
    if(command==='consent') {
      const response=await capture.accept(member.id,consentRevision,interaction.createdTimestamp);
      await interaction.editReply(response);
      if(capture.state==='listening')await channel.send({content:response,allowedMentions:{parse:[]}});
      return;
    }
    if(command==='status') {await interaction.editReply(`${capture.message}\nCoverage: ${capture.coverageSeconds}s. Participants: ${capture.participants}. Awaiting consent: ${capture.pending.length}.\nSpeech model: ${this.service.config.model}. Reserved this month: ${this.service.status().usageSeconds}s.`);return;}
    this.checkAI(member,channel);
    await interaction.editReply(this.service.config.provider==='local'?'Preparing local transcription. Results will appear in this voice channel’s text chat.':'Preparing the requested voice window. This may use speech API credit. Results will appear in this voice channel’s text chat.');
    await this.request(interaction.guild,member.id,channel.id,interaction.id,interaction.createdTimestamp,
      command==='test' ? interaction.options.getInteger('seconds')??30 : (interaction.options.getInteger('minutes')??this.service.config.minutes)*60,
      command==='test',command==='transcript',interaction.options.getBoolean('audio')??false);
    await interaction.editReply('Voice request completed. See this voice channel’s text chat.');
  }
  async mention(message:Message,prompt:string) {
    const intent=voiceIntent(prompt,this.service.config.minutes);
    if(!intent)return false;
    if(!message.guild)throw new UserError('Use voice summaries in the configured server.');
    const {member,channel}=await this.channel(message.guild,message.author.id,message.channelId);
    this.checkAI(member,channel);this.sync(channel);
    await this.request(message.guild,member.id,channel.id,message.id,message.createdTimestamp,intent.seconds,false,intent.action==='transcript',false);
    return true;
  }
  private async request(guild:Guild,userId:string,channelId:string,eventId:string,created:number,seconds:number,test:boolean,transcript:boolean,audio:boolean) {
    const requestedEpoch=this.service.capture.epoch;
    for(const [id,at] of this.receipts)if(at<Date.now()-900000)this.receipts.delete(id);
    if(this.receipts.has(eventId))throw new UserError('This voice request was already handled. Send a new request.');
    this.receipts.set(eventId,Date.now());
    const capture=this.service.capture;
    const guard=async()=>{
      const member=await guild.members.fetch({user:userId,force:true});
      const channel=await guild.channels.fetch(channelId);
      if(guild.id!==this.access.guildId || !channel || channel.type!==ChannelType.GuildVoice)throw new UserError('The original voice channel is unavailable.');
      this.checkAI(member,channel);
      if(!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel))throw new UserError('You no longer have access to the result channel.');
      if(!capture.serverConsent && member.voice.channel?.id!==channelId)throw new UserError('Join the active voice channel to receive this result.');
      if(!channel.permissionsFor(await guild.members.fetchMe({force:true}))?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.SendMessages]))throw new UserError('I need View Channel, Connect and Send Messages in the original voice channel.');
      this.sync(channel);
      if(capture.channelId!==channel.id || capture.state!=='listening' || capture.epoch!==requestedEpoch)throw new UserError('Listening or participant permissions changed. No result was posted.');
      if((transcript || test || audio) && !channel.permissionsFor(await guild.members.fetchMe())?.has(PermissionFlagsBits.AttachFiles))throw new UserError('I need Attach Files to post the review transcript or audio.');
    };
    await guard();
    const channel=await guild.channels.fetch(channelId);
    if(!channel || channel.type!==ChannelType.GuildVoice)throw new UserError('The voice channel is unavailable.');
    const names=capture.speakerNames;
    await this.service.process({seconds,ageMs:Date.now()-created,requester:userId,test,transcript,audio,names,guard,
      deliver:async (result,context)=>{
        const files=result.files??[];
        if(files.length && !channel.permissionsFor(await guild.members.fetchMe())?.has(PermissionFlagsBits.AttachFiles))throw new UserError('Attach Files permission is required for this result.');
        for(let index=0;index<Math.max(1,Math.ceil(files.length/8));index++) {
          await guard();
          context.signal.throwIfAborted();
          if(capture.epoch!==context.epoch || capture.epoch!==requestedEpoch)throw new UserError('Listening changed. No further result was posted.');
          const part:VoiceResult={content:index===0?result.content:'Explicit voice test audio review files.',files:files.slice(index*8,index*8+8)};
          if(part.files?.some(file=>file.attachment.length>8*1024*1024))throw new UserError('Voice review attachment exceeds the safe upload size.');
          await this.client.rest.post(Routes.channelMessages(channel.id),{signal:context.signal,
            body:{content:part.content,nonce:BigInt('0x'+createNonce(eventId,index)).toString(),enforce_nonce:true,allowed_mentions:{parse:[]},
              attachments:part.files?.map((file,fileIndex)=>({id:fileIndex,filename:file.name,description:file.description}))},
            files:part.files?.map(file=>({data:file.attachment,name:file.name,contentType:file.name.endsWith('.wav')?'audio/wav':'text/plain'}))});
        }
      }});
  }
  voiceState(oldState:VoiceState,newState:VoiceState) {
    const capture=this.service.capture;
    if(capture.state==='off' || newState.guild.id!==capture.guildId)return;
    if(newState.id===this.client.user?.id) {
      if(newState.channelId!==capture.channelId || newState.serverDeaf || newState.selfDeaf && capture.state==='listening')capture.pause('Bot voice state changed. Stop and start a new listening session.');
      return;
    }
    if(oldState.channelId===capture.channelId || newState.channelId===capture.channelId) {
      const channel=newState.guild.channels.cache.get(capture.channelId!);
      if(channel?.type===ChannelType.GuildVoice) {
        const revision=capture.consentRevision;
        this.sync(channel);
        if(!capture.serverConsent && revision!==capture.consentRevision) {
          void channel.send({content:capture.message,allowedMentions:{parse:[]}}).catch(()=>{
            if(capture.consentRevision===revision+1)capture.stop('Listening stopped because its notice could not be posted.');
          });
        }
      }
    }
  }
}

function createNonce(eventId:string,index:number) {
  return (BigInt(eventId)+BigInt(index)).toString(16);
}
