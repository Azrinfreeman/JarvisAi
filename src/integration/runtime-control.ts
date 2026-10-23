import { createServer, createConnection } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { protect } from '../secret-protection.js';
import { projectRoot, isRecord } from '../settings.js';
import { fileURLToPath } from 'node:url';
import { resourceRoot, runtimeEntry } from '../app-paths.js';
import { UserError } from '../errors.js';

export type ProcessIdentity = { pid: number; parentPid: number; created: string; executable: string; directory: string; commandLine: string };
export type RuntimeIdentity = { pid: number; created: string; instance: string; root: string; revision: string; workerPid?: number; build?: {protocol:number;resources:string;runtime:string} };
const canonical = (path: string) => resolve(path).replace(/[\\/]+$/, '').toLowerCase();
export function ownsProcess(info: ProcessIdentity, root: string, entry: string) {
  const args = [...info.commandLine.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]!);
  if (args.some(arg => ['-e','--eval','-p','--print','--check'].includes(arg))) return false;
  const expected = canonical(runtimeEntry(root,entry));
  const matchingEntry = args.some(arg => {
    try { return canonical(arg.startsWith('file:') ? fileURLToPath(arg) : resolve(root,arg)) === expected; } catch { return false; }
  });
  return canonical(info.directory) === canonical(root) && canonical(info.executable) === canonical(process.execPath)
    && matchingEntry && typeof info.created === 'string' && !!info.created;
}
let inspector: ChildProcessWithoutNullStreams | undefined;
const inspections = new Map<string, { pid:number; resolve:(value:ProcessIdentity|null)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> }>();
function metadataError() { return new UserError('Cannot verify bot ownership. Check local process access before using Start or Stop.'); }
function metadataWorker() {
  if (inspector) return inspector;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','TEMP','TMP','USERPROFILE','LOCALAPPDATA']) if (process.env[key] !== undefined) env[key]=process.env[key];
  const child = spawn(resolve(process.env.SystemRoot || 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile','-NonInteractive','-File',join(resourceRoot,'scripts/inspect-runtime.ps1'),'-Serve'],
    { windowsHide:true, env, stdio:'pipe' });
  inspector = child;
  child.unref();
  for (const stream of [child.stdin,child.stdout,child.stderr]) (stream as typeof stream & {unref?:()=>void}).unref?.();
  let buffer='';
  const failed = () => {
    if (inspector !== child) return;
    inspector=undefined;
    for (const pending of inspections.values()) { clearTimeout(pending.timer); pending.reject(metadataError()); }
    inspections.clear();
  };
  child.on('error',failed); child.on('exit',failed); child.stdin.on('error',failed);
  child.stderr.resume();
  child.stdout.on('data',chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 262144) { child.stdin.end(); failed(); return; }
    let end: number;
    while ((end=buffer.indexOf('\n')) !== -1) {
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      try {
        const reply=JSON.parse(line);const pending=inspections.get(reply.id);
        if (!pending) continue;
        inspections.delete(reply.id);clearTimeout(pending.timer);
        const value=reply.value;
        if (reply.failed || value !== null && (!isRecord(value) || value.pid !== pending.pid || typeof value.parentPid !== 'number'
          || !['created','executable','directory','commandLine'].every(key => typeof value[key] === 'string'))) pending.reject(metadataError());
        else pending.resolve(value);
      } catch { child.stdin.end(); failed(); }
    }
  });
  return child;
}
export async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new UserError('Invalid runtime ownership record.');
  if (process.platform !== 'win32') throw new UserError('Bot lifecycle controls currently require Windows.');
  if (inspections.size >= 32) throw metadataError();
  const child=metadataWorker();const id=randomBytes(16).toString('hex');
  return new Promise((resolve,reject) => {
    const timer=setTimeout(() => { inspections.delete(id);reject(metadataError()); },40000);
    inspections.set(id,{pid,resolve,reject,timer});
    child.stdin.write(JSON.stringify({id,pid})+'\n',error => {
      if (error) { clearTimeout(timer); inspections.delete(id); reject(metadataError()); }
    });
  });
}

