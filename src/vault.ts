import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { stateRoot } from './app-paths.js';
import { UserError, CredentialReadError } from './errors.js';
import { protect } from './secret-protection.js';
export { protect } from './secret-protection.js';

export const dataDir = resolve(process.env.AI_DATA_DIR || join(stateRoot, 'data/ai'));
const credentialPath = join(dataDir, 'chatgpt.dpapi');

export type Credential = {
  clientId: string; subject: string; accessToken: string; refreshToken?: string;
  idToken: string; scopes: string[]; expiresAt: number;
};

export function readCredential(): Credential | undefined {
  if (!existsSync(credentialPath)) return undefined;
  try { return JSON.parse(protect(readFileSync(credentialPath, 'utf8'), true)) as Credential; }
  catch { throw new CredentialReadError('Windows could not unlock the saved ChatGPT connection. It may belong to another Windows account or installation, or be damaged. Stop the bot, run npm run auth -- login under your current Windows account, then start the bot again.'); }
}

export function saveCredential(value: Credential) {
  mkdirSync(dataDir, { recursive: true });
  const temp = `${credentialPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, protect(JSON.stringify(value)), { mode: 0o600, flag: 'wx' });
    renameSync(temp, credentialPath);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

export function clearCredential() { if (existsSync(credentialPath)) unlinkSync(credentialPath); }

export function hostId(): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'host-id');
  if (!existsSync(path)) writeFileSync(path, `urn:uuid:${randomUUID()}`, { flag: 'wx', mode: 0o600 });
  return readFileSync(path, 'utf8').trim();
}

export function runtimeLock(directory = dataDir): () => void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'runtime.lock');
  try {
    const file = openSync(path, 'wx', 0o600);
    writeFileSync(file, String(process.pid));
    closeSync(file);
  } catch {
    throw new UserError('Another bot/auth process has the runtime lock. Stop it first. After a crash, confirm no bot/auth process is running before deleting data/runtime.lock.');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // If an operator replaced the file, an older process must not delete the new owner's lock.
    if (existsSync(path) && readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
  };
}
