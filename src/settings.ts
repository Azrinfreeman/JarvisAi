import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stateRoot, defaultAssets, runtimePathKeys } from './app-paths.js';
import { parseEnv } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { protect } from './secret-protection.js';
import { UserError } from './errors.js';

export const projectRoot = stateRoot;
export const valueKeys = ['DISCORD_APPLICATION_ID','DISCORD_GUILD_ID','OWNER_DISCORD_ID','ACCESS_MODE',
  'ALLOWED_CHANNEL_IDS','ALLOWED_ROLE_IDS','CONTROLLER_ROLE_IDS','RAIN_VOLUME','AI_PROVIDER',
  'CHATGPT_MODEL','CHATGPT_REASONING_EFFORT','OPENAI_MODEL','OPENAI_REASONING_EFFORT','OPENAI_WEB_SEARCH'] as const;
export const secretKeys = ['DISCORD_BOT_TOKEN','OPENAI_API_KEY'] as const;
const pathKeys = ['AI_DATA_DIR','SLEEP_DATABASE_PATH','SLEEP_ASSET_DIR','RAIN_ASSET_PATH','SUNNY_ASSET_PATH'] as const;
export type ValueKey = typeof valueKeys[number];
export type SecretKey = typeof secretKeys[number];
export type Values = Record<ValueKey, string>;
type Document = { version: 1; revision: string; values: Partial<Values>; secretsFile: string; removed: SecretKey[] };
export type SettingsUpdate = { revision: string; values: Partial<Values>; secrets?: Partial<Record<SecretKey, { action: 'remove' } | { action: 'replace'; value: string }>> };
const defaults: Values = { DISCORD_APPLICATION_ID:'', DISCORD_GUILD_ID:'', OWNER_DISCORD_ID:'', ACCESS_MODE:'owner',
  ALLOWED_CHANNEL_IDS:'', ALLOWED_ROLE_IDS:'', CONTROLLER_ROLE_IDS:'', RAIN_VOLUME:'0.2', AI_PROVIDER:'chatgpt',
  CHATGPT_MODEL:'', CHATGPT_REASONING_EFFORT:'', OPENAI_MODEL:'', OPENAI_REASONING_EFFORT:'', OPENAI_WEB_SEARCH:'false' };
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ownKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));

export function validateValues(values: Partial<Values>) {
  if (!isRecord(values) || !ownKeys(values, valueKeys)) throw new UserError('Unknown settings field.');
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value.length > 4000 || /[\x00-\x1f\x7f]/.test(value)) throw new UserError(`Invalid ${key} value.`);
    if (['DISCORD_APPLICATION_ID','DISCORD_GUILD_ID','OWNER_DISCORD_ID'].includes(key) && value && !/^\d{17,20}$/.test(value)) throw new UserError(`${key} must be a Discord numeric ID.`);
    if (key.endsWith('_IDS') && value && value.split(',').some(id => !/^\d{17,20}$/.test(id.trim()))) throw new UserError(`${key} must contain comma-separated Discord IDs.`);
    if (key === 'ACCESS_MODE' && !['owner','server'].includes(value)) throw new UserError('Choose an access mode.');
    if (key === 'AI_PROVIDER' && !['chatgpt','openai','stub'].includes(value)) throw new UserError('Choose a supported AI provider.');
    if (key === 'RAIN_VOLUME' && (!value || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1)) throw new UserError('Volume must be between 0 and 100 percent.');
    if (key.endsWith('REASONING_EFFORT') && value && !['none','low','medium','high','xhigh','max'].includes(value)) throw new UserError('Choose a supported reasoning setting.');
    if (key.endsWith('_MODEL') && value && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value)) throw new UserError('Enter a valid model identifier.');
    if (key === 'OPENAI_WEB_SEARCH' && !['true','false'].includes(value)) throw new UserError('Invalid web search setting.');
  }
}

