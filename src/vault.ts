import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './errors.js';

export const dataDir = resolve(process.env.AI_DATA_DIR || fileURLToPath(new URL('../data/ai/', import.meta.url)));
const credentialPath = join(dataDir, 'chatgpt.dpapi');

export type Credential = {
  clientId: string; subject: string; accessToken: string; refreshToken?: string;
  idToken: string; scopes: string[]; expiresAt: number;
};

export function protect(input: string, decrypt = false): string {
  if (process.platform !== 'win32') throw new UserError('This trial stores credentials with Windows DPAPI and must run on Windows.');
  // The secret travels through stdin, never a command argument or a temporary plaintext file.
  const script = `$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; `
    + `$value = [Console]::In.ReadToEnd(); `
    + (decrypt
      ? `$bytes = [Convert]::FromBase64String($value); $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))`
      : `$bytes = [Text.Encoding]::UTF8.GetBytes($value); $cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($cipher))`);
  try {
    return execFileSync(resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { input, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { throw new UserError('Protected credential storage failed. Use the same Windows account that saved the credentials.'); }
}

export function readCredential(): Credential | undefined {
  if (!existsSync(credentialPath)) return undefined;
  try { return JSON.parse(protect(readFileSync(credentialPath, 'utf8'), true)) as Credential; }
  catch { throw new UserError('Unable to read the protected ChatGPT connection. Reconnect with your Windows account.'); }
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
