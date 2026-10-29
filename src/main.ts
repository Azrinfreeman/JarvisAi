import './bootstrap.js';
import { Client, Events, GatewayIntentBits, MessageFlags, MessageType, PermissionFlagsBits, Routes, type APIMessage, type ChatInputCommandInteraction } from 'discord.js';
import { join } from 'node:path';
import { stateRoot } from './app-paths.js';
import { botConfig, authorized } from './config.js';
import { loadConfig } from './sleep/config.js';
import { SessionStore } from './sleep/storage/session-store.js';
import { SessionManager } from './sleep/session/session-manager.js';
import { handleSleep } from './integration/sleep-handler.js';
import { AIClient } from './integration/ai-client.js';
import { commandOwner, DispatchGate } from './integration/routing.js';
import { mentionedPrompt } from './mentions.js';
import { validateImage } from './images.js';
import { referencedInput } from './replies.js';
import type { ReplyPayload } from './responses.js';
import { runtimeLock } from './vault.js';
import { UserError, safeError } from './errors.js';
import { healthMonitor } from './integration/health.js';
import { Conversations } from './storage.js';
import { Nicknames } from './nicknames.js';
import { nicknameIntent } from './nickname-request.js';
import { startRuntimeControl } from './integration/runtime-control.js';
import { voiceConfig } from './voice-summary/config.js';
import { VoiceSummaryService } from './voice-summary/service.js';
import { VoiceCommands } from './voice-summary/discord.js';

