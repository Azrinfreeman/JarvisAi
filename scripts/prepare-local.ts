// Local configuration preparation only; never prints or decrypts credentials.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
const ai = parseEnv(readFileSync(resolve('../.env'),'utf8'));
const sleep = parseEnv(readFileSync(resolve('../../DiscordSleepBot/.env'),'utf8'));
if (existsSync('.env')) throw new Error('Local .env already exists; review it instead of overwriting it.');
const keys = ['DISCORD_GUILD_ID','OWNER_DISCORD_ID','ACCESS_MODE','ALLOWED_CHANNEL_IDS','ALLOWED_ROLE_IDS','AI_PROVIDER','CHATGPT_MODEL','CHATGPT_REASONING_EFFORT'];
const env: Record<string,string> = {
  DISCORD_BOT_TOKEN:sleep.DISCORD_TOKEN!,DISCORD_APPLICATION_ID:sleep.DISCORD_APPLICATION_ID!,
  ...Object.fromEntries(keys.map(key=>[key,ai[key] ?? ''])),
  ...Object.fromEntries(['CONTROLLER_ROLE_IDS','RAIN_VOLUME','RECONNECT_MIN_MS','RECONNECT_MAX_MS'].filter(key=>sleep[key]!==undefined).map(key=>[key,sleep[key]!])),
};
if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_APPLICATION_ID || !env.DISCORD_GUILD_ID) throw new Error('Original configuration is incomplete.');
for (const value of Object.values(env)) if (/[\r\n"\\]/.test(value)) throw new Error('Unsupported configuration characters; review locally.');
writeFileSync('.env',Object.entries(env).map(([key,value])=>`${key}="${value}"`).join('\n')+'\n',{flag:'wx',mode:0o600});
console.log('Prepared private combined configuration using the sleep bot identity and existing AI settings. No credentials were displayed.');