export class SettingsStore {
  readonly directory: string;
  credentialsUnreadable = false;
  constructor(readonly root = projectRoot, private inherited: NodeJS.ProcessEnv = { ...process.env }, private codec = protect) {
    this.directory = join(root, 'data/dashboard');
  }
  private legacy(): NodeJS.ProcessEnv {
    try { return parseEnv(readFileSync(join(this.root, '.env'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new UserError('Unable to read legacy configuration.'); }
  }
  private document(): Document | undefined {
    const path = join(this.directory, 'settings.json');
    if (!existsSync(path)) return;
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(doc) || !ownKeys(doc, ['version','revision','values','secretsFile','removed']) || doc.version !== 1
        || typeof doc.revision !== 'string' || !/^[a-f\d-]{36}$/.test(doc.revision)
        || doc.secretsFile !== `secrets-${doc.revision}.dpapi` || !Array.isArray(doc.removed)
        || doc.removed.some(key => !secretKeys.includes(key))) throw new Error();
      validateValues(doc.values as Partial<Values>);
      return doc as Document;
    } catch { throw new UserError('Saved settings are unreadable. Restore settings.previous.json before starting the bot.'); }
  }
  private secrets(doc?: Document): Partial<Record<SecretKey, string>> {
    if (!doc) return {};
    try {
      const secrets = JSON.parse(this.codec(readFileSync(join(this.directory, doc.secretsFile), 'utf8'), true));
      if (!isRecord(secrets) || !ownKeys(secrets, secretKeys) || Object.values(secrets).some(value => typeof value !== 'string' || !value)) throw new Error();
      return secrets;
    } catch {
      // Saved credentials are bound to the Windows account that wrote them. Fall back to the environment/.env
      // instead of blocking startup; missing() still reports anything that cannot be found there.
      this.credentialsUnreadable = true;
      return {};
    }
  }
  effective() {
    const doc = this.document();
    const legacy = this.legacy();
    // Preserve legacy path/audio options, but inherited environment remains authoritative.
    const env: NodeJS.ProcessEnv = { ...legacy, ...defaults, ...doc?.values };
    for (const key of valueKeys) env[key] = (this.inherited[key] ?? doc?.values[key] ?? legacy[key] ?? defaults[key]).trim();
    this.credentialsUnreadable = false;
    const secrets = this.secrets(doc);
    if (this.credentialsUnreadable) console.warn('Saved credentials cannot be decrypted on this PC/account; using .env or environment variables. Re-enter them in Settings to save them for this account.');
    for (const key of secretKeys) {
      env[key] = this.inherited[key] ?? (key === 'DISCORD_BOT_TOKEN' ? this.inherited.DISCORD_TOKEN : undefined) ?? (doc?.removed.includes(key) ? undefined : secrets[key] ?? legacy[key]);
    }
    if (!env.DISCORD_BOT_TOKEN && !doc?.removed.includes('DISCORD_BOT_TOKEN')) env.DISCORD_BOT_TOKEN = this.inherited.DISCORD_TOKEN ?? legacy.DISCORD_TOKEN;
    for (const [key, value] of Object.entries(this.inherited)) if (![...valueKeys, ...secretKeys].includes(key as ValueKey)) env[key] = value;
    delete env.DISCORD_TOKEN;
    for (const key of pathKeys) if (env[key]) env[key] = resolve(this.root,env[key]!);
    if (process.env.RAINBOT_RESOURCE_ROOT && !env.SLEEP_ASSET_DIR) env.SLEEP_ASSET_DIR = defaultAssets;
    // Hash non-secret effective settings and credential-source revisions, never raw secrets.
    const legacyPath = join(this.root,'.env');
    const legacyFile = existsSync(legacyPath) ? statSync(legacyPath) : undefined;
    const signature = JSON.stringify([...valueKeys.map(key => [key, env[key]]), ...pathKeys.map(key => [key,env[key]]),
      ...secretKeys.map(key => [key, !!env[key]]), ['legacyFile',legacyFile ? [legacyFile.size,legacyFile.mtimeMs] : null]]);
    const revision = createHash('sha256').update(`${doc?.revision ?? 'legacy'}:${signature}`).digest('hex');
    return { env, revision, savedRevision: doc?.revision ?? 'legacy' };
  }
  view() {
    const { env, revision, savedRevision } = this.effective();
    const values = Object.fromEntries(valueKeys.map(key => [key, env[key] ?? ''])) as Values;
    if (values.RAIN_VOLUME && Number.isFinite(Number(values.RAIN_VOLUME))) values.RAIN_VOLUME=String(Number(values.RAIN_VOLUME));
    return { values, revision: savedRevision, effectiveRevision: revision,
      secrets: Object.fromEntries(secretKeys.map(key => [key, !!env[key] && !env[key]!.startsWith('replace-with-')])),
      overridden: [...valueKeys, ...secretKeys].filter(key => this.inherited[key] !== undefined || key === 'DISCORD_BOT_TOKEN' && this.inherited.DISCORD_TOKEN !== undefined),
      missing: this.missing(env), credentialsUnreadable: this.credentialsUnreadable };
  }
  missing(env = this.effective().env) {
    const required = ['DISCORD_BOT_TOKEN','DISCORD_APPLICATION_ID','DISCORD_GUILD_ID','OWNER_DISCORD_ID'];
    if (env.AI_PROVIDER === 'openai') required.push('OPENAI_API_KEY','OPENAI_MODEL');
    return required.filter(key => !env[key]?.trim() || env[key]!.startsWith('replace-with-'));
  }
  update(input: unknown) {
    if (!isRecord(input) || !ownKeys(input, ['revision','values','secrets']) || typeof input.revision !== 'string'
      || !isRecord(input.values) || (input.secrets !== undefined && !isRecord(input.secrets))) throw new UserError('Invalid settings request.');
    validateValues(input.values);
    const changes = input.secrets ?? {};
    if (!ownKeys(changes, secretKeys)) throw new UserError('Unknown credential field.');
    mkdirSync(this.directory, { recursive: true });
    const lock = join(this.directory, 'settings.lock');
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); } catch { throw new UserError('Settings are being saved. Try again shortly.'); }
    try {
      const doc = this.document();
      if (input.revision !== (doc?.revision ?? 'legacy')) throw new UserError('Settings changed in another window. Reload before saving.');
      const overridden = this.view().overridden;
      for (const key of [...Object.keys(input.values), ...Object.keys(changes)]) if (overridden.includes(key as ValueKey)) throw new UserError(`${key} is managed by the deployment environment.`);
      const values = { ...doc?.values, ...input.values };
      const secrets = this.secrets(doc);
      const removed = new Set(doc?.removed ?? []);
      for (const [key, change] of Object.entries(changes)) {
        if (!isRecord(change) || !ownKeys(change, ['action','value'])) throw new UserError('Invalid credential change.');
        if (change.action === 'remove' && change.value === undefined) { delete secrets[key as SecretKey]; removed.add(key as SecretKey); }
        else if (change.action === 'replace' && typeof change.value === 'string' && change.value.trim().length >= 8 && change.value.length <= 4096 && !/[\s\x00-\x1f]/.test(change.value)) {
          secrets[key as SecretKey] = change.value; removed.delete(key as SecretKey);
        } else throw new UserError('Enter a valid credential or choose Remove.');
      }
      const revision = randomUUID();
      const next: Document = { version: 1, revision, values, secretsFile: `secrets-${revision}.dpapi`, removed: [...removed] };
      writeFileSync(join(this.directory, next.secretsFile), this.codec(JSON.stringify(secrets)), { mode: 0o600, flag:'wx' });
      const path = join(this.directory, 'settings.json');
      if (doc) this.atomic(join(this.directory, 'settings.previous.json'), JSON.stringify(doc, null, 2));
      this.atomic(path, JSON.stringify(next, null, 2));
      return this.view();
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  private atomic(path: string, value: string) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, value, { mode: 0o600, flag:'wx' }); renameSync(temp, path); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  launchEnvironment() {
    const inherited: NodeJS.ProcessEnv = {};
    const allowed = ['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'];
    for (const key of [...allowed, ...runtimePathKeys, ...valueKeys, ...secretKeys, 'DISCORD_TOKEN','AI_DATA_DIR','SLEEP_DATABASE_PATH','SLEEP_ASSET_DIR','RAIN_ASSET_PATH','SUNNY_ASSET_PATH','RECONNECT_MIN_MS','RECONNECT_MAX_MS']) {
      if (this.inherited[key] !== undefined) inherited[key] = this.inherited[key];
    }
    return inherited;
  }
}
