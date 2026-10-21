import { UserError } from './errors.js';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export function reasoningEffort(env: NodeJS.ProcessEnv = process.env): ReasoningEffort | undefined {
  const value = env.CHATGPT_REASONING_EFFORT?.trim();
  if (!value) return undefined;
  if (!['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
    throw new UserError('CHATGPT_REASONING_EFFORT must be none, low, medium, high, xhigh, or max.');
  }
  return value as ReasoningEffort;
}

export function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim();
  if (!value) throw new UserError(`Set ${name} in your local .env file first.`);
  return value;
}

export function snowflake(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = required(name, env);
  if (!/^\d{17,20}$/.test(value)) throw new UserError(`${name} must be a Discord numeric ID.`);
  return value;
}

function ids(name: string, env: NodeJS.ProcessEnv): string[] {
  const values = (env[name] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (values.some(v => !/^\d{17,20}$/.test(v))) throw new UserError(`${name} must contain comma-separated Discord numeric IDs.`);
  return values;
}

export function botConfig(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.AI_PROVIDER?.trim() || 'chatgpt';
  if (provider !== 'chatgpt' && provider !== 'stub') throw new UserError('AI_PROVIDER must be chatgpt or stub.');
  const accessMode = env.ACCESS_MODE?.trim() || 'owner';
  if (accessMode !== 'owner' && accessMode !== 'server') throw new UserError('ACCESS_MODE must be owner or server.');
  return {
    token: required('DISCORD_BOT_TOKEN', env),
    guildId: snowflake('DISCORD_GUILD_ID', env),
    ownerId: snowflake('OWNER_DISCORD_ID', env),
    channels: ids('ALLOWED_CHANNEL_IDS', env), roles: ids('ALLOWED_ROLE_IDS', env), provider,
    model: env.CHATGPT_MODEL?.trim() || undefined,
    reasoningEffort: reasoningEffort(env),
    accessMode,
  };
}

export function authorized(config: Pick<ReturnType<typeof botConfig>, 'guildId' | 'ownerId' | 'channels' | 'roles'> & { accessMode?: string },
  member: { guildId: string | null; userId: string; channelId: string | null; roles: string[] }): boolean {
  return member.guildId === config.guildId && (config.accessMode === 'server' || member.userId === config.ownerId)
    && (!config.channels.length || config.channels.includes(member.channelId ?? ''))
    && (!config.roles.length || member.roles.some(role => config.roles.includes(role)));
}
