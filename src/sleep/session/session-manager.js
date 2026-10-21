import { ChannelType, PermissionsBitField } from 'discord.js';
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import { createRainSceneStream, loadRainLoop, RAIN_STYLES } from '../audio/rain.js';
import { createSunnyStream } from '../audio/sunny.js';
import { UserError } from '../../errors.js';

const READY_TIMEOUT_MS = 15_000;

export class SessionManager {
  constructor(client, store, config) {
    this.client = client;
    this.store = store;
    this.config = config;
    this.runtime = new Map();
    this.queues = new Map();
  }

  runExclusive(guildId, action) {
    const previous = this.queues.get(guildId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => {
      if (this.stopped) throw new UserError('Bot is shutting down.');
      return action();
    });
    this.queues.set(guildId, current);
    current.finally(() => {
      if (this.queues.get(guildId) === current) this.queues.delete(guildId);
    }).catch(() => {});
    return current;
  }

  getRuntime(guildId) {
    let value = this.runtime.get(guildId);
    if (!value) {
      value = { timer: null, failures: 0, removalPending: false, player: null, stream: null, subscription: null, connection: null };
      this.runtime.set(guildId, value);
    }
    return value;
  }

  getConnection(guildId) {
    return getVoiceConnection(guildId);
  }

  async validateChannel(guild, channel, mode) {
    if (!channel || channel.type !== ChannelType.GuildVoice || channel.guildId !== guild.id) {
      throw new UserError('Join a standard voice channel before using this command.');
    }
    const me = guild.members.me ?? await guild.members.fetchMe();
    const permissions = channel.permissionsFor(me);
    const required = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect];
    if (mode !== 'silent') required.push(PermissionsBitField.Flags.Speak);
    if (!permissions?.has(required)) throw new UserError('I need View Channel and Connect, plus Speak to play ambience, in that voice channel.');
  }

  async join(guild, channel, mode) {
    return this.runExclusive(guild.id, async () => {
      const existing = this.store.get(guild.id);
      if (existing?.state === 'active' && existing.channel_id !== channel.id) {
        throw new UserError(`Already active in <#${existing.channel_id}>. Use /sleep leave before joining a different channel.`);
      }
      await this.validateChannel(guild, channel, mode);
      this.loadAudioAssets(mode);
      this.store.save({ guildId: guild.id, channelId: channel.id, mode, state: 'active' });
      this.getRuntime(guild.id).removalPending = false;
      this.clearRetry(guild.id);
      try {
        await this.ensureConnected(guild, channel);
        this.applyAudio(guild.id);
        return `Connected to <#${channel.id}> in ${mode} mode.`;
      } catch (error) {
        console.error(`[${guild.id}] join pending recovery:`, error);
        this.scheduleRetry(guild.id);
        return `Saved ${mode} mode for <#${channel.id}>. Connection is not ready yet; I will keep retrying. Check /sleep status.`;
      }
    });
  }

  async setMode(guildId, mode) {
    return this.runExclusive(guildId, async () => {
      if (!['silent', 'rain', 'sunny'].includes(mode)) throw new Error('Unknown ambience mode.');
      const session = this.store.get(guildId);
      if (!session || session.state !== 'active') throw new UserError('No active sleep session. Use /sleep join first.');
      if (mode !== 'silent') {
        const guild = await this.client.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(session.channel_id);
        await this.validateChannel(guild, channel, mode);
        this.loadAudioAssets(mode);
      }
      this.store.save({ guildId, channelId: session.channel_id, mode, state: 'active' });
      try {
        this.applyAudio(guildId);
      } catch (error) {
        console.error(`[${guildId}] ambience start failed:`, error);
        this.scheduleAudioRestart(guildId);
        return `${mode} mode is saved, but audio could not start yet. I will retry without leaving voice.`;
      }
      const ready = this.getConnection(guildId)?.state.status === VoiceConnectionStatus.Ready;
      if (!ready) return `${mode} mode is saved; voice is reconnecting.`;
      if (mode === 'sunny') return 'Sunny morning birdsong is on. I am staying in voice.';
      return mode === 'rain' ? 'Rain is on. I am staying in voice.' : 'Audio is off. I am staying silently in voice.';
    });
  }

  async setRainStyle(guildId, style) {
    return this.runExclusive(guildId, async () => {
      if (!RAIN_STYLES.includes(style)) throw new Error('Unknown rain style.');
      const session = this.store.get(guildId);
      if (!session || session.state !== 'active') throw new UserError('No active sleep session. Use /sleep join first.');
      this.loadRainAssets();
      this.store.save({ guildId, channelId: session.channel_id, mode: session.mode, state: 'active', rainStyle: style });
      if (session.mode === 'rain') this.getRuntime(guildId).stream?.setStyle(style);
      return session.mode === 'rain'
        ? `Rain style set to ${style}. The sound will change gently without leaving voice.`
        : `Rain style set to ${style}. It will play when you use /sleep rain on.`;
    });
  }

  loadRainAssets() {
    for (const path of Object.values(this.config.rainScenePaths)) loadRainLoop(path);
    for (const path of this.config.thunderPaths ?? []) loadRainLoop(path);
  }

  loadAudioAssets(mode) {
    if (mode === 'rain') this.loadRainAssets();
    else if (mode === 'sunny') loadRainLoop(this.config.sunnyAssetPath);
  }

  async leave(guildId) {
    return this.runExclusive(guildId, async () => {
      const session = this.store.get(guildId);
      if (!session || session.state === 'disabled') return 'I am already out of voice.';
      this.store.save({ guildId, channelId: session.channel_id, mode: session.mode, state: 'disabled' });
      this.getRuntime(guildId).removalPending = false;
      this.clearRetry(guildId);
      this.stopRuntime(guildId);
      return 'I left the voice channel and will not rejoin until /sleep join is used.';
    });
  }

  status(guildId) {
    const session = this.store.get(guildId);
    if (!session || session.state === 'disabled') return 'No active sleep session.';
    const connection = this.getConnection(guildId);
    const voice = connection?.state.status ?? 'absent';
    const player = this.getRuntime(guildId).player?.state.status ?? 'off';
    const scene = this.getRuntime(guildId).stream?.currentScene?.();
    const rain = session.mode === 'sunny' ? ' ambience: sunny morning birdsong;'
      : ` rain style: ${session.rain_style}${scene ? ` (${scene} now)` : ''};`;
    const reason = session.reason ? ` Reason: ${session.reason}.` : '';
    return `Session: ${session.state}; channel: <#${session.channel_id}>; mode: ${session.mode};${rain} voice: ${voice}; audio: ${player}.${reason}`;
  }

  async restore() {
    for (const session of this.store.active()) {
      this.runExclusive(session.guild_id, () => this.reconcile(session.guild_id)).catch((error) => {
        console.error(`[${session.guild_id}] restore failed:`, error);
      });
    }
  }

  async reconcile(guildId) {
    const session = this.store.get(guildId);
    if (!session || session.state !== 'active') return;
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(session.channel_id);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        this.suspend(guildId, 'Target channel no longer exists');
        return;
      }
      const actualChannelId = guild.members.me?.voice.channelId;
      if (actualChannelId && actualChannelId !== session.channel_id) {
        this.suspend(guildId, 'Moved by a server operator');
        return;
      }
      try {
        await this.validateChannel(guild, channel, session.mode);
        this.loadAudioAssets(session.mode);
      } catch (error) {
        this.suspend(guildId, error.message);
        return;
      }
      await this.ensureConnected(guild, channel);
      this.getRuntime(guildId).failures = 0;
      this.clearRetry(guildId);
      this.applyAudio(guildId);
    } catch (error) {
      console.error(`[${guildId}] voice recovery failed:`, error);
      this.scheduleRetry(guildId);
    }
  }

  async ensureConnected(guild, channel) {
    if (this.stopped) throw new UserError('Bot is shutting down.');
    const guildId = guild.id;
    const runtime = this.getRuntime(guildId);
    let connection = this.getConnection(guildId);
    if (connection && connection.joinConfig.channelId !== channel.id) {
      this.stopAudio(guildId);
      connection.destroy();
      connection = undefined;
    }
    if (connection?.state.status === VoiceConnectionStatus.Disconnected && !connection.rejoin()) {
      connection.destroy();
      connection = undefined;
    }
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
      connection = joinVoiceChannel({
        guildId,
        channelId: channel.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
      });
      connection.on(VoiceConnectionStatus.Disconnected, () => this.scheduleRetry(guildId));
      connection.on(VoiceConnectionStatus.Destroyed, () => this.scheduleRetry(guildId));
      connection.on('error', (error) => console.error(`[${guildId}] voice error:`, error));
    }
    runtime.connection = connection;
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    if (this.stopped) { connection.destroy(); throw new UserError('Bot is shutting down.'); }
    return connection;
  }

  applyAudio(guildId) {
    if (this.stopped) return;
    const session = this.store.get(guildId);
    const connection = this.getConnection(guildId);
    if (!session || session.state !== 'active' || !['rain', 'sunny'].includes(session.mode) ||
        connection?.state.status !== VoiceConnectionStatus.Ready) {
      this.stopAudio(guildId);
      return;
    }
    const runtime = this.getRuntime(guildId);
    if (runtime.audioMode === session.mode && runtime.player &&
        [AudioPlayerStatus.Playing, AudioPlayerStatus.Buffering].includes(runtime.player.state.status)) return;
    this.stopAudio(guildId);
    const player = createAudioPlayer();
    const stream = session.mode === 'sunny'
      ? createSunnyStream(this.config.sunnyAssetPath, this.config.rainVolume ?? 0.2)
      : createRainSceneStream(this.config.rainScenePaths, session.rain_style, this.config.rainVolume ?? 0.2, {
        thunderPaths: this.config.thunderPaths,
      });
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    const subscription = connection.subscribe(player);
    if (!subscription) {
      stream.destroy();
      throw new Error('Could not subscribe ambience player to voice connection');
    }
    runtime.player = player;
    runtime.audioMode = session.mode;
    runtime.stream = stream;
    runtime.subscription = subscription;
    player.on('error', (error) => {
      console.error(`[${guildId}] ambience player error:`, error);
      this.scheduleAudioRestart(guildId);
    });
    player.on(AudioPlayerStatus.Idle, () => this.scheduleAudioRestart(guildId));
    player.play(resource);
  }

  scheduleAudioRestart(guildId) {
    if (this.stopped) return;
    const runtime = this.getRuntime(guildId);
    if (runtime.audioTimer) return;
    runtime.audioTimer = setTimeout(() => {
      runtime.audioTimer = null;
      this.runExclusive(guildId, () => this.applyAudio(guildId)).catch((error) => {
        console.error(`[${guildId}] ambience restart failed:`, error);
        this.scheduleAudioRestart(guildId);
      });
    }, 3000);
  }

  stopAudio(guildId) {
    const runtime = this.getRuntime(guildId);
    if (runtime.audioTimer) clearTimeout(runtime.audioTimer);
    runtime.audioTimer = null;
    runtime.player?.removeAllListeners();
    runtime.player?.stop(true);
    runtime.subscription?.unsubscribe();
    runtime.stream?.destroy();
    runtime.player = null;
    runtime.audioMode = null;
    runtime.subscription = null;
    runtime.stream = null;
  }

  stopRuntime(guildId) {
    this.stopAudio(guildId);
    const connection = this.getConnection(guildId);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    this.getRuntime(guildId).connection = null;
  }

  suspend(guildId, reason) {
    const session = this.store.get(guildId);
    if (!session || session.state !== 'active') return;
    this.store.save({ guildId, channelId: session.channel_id, mode: session.mode, state: 'suspended', reason });
    this.getRuntime(guildId).removalPending = false;
    this.clearRetry(guildId);
    this.stopAudio(guildId);
    console.warn(`[${guildId}] session suspended: ${reason}`);
  }

  onVoiceStateUpdate(oldState, newState) {
    if (newState.id !== this.client.user?.id) return;
    const guildId = newState.guild.id;
    const session = this.store.get(guildId);
    if (!session || session.state !== 'active' || !oldState.channelId) return;
    if (newState.channelId === session.channel_id) {
      this.getRuntime(guildId).removalPending = false;
      return;
    }
    if (newState.channelId && newState.channelId !== session.channel_id) {
      this.runExclusive(guildId, () => this.suspend(guildId, 'Moved by a server operator')).catch(console.error);
    } else if (!newState.channelId && oldState.channelId === session.channel_id) {
      // A short delay lets transport recovery settle. If the gateway still
      // reports removal, respect it rather than repeatedly rejoining.
      this.getRuntime(guildId).removalPending = true;
      this.clearRetry(guildId);
      setTimeout(() => {
        const runtime = this.getRuntime(guildId);
        if (!runtime.removalPending) return;
        runtime.removalPending = false;
        if (newState.guild.members.me?.voice.channelId) return;
        const connection = this.getConnection(guildId);
        if (connection && [VoiceConnectionStatus.Signalling, VoiceConnectionStatus.Connecting].includes(connection.state.status)) {
          this.scheduleRetry(guildId);
          return;
        }
        this.runExclusive(guildId, () => this.suspend(guildId, 'Removed from voice; use /sleep join to resume')).catch(console.error);
      }, 10_000);
    }
  }

  scheduleRetry(guildId) {
    if (this.stopped) return;
    if (this.store.get(guildId)?.state !== 'active') return;
    const runtime = this.getRuntime(guildId);
    if (runtime.removalPending) return;
    if (runtime.timer) return;
    runtime.failures += 1;
    const cap = Math.min(this.config.maxReconnectMs, this.config.minReconnectMs * 2 ** Math.min(runtime.failures - 1, 10));
    const delay = Math.round(cap * (0.8 + Math.random() * 0.4));
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      this.runExclusive(guildId, () => this.reconcile(guildId)).catch((error) => {
        console.error(`[${guildId}] retry failed:`, error);
        this.scheduleRetry(guildId);
      });
    }, delay);
    if (runtime.failures === 5) console.warn(`[${guildId}] repeated voice failures; inspect /sleep status and logs`);
  }

  clearRetry(guildId) {
    const runtime = this.getRuntime(guildId);
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = null;
  }

  shutdown() {
    this.stopped = true;
    for (const guildId of this.runtime.keys()) {
      this.clearRetry(guildId);
      this.stopRuntime(guildId);
    }
  }
}
