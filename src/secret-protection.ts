import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { UserError } from './errors.js';

export function protect(input: string, decrypt = false): string {
  if (process.platform !== 'win32') throw new UserError('Credential storage requires Windows and the account that saved it.');
  const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); `
    + (decrypt
      ? '$bytes=[Convert]::FromBase64String($value); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))'
      : '$bytes=[Text.Encoding]::UTF8.GetBytes($value); $cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($cipher))');
  try {
    return execFileSync(resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { input, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { throw new UserError('Protected credential storage failed. Use the Windows account that saved the credentials.'); }
}
