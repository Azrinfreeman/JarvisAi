import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SettingsStore, isRecord } from '../settings.js';
import { BotSupervisor } from './supervisor.js';
import { apiModels, OpenAIProvider } from '../openai-provider.js';
import { reasoningEffort } from '../config.js';
import { UserError } from '../errors.js';
import { LocalSpeechSetup } from '../voice-summary/local-setup.js';

export async function readVoiceSummaryStatus(path: string, now = Date.now()) {
  const off = { state:'off', coverageSeconds:0, participants:0, model:'', message:'Voice listening is off.', usageSeconds:0 };
  let file;
  try {
    file = await open(path, 'r');
    const info = await file.stat();
    if (!info.isFile() || info.size > 16384 || now - info.mtimeMs > 30000 || now - info.mtimeMs < -5000) return off;
    const raw: unknown = JSON.parse(await file.readFile('utf8'));
    if (!isRecord(raw)) return off;
    const timestamp = raw.updatedAt ?? raw.at;
    const at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    if (!Number.isFinite(at) || now - at > 30000 || now - at < -5000 || raw.stopped === true) return off;
    const state = typeof raw.state === 'string' && ['off','waiting','listening','paused','processing'].includes(raw.state) ? raw.state : 'off';
    const count = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : 0;
    const model = typeof raw.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(raw.model) ? raw.model : '';
    const message = typeof raw.message === 'string' ? raw.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : '';
    return { state, ...(state !== 'off' && typeof raw.channelId === 'string' && /^\d{17,20}$/.test(raw.channelId) ? {channelId:raw.channelId} : {}),
      coverageSeconds:state === 'off' ? 0 : count(raw.coverageSeconds, 300),
      participants:state === 'off' ? 0 : Math.floor(count(raw.participants, 10)), model, message, usageSeconds:count(raw.usageSeconds, 600000) };
  } catch { return off; }
  finally { await file?.close(); }
}

export class DashboardService {
  private testing = false;
  private lastTest = 0;
  readonly localSpeech: LocalSpeechSetup;
  constructor(readonly settings = new SettingsStore(), readonly supervisor = new BotSupervisor(settings), private request = fetch) {
    this.localSpeech = new LocalSpeechSetup(settings.root);
  }
  localSpeechStatus() { return this.localSpeech.status(); }
  localSpeechSetup() { return this.localSpeech.begin(); }
  localSpeechCancel() { return this.localSpeech.cancel(); }
  save(body: unknown) { return this.supervisor.exclusive(() => this.settings.update(body)); }
  voiceSummaryStatus() { return readVoiceSummaryStatus(resolve(this.settings.root, 'data/voice-summary-status.json')); }
  async test(kind: string) {
    if (!['discord','ai','ai-response'].includes(kind)) throw new UserError('Unknown connection test.');
    if (this.testing || Date.now() - this.lastTest < 5000) throw new UserError('Wait a few seconds before another connection test.');
    this.testing = true; this.lastTest = Date.now();
    try {
      const { env } = this.settings.effective();
      if (kind === 'discord') {
        if (['DISCORD_BOT_TOKEN','DISCORD_APPLICATION_ID','DISCORD_GUILD_ID'].some(key => !env[key] || env[key]!.startsWith('replace-with-'))) throw new UserError('Save your Discord token, application ID, and server ID first.');
        const headers = { Authorization:`Bot ${env.DISCORD_BOT_TOKEN}` };
        const app = await this.request('https://discord.com/api/v10/oauth2/applications/@me',{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
        if (!app.ok) throw new UserError('Discord did not authorize this bot token.');
        const identity = await app.json() as { id?: string };
        if (identity.id !== env.DISCORD_APPLICATION_ID) throw new UserError('The bot token and application ID do not match.');
        const guild = await this.request(`https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}`,{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
        if (!guild.ok) throw new UserError('The bot cannot access the configured server. Install it in that server and check permissions.');
        await guild.body?.cancel();
        return {message:'Discord token, application identity, and server access verified. No commands were registered.'};
      }
      if (env.AI_PROVIDER === 'openai') {
        if (kind === 'ai-response') {
          await new OpenAIProvider(env.OPENAI_MODEL ?? '',env.OPENAI_API_KEY ?? '',reasoningEffort({CHATGPT_REASONING_EFFORT:env.OPENAI_REASONING_EFFORT}),false,this.request)
            .generate([{role:'user',content:'Reply with exactly: Connection verified.'}],AbortSignal.timeout(45000));
          return {message:'An API test response was received. This request may use API credit.'};
        }
        return {message:'API authentication and model catalog verified. Inference and optional features have not been tested.', models:await apiModels(env.OPENAI_API_KEY ?? '',this.request)};
      }
      if (kind === 'ai-response') throw new UserError('This action is available for API-key mode only.');
      if (!existsSync(resolve(env.AI_DATA_DIR || resolve(this.settings.root,'data/ai'),'chatgpt.dpapi'))) throw new UserError('No ChatGPT connection is saved. Stop the bot and connect your account.');
      return {message:'A protected ChatGPT connection exists. Live availability is shown by the running bot; no allowance was used.'};
    } finally { this.testing = false; }
  }
  async registerCommands() {
    return this.supervisor.exclusive(async () => {
      const { snowflake, required } = await import('../config.js');
      const { REST, Routes } = await import('discord.js');
      const { combinedCommands } = await import('../commands.js');
      const { env } = this.settings.effective();
      const application = snowflake('DISCORD_APPLICATION_ID',env), guild = snowflake('DISCORD_GUILD_ID',env);
      const rest = new REST({version:'10',timeout:10000}).setToken(required('DISCORD_BOT_TOKEN',env));
      const identity = await rest.get(Routes.oauth2CurrentApplication()) as {id:string};
      if (identity.id !== application) throw new UserError('The bot token and application ID do not match.');
      let completed = 0;
      try {
        for (const command of combinedCommands) { await rest.post(Routes.applicationGuildCommands(application,guild),{body:command}); completed++; }
      } catch { throw new UserError(`Registered ${completed} of ${combinedCommands.length} commands. Check the saved connection and retry; unrelated commands were preserved.`); }
      return {message:`Registered ${completed} commands. Unrelated commands were preserved.`};
    });
  }
}

export function emptyRequest(body: unknown) {
  if (!isRecord(body) || Object.keys(body).length) throw new UserError('This action does not accept arguments.');
}