export const pipePath = (root: string) => `\\\\.\\pipe\\rainbot-${createHash('sha256').update(canonical(root)).digest('hex').slice(0,32)}`;
const descriptorPath = (root: string) => join(root, 'data/dashboard/runtime.json');
export function controlSecret(root: string, create = false, codec = protect): string {
  const path = join(root, 'data/dashboard/control.dpapi');
  if (create && !existsSync(path)) {
    mkdirSync(join(root,'data/dashboard'), { recursive:true });
    const value = codec(randomBytes(32).toString('hex'));
    try { writeFileSync(path, value, { flag:'wx', mode:0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  try {
    const value = codec(readFileSync(path,'utf8'), true);
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error();
    return value;
  } catch { throw new UserError('Unable to read the protected runtime control credential. Use the account that started the bot.'); }
}
function sign(value: unknown, secret: string) { return createHmac('sha256',secret).update(JSON.stringify(value)).digest('hex'); }
function signed(value: unknown, mac: unknown, secret: string) {
  const expected = sign(value, secret);
  return typeof mac === 'string' && /^[a-f\d]{64}$/.test(mac) && timingSafeEqual(Buffer.from(mac),Buffer.from(expected));
}
export function readRuntimeIdentity(root: string): RuntimeIdentity | undefined {
  const path = descriptorPath(root);
  if (!existsSync(path)) return;
  try {
    const value = JSON.parse(readFileSync(path,'utf8'));
    if (!isRecord(value) || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.created !== 'string'
      || typeof value.instance !== 'string' || typeof value.root !== 'string' || canonical(value.root) !== canonical(root)
      || typeof value.revision !== 'string'
      || value.build !== undefined && (!isRecord(value.build) || !Number.isSafeInteger(value.build.protocol) || Number(value.build.protocol) < 1
        || typeof value.build.resources !== 'string' || !isAbsolute(value.build.resources)
        || typeof value.build.runtime !== 'string' || !isAbsolute(value.build.runtime))) throw new Error();
    return value as RuntimeIdentity;
  } catch { throw new UserError('The runtime identity record is unreadable. Inspect ownership before recovery.'); }
}

export async function startRuntimeControl(options: { root?: string; revision: string; workerPid: () => number | undefined; shutdown: () => Promise<void>; inspect?: typeof inspectProcess; secret?: string }) {
  const root = options.root ?? projectRoot;
  const own = await (options.inspect ?? inspectProcess)(process.pid);
  if (!own) throw new UserError('Cannot inspect the bot process for local control.');
  const secret = options.secret ?? controlSecret(root, true);
  const identity: RuntimeIdentity = { pid:process.pid, created:own.created, instance:randomUUID(), root:resolve(root), revision:options.revision,
    ...(process.env.RAINBOT_RESOURCE_ROOT ? {build:{protocol:1 as const,resources:resourceRoot,runtime:process.execPath}} : {}) };
  const seen = new Set<string>();
  const server = createServer(socket => {
    socket.setTimeout(4000, () => socket.destroy());
    socket.on('error', () => {});
    let buffer = ''; let handled = false;
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 4096) { socket.destroy(); return; }
      if (!buffer.includes('\n') || handled) return;
      handled = true;
      try {
        const { value, mac } = JSON.parse(buffer.slice(0,buffer.indexOf('\n')));
        if (!isRecord(value) || !signed(value,mac,secret) || !['identity','shutdown'].includes(String(value.action))
          || value.instance !== identity.instance || typeof value.challenge !== 'string' || !/^[a-f0-9]{32}$/.test(value.challenge)
          || typeof value.at !== 'number' || Math.abs(Date.now()-value.at) > 10000 || seen.has(value.challenge)) throw new Error();
        seen.add(value.challenge); if (seen.size > 1000) seen.delete(seen.values().next().value!);
        const result = { ...identity, workerPid:options.workerPid() ?? null, challenge:value.challenge, accepted:true };
        socket.end(JSON.stringify({ value:result, mac:sign(result,secret) })+'\n', () => {
          if (value.action === 'shutdown') void options.shutdown().catch(() => console.error('Graceful shutdown did not complete. Inspect the remaining owned process before recovery.'));
        });
      } catch { socket.destroy(); }
    });
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => { server.once('error',reject); server.listen(pipePath(root),resolve); });
  // A pipe/server error must never crash the Discord runtime.
  server.on('error', () => console.error('The local runtime control channel is unavailable.'));
  const path = descriptorPath(root); const temp = path+'.'+identity.instance+'.tmp';
  try { mkdirSync(join(root,'data/dashboard'), { recursive:true }); writeFileSync(temp,JSON.stringify(identity),{mode:0o600,flag:'wx'}); renameSync(temp,path); }
  catch { server.close(); if (existsSync(temp)) unlinkSync(temp); throw new UserError('Could not save the runtime control identity.'); }
  return { identity, close() {
    server.close();
    try { if (readRuntimeIdentity(root)?.instance === identity.instance) unlinkSync(path); } catch {}
  } };
}

export function runtimeRequest(root: string, identity: RuntimeIdentity, action: 'identity' | 'shutdown', secret = controlSecret(root)): Promise<RuntimeIdentity & { workerPid: number | null }> {
  return new Promise((resolve, reject) => {
    const value = { action, instance:identity.instance, challenge:randomBytes(16).toString('hex'), at:Date.now() };
    const socket = createConnection(pipePath(root));
    const fail = () => { socket.destroy(); reject(new UserError('The verified runtime control channel is unavailable. No process was terminated.')); };
    socket.setTimeout(5000,fail); socket.on('error',fail);
    socket.on('connect',() => socket.write(JSON.stringify({ value, mac:sign(value,secret) })+'\n'));
    let buffer = '';
    socket.on('data',chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 8192) { fail(); return; }
      if (!buffer.includes('\n')) return;
      try {
        const result = JSON.parse(buffer.slice(0,buffer.indexOf('\n')));
        if (!signed(result.value,result.mac,secret) || result.value.challenge !== value.challenge || result.value.instance !== identity.instance
          || result.value.pid !== identity.pid || result.value.created !== identity.created || result.value.root !== identity.root
          || result.value.accepted !== true || !(result.value.workerPid === null || Number.isSafeInteger(result.value.workerPid) && result.value.workerPid > 0)) throw new Error();
        socket.destroy(); resolve(result.value);
      } catch { fail(); }
    });
    socket.on('end',() => { if (!buffer.includes('\n')) fail(); });
  });
}