let client: Client | undefined;
let ai: AIClient | undefined;
let sessions: SessionManager | undefined;
let store: SessionStore | undefined;
let release: (() => void) | undefined;
let closing = false;
let cleaned = false;
let control: Awaited<ReturnType<typeof startRuntimeControl>> | undefined;
let shuttingDown: Promise<void> | undefined;
let stopHealth: (() => void) | undefined;
let nicknameEvents:Conversations | undefined;
let voiceSummaries:VoiceSummaryService | undefined;
function cleanup() {
  if (cleaned) return; cleaned = true; closing = true;
  stopHealth?.(); voiceSummaries?.close(); void ai?.close({force:false}); sessions?.shutdown(); void client?.destroy(); store?.close(); nicknameEvents?.close(); control?.close(); release?.();
}
function shutdown(exitCode = 0): Promise<void> {
  return shuttingDown ??= (async () => {
    closing = true; stopHealth?.(); voiceSummaries?.close(); sessions?.shutdown(); await client?.destroy();
    if (ai && !await ai.close({force:false})) throw new UserError('AI worker did not exit. Inspect the owned process before recovery.');
    cleanup(); process.exit(exitCode);
  })().catch(error => { shuttingDown = undefined; throw error; });
}
process.once('exit',cleanup);
process.once('SIGINT',() => { void shutdown().catch(error => console.error(safeError(error))); });
process.once('SIGTERM',() => { void shutdown().catch(error => console.error(safeError(error))); });
try {
  const config = botConfig();
  const sleepConfig = loadConfig();
  const root = stateRoot;
  release = runtimeLock(join(root,'data','frontend',sleepConfig.applicationId!));
  nicknameEvents=new Conversations(join(root,'data','frontend',sleepConfig.applicationId!,'nickname-events.sqlite'));
  const nicknames=new Nicknames(config,nicknameEvents);
  const gate = new DispatchGate();
  store = new SessionStore(sleepConfig.databasePath);
  client = new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.GuildVoiceStates],
    allowedMentions:{parse:[],repliedUser:false}});
  const bot = client;
  sessions = new SessionManager(bot,store,sleepConfig);
  const sleep = sessions;
  ai = new AIClient(); const worker = ai;
  const speechConfig=voiceConfig();
  voiceSummaries=new VoiceSummaryService(root,speechConfig,{transcribe: (await import('./voice-summary/speech-client.js')).transcribeSnapshot,
    summarize:(input,signal)=>worker.summarizeVoice(input,signal)});
  const voice=new VoiceCommands(bot,sleep,voiceSummaries,config,sleepConfig.controllerRoleIds);
  stopHealth=healthMonitor(join(root,'data','runtime-status.json'),() => ({
    discordReady:bot.isReady(),ai:worker.status,configRevision:process.env.BOT_CONFIG_REVISION,
    sleep:store!.active().map(session=>({state:session.state,mode:session.mode,rainStyle:session.rain_style,
      voice:sleep.getConnection(session.guild_id)?.state.status ?? 'absent',audio:sleep.getRuntime(session.guild_id).player?.state.status ?? 'off'})),
  }));
  worker.on('status',status => console.log(`AI status: ${status.phase}. ${status.label}`));
  worker.start();
  try { control = await startRuntimeControl({ revision:process.env.BOT_CONFIG_REVISION ?? 'legacy', workerPid:() => worker.workerPid, shutdown }); }
  catch {
    if(process.env.RAINBOT_RESOURCE_ROOT)throw new UserError('The local control channel could not start. No Discord connection was opened. Check local ownership and permissions.');
    console.error('Local Start/Stop control is unavailable. Use the bot terminal for shutdown.');
  }
  bot.once(Events.ClientReady,async () => {
    if (bot.user!.id !== sleepConfig.applicationId) {
      console.error('Discord token/application ID mismatch. Stopping combined bot.'); void shutdown(1).catch(error => console.error(safeError(error))); return;
    }
    console.log('Combined bot connected. Sleep restoration is independent of AI.');
    await sleep.restore();
  });
  bot.on(Events.VoiceStateUpdate,(oldState,newState) => {voice.voiceState(oldState,newState);sleep.onVoiceStateUpdate(oldState,newState);});
  bot.on(Events.Error,() => console.error('Discord connection error. Check configuration and connectivity.'));
  async function respond(interaction: ChatInputCommandInteraction) {
    if (closing) return;
    const owner = commandOwner(interaction.commandName);
    if (!owner || !gate.claim(`interaction:${interaction.id}`)) return;
    if (owner === 'voice-summary') { await voice.interaction(interaction); return; }
    if (owner === 'sleep') { await handleSleep(interaction,sleep,sleepConfig.controllerRoleIds); return; }
    const roles = interaction.member && 'roles' in interaction.member
      ? Array.isArray(interaction.member.roles) ? interaction.member.roles : [...interaction.member.roles.cache.keys()] : [];
    if (!authorized(config,{guildId:interaction.guildId,userId:interaction.user.id,channelId:interaction.channelId,roles})) {
      await interaction.reply({content:'AI access is restricted to the configured guild, member mode, channels and roles.',flags:MessageFlags.Ephemeral}); return;
    }
    const identity = {guildId:interaction.guildId!,channelId:interaction.channelId,userId:interaction.user.id};
    if (owner==='nickname') {
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const request={targetId:interaction.options.getUser('member',true).id,nickname:interaction.options.getString('name',true).trim()};
      if (!interaction.guild) throw new UserError('Use nickname changes in the configured server.');
      const result=await nicknames.change(interaction.guild,interaction.user.id,interaction.channelId,
        `interaction:${interaction.applicationId}:${interaction.id}`,request,AbortSignal.timeout(45000),
        async content=>{
          await interaction.editReply({content,allowedMentions:{parse:[]}});
          await interaction.followUp({content,allowedMentions:{parse:[]}});
        });
      await interaction.editReply({content:result,allowedMentions:{parse:[]}}); return;
    }
    if (interaction.commandName === 'help') {
      await interaction.reply({flags:MessageFlags.Ephemeral,content:'Use /ask or mention me for AI questions. Add an image or reply to a message for context. /ask private:true is visible only to you; /reset clears your AI chat history in this channel. /nickname changes a server nickname for the owner or Manage Nicknames members, subject to hierarchy. /sleep join, rain/sunny, leave and status control ambience for authorized controllers. Voice summaries are disabled by default: /voice-summary start announces listening and everyone must /voice-summary consent. Tag me with "ringkaskan perbualan voice 5 minit tadi" in the voice channel text chat, or use summarize/transcript/test. Only captured speech is available; /voice-summary withdraw stops capture and clears pending audio. Local transcription needs no speech API key; optional cloud transcription uses its own API key and allowance. Summaries use the connected text provider. No AI speech is generated.'}); return;
    }
    if (interaction.commandName === 'status') {
      await interaction.reply({flags:MessageFlags.Ephemeral,content:`AI: ${worker.status.phase}\n${worker.status.label}\nAccess: ${config.accessMode}. ${config.provider === 'openai' ? 'Usage is billed to the configured API project.' : 'Web search: context first. Allowance is managed in ChatGPT settings.'}\nUse /sleep status for voice/audio state.`}); return;
    }
    if (interaction.commandName === 'reset') {
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      await worker.reset(identity); await interaction.editReply('Your public/private AI context in this channel was deleted. Sleep sessions were preserved.'); return;
    }
    const attachment = interaction.options.getAttachment('image');
    const image = attachment ? validateImage(attachment) : undefined;
    const prompt = interaction.options.getString('prompt')?.trim() || (image ? 'Describe this image.' : '');
    if (!prompt || prompt.length > 4000) throw new UserError('Enter a question between 1 and 4000 characters.');
    const privateReply = interaction.options.getBoolean('private') ?? false;
    await interaction.deferReply(privateReply ? {flags:MessageFlags.Ephemeral} : {});
    let delivered = false;
    try {
      const nickname=nicknameIntent(prompt);
      if (nickname) {
        if (!interaction.guild) throw new UserError('Use nickname changes in the configured server.');
        await nicknames.checkActor(interaction.guild,interaction.user.id,interaction.channelId);
      }
      await worker.ask({eventKey:`interaction:${interaction.applicationId}:${interaction.id}`,
        identity:{...identity,visibility:privateReply ? 'private' : 'public'},prompt,image,nickname,
        attachmentLimit:interaction.attachmentSizeLimit,useImageEmbeds:interaction.appPermissions?.has(PermissionFlagsBits.EmbedLinks) ?? false},
      async payload => { await interaction.editReply({...payload,allowedMentions:{parse:[]}}); delivered = true; },undefined,
      nickname ? (request,signal)=>nicknames.change(interaction.guild!,interaction.user.id,interaction.channelId,
        `interaction:${interaction.applicationId}:${interaction.id}`,request,signal,
        privateReply ? async content=>{
          await interaction.editReply({content,allowedMentions:{parse:[]}});
          await interaction.followUp({content,allowedMentions:{parse:[]}});
        } : undefined) : undefined);
    } catch(error) { if (!delivered) throw error; }
  }
  bot.on(Events.InteractionCreate,interaction => {
    if (!interaction.isChatInputCommand()) return;
    void respond(interaction).catch(async error => {
      try {
        const payload = {content:safeError(error),allowedMentions:{parse:[] as never[]}};
        if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
        else await interaction.reply({...payload,flags:MessageFlags.Ephemeral});
      } catch { console.error('Could not deliver a command response. No prompt or credential was logged.'); }
    });
  });
  bot.on(Events.MessageCreate,message => {
    if (closing) return;
    if (message.author.bot || message.webhookId || !message.inGuild() || !bot.user) return;
    const prompt = mentionedPrompt(message.content,bot.user.id);
    if (prompt === undefined || !authorized(config,{guildId:message.guildId,channelId:message.channelId,userId:message.author.id,
      roles:message.member ? [...message.member.roles.cache.keys()] : []}) || !gate.claim(`message:${message.id}`)) return;
    let delivered = false;
    const reply = async (payload: string | ReplyPayload) => {
      if (delivered) return;
      const options = {...(typeof payload === 'string' ? {content:payload} : payload),nonce:message.id,enforceNonce:true,
        allowedMentions:{parse:[] as never[],repliedUser:false}};
      if (message.channel.permissionsFor(bot.user!)?.has(PermissionFlagsBits.ReadMessageHistory)) await message.reply(options);
      else if (message.channel.isSendable()) await message.channel.send(options);
      else throw new UserError('I cannot send messages in this channel.');
      delivered = true;
    };
    void (async () => {
      if(await voice.mention(message,prompt))return;
      if (message.attachments.size > 1) throw new UserError('Attach one image per question.');
      const attachment = message.attachments.first(); const image = attachment ? validateImage(attachment) : undefined;
      if (image && !message.channel.permissionsFor(bot.user!)?.has(PermissionFlagsBits.AttachFiles)) throw new UserError('I need Attach Files to show the image with your question.');
      const reference = message.type === MessageType.Reply ? message.reference : null;
      const loadReference = reference ? async (signal: AbortSignal) => {
        if (!message.channel.permissionsFor(bot.user!)?.has(PermissionFlagsBits.ReadMessageHistory)) throw new UserError('I need Read Message History to read the selected message.');
        return referencedInput(reference,{guildId:message.guildId,channelId:message.channelId,botId:bot.user!.id,
          botName:message.guild.members.me?.displayName || bot.user!.displayName,userId:message.author.id,
          userName:message.member?.displayName || message.author.displayName},async (channelId,messageId,signal) => {
          const target = await bot.rest.get(Routes.channelMessage(channelId,messageId),{signal}) as APIMessage;
          return {id:target.id,channelId:target.channel_id,content:target.content,
            author:{id:target.author.id,name:target.author.global_name || target.author.username,bot:target.author.bot},
            attachments:target.attachments.map(a => ({url:a.url,size:a.size,contentType:a.content_type ?? null,filename:a.filename,width:a.width,height:a.height})),
            reference:target.type === MessageType.Reply && target.message_reference ? {messageId:target.message_reference.message_id,
              channelId:target.message_reference.channel_id,guildId:target.message_reference.guild_id} : undefined};
        },signal,{useImage:!image});
      } : undefined;
      const question = prompt || (reference ? 'Reply to the referenced message.' : image ? 'Describe this image.' : '');
      if (!question) { await reply('Mention me with a question/image, or reply to a message and tag me.'); return; }
      const nickname=nicknameIntent(question);
      if (nickname) await nicknames.checkActor(message.guild,message.author.id,message.channelId);
      await worker.ask({eventKey:`message:${bot.user!.id}:${message.id}`,
        identity:{guildId:message.guildId,channelId:message.channelId,userId:message.author.id,visibility:'public'},
        prompt:question,image,hasReference:!!reference,nickname,
        sourceUrl:reference?.messageId ? `https://discord.com/channels/${message.guildId}/${message.channelId}/${reference.messageId}` : undefined,
        useImageEmbeds:message.channel.permissionsFor(bot.user!)?.has(PermissionFlagsBits.EmbedLinks) ?? false},reply,loadReference,
        nickname ? (request,signal)=>nicknames.change(message.guild,message.author.id,message.channelId,
          `message:${bot.user!.id}:${message.id}`,request,signal) : undefined);
    })().catch(async error => {
      if (delivered) return;
      try { await reply(safeError(error)); } catch { console.error('Could not deliver a mention response.'); }
    });
  });
  await bot.login(config.token);
} catch(error) { console.error(safeError(error)); void shutdown(1).catch(error => console.error(safeError(error))); }
