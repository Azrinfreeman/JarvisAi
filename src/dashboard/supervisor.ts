import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SettingsStore, valueKeys, validateValues, isRecord } from '../settings.js';
import { botConfig } from '../config.js';
import { UserError, safeError } from '../errors.js';
import { runtimeEntry, runtimeArguments, defaultAssets, resourceRoot } from '../app-paths.js';
import { inspectProcess, ownsProcess, readRuntimeIdentity, runtimeRequest, controlSecret, type RuntimeIdentity } from '../integration/runtime-control.js';

export type Management = { state: 'stopped' | 'running' | 'starting' | 'stopping' | 'external' | 'blocked'; message: string; restartRequired: boolean; missing: string[]; revision?: string };
type Operation = { id: string; action: 'start' | 'stop'; status: 'pending' | 'completed' | 'failed'; message: string };
type Dependencies = { inspect: typeof inspectProcess; request: typeof runtimeRequest; launch: (env: NodeJS.ProcessEnv) => Promise<number>; timeout: number; interval: number };

export class BotSupervisor {
  get busy() { return this.operation?.status === 'pending'; }
  private operation?: Operation;
  private cached?: { at: number; promise: Promise<Management> };
  private deps: Dependencies;
  private controlKey?: string;
  constructor(readonly settings: SettingsStore, dependencies: Partial<Dependencies> = {}) {
    this.deps = { inspect:inspectProcess, request:(root,identity,action) => runtimeRequest(root,identity,action,this.controlKey ??= controlSecret(root)), timeout:45000, interval:1000,
      launch: env => this.launch(env), ...dependencies };
  }
  private lockPaths(env: NodeJS.ProcessEnv) {
    const frontend = join(this.settings.root, 'data/frontend');
    const locks = existsSync(frontend) ? readdirSync(frontend,{withFileTypes:true}).filter(item => item.isDirectory()).map(item => join(frontend,item.name,'runtime.lock')).filter(existsSync) : [];
    const ai = join(resolve(env.AI_DATA_DIR || join(this.settings.root,'data/ai')), 'runtime.lock');
    if (existsSync(ai)) locks.push(ai);
    const legacy = join(this.settings.root,'data/runtime.lock');
    if (existsSync(legacy)) locks.push(legacy);
    return locks;
  }
  async clearStaleLocks() {
    if (this.busy) throw new UserError('Wait for the current bot operation to finish before clearing locks.');
    return this.exclusive(async () => {
      const identity = readRuntimeIdentity(this.settings.root);
      const launched = this.launchRecord();
      for (const pid of [identity?.pid,identity?.workerPid,launched?.pid]) {
        if (pid !== undefined && await this.deps.inspect(pid) !== null) throw new UserError('A bot process is still running. Stop it before clearing locks.');
      }
      const locks = this.lockPaths(this.settings.effective().env).map(path => {
        const contents = readFileSync(path,'utf8');
        const pid = Number(contents.trim());
        if (!/^\d+$/.test(contents.trim()) || !Number.isSafeInteger(pid) || pid <= 0) throw new UserError('A runtime lock has an invalid owner. Inspect it manually before recovery.');
        return {path,contents,pid};
      });
      for (const lock of locks) {
        if (await this.deps.inspect(lock.pid) !== null) throw new UserError('A bot or authentication process still owns a lock. Stop it before clearing locks.');
      }
      for (const lock of locks) {
        if (readFileSync(lock.path,'utf8') !== lock.contents) throw new UserError('A runtime lock changed during recovery. Check status and try again.');
      }
      for (const lock of locks) unlinkSync(lock.path);
      return {message:locks.length ? `Cleared ${locks.length} stale runtime lock(s). You can now start the bot again.` : 'No stale runtime locks were found.', cleared:locks.length};
    });
  }
  private launchRecord() {
    const path = join(this.settings.directory,'supervisor.json');
    if (!existsSync(path)) return;
    try {
      const record = JSON.parse(readFileSync(path,'utf8'));
      if (!isRecord(record) || !Number.isSafeInteger(record.pid) || record.root !== this.settings.root) throw new Error();
      return record as { pid: number; root: string };
    } catch { throw new UserError('The supervisor ownership record is unreadable. Inspect the installation before starting another process.'); }
  }
  private async verify(identity: RuntimeIdentity) {
    const info = await this.deps.inspect(identity.pid);
    if (!info || info.created !== identity.created || !ownsProcess(info,this.settings.root,'src/main.ts')) throw new UserError('Cannot verify bot ownership. No process was changed.');
    const frontend = join(this.settings.root,'data/frontend');
    const locks = existsSync(frontend) ? readdirSync(frontend,{withFileTypes:true}).filter(item => item.isDirectory()).map(item => join(frontend,item.name,'runtime.lock')).filter(existsSync) : [];
    if (locks.length !== 1 || readFileSync(locks[0]!,'utf8').trim() !== String(info.pid)) throw new UserError('The Discord runtime lock does not match the control identity.');
    const current = await this.deps.request(this.settings.root,identity,'identity');
    let workerCreated: string | undefined;
    if (current.workerPid !== null) {
      const worker = await this.deps.inspect(current.workerPid);
      if (!worker || worker.parentPid !== info.pid || !ownsProcess(worker,this.settings.root,'src/integration/ai-worker.ts')) throw new UserError('Cannot verify the AI worker belongs to this bot.');
      workerCreated = worker.created;
    }
    return { ...current, workerCreated };
  }
  status(force = false): Promise<Management> {
    if (!force && this.cached && Date.now()-this.cached.at < 3000) return this.cached.promise;
    const promise = this.readStatus(); this.cached = { at:Date.now(), promise }; return promise;
  }
  private async readStatus(): Promise<Management> {
    try {
      const { env, revision } = this.settings.effective();
      const missing = this.settings.missing(env);
      if (this.operation?.status === 'pending') return { state:this.operation.action === 'start' ? 'starting' : 'stopping', message:this.operation.message, restartRequired:false, missing };
      const identity = readRuntimeIdentity(this.settings.root);
      if (identity) {
        const info = await this.deps.inspect(identity.pid);
        if (info) {
          if (identity.build && (identity.build.protocol !== 1 || resolve(identity.build.resources).toLowerCase() !== resolve(resourceRoot).toLowerCase()
            || resolve(identity.build.runtime).toLowerCase() !== resolve(process.execPath).toLowerCase())) {
            return {state:'external',message:'A bot from another app version is running. Open that version and stop the bot before updating.',restartRequired:false,missing};
          }
          const current = await this.verify(identity);
          return { state:'running', message:'The companion process is running.', restartRequired:current.revision !== revision, revision:current.revision, missing };
        }
      }
      const locks = this.lockPaths(env);
      if (locks.length) {
        for (const path of locks) {
          const pid = Number(readFileSync(path,'utf8').trim());
          const process = await this.deps.inspect(pid);
          if (process) return { state:'external', message:'An existing bot or authentication process owns a runtime lock. Stop it from its terminal before using dashboard controls.', restartRequired:false, missing };
        }
        return { state:'blocked', message:'A stale runtime lock is blocking startup. Use Clear stale locks, then start the bot again.', restartRequired:false, missing };
      }
      const launched = this.launchRecord();
      if (launched && await this.deps.inspect(launched.pid)) return { state:'blocked', message:'A previous launch is still running without a verified control channel. Inspect it before retrying.', restartRequired:false, missing };
      return { state:'stopped', message:'The companion is stopped.', restartRequired:false, missing };
    } catch(error) { return { state:'blocked', message:safeError(error), restartRequired:false, missing:[] }; }
  }
  getOperation(id: string) { return this.operation?.id === id ? { ...this.operation } : undefined; }
  async exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const path = join(this.settings.directory,'supervisor.lock');
    mkdirSync(this.settings.directory,{recursive:true});
    const owner = randomUUID(); let fd: number;
    try { fd = openSync(path,'wx',0o600); }
    catch {
      // This lock owns dashboard operations only. Bot/auth locks are never recovered here.
      try {
        const previous = readFileSync(path,'utf8'); const record = JSON.parse(previous);
        if (!Number.isSafeInteger(record.pid) || record.pid === process.pid || await this.deps.inspect(record.pid) !== null || readFileSync(path,'utf8') !== previous) throw new Error();
        unlinkSync(path); fd = openSync(path,'wx',0o600);
      } catch { throw new UserError('Another dashboard operation is in progress. Wait for it to finish.'); }
    }
    try { writeFileSync(fd,JSON.stringify({pid:process.pid,owner})); return await work(); }
    finally { closeSync(fd); try { if (JSON.parse(readFileSync(path,'utf8')).owner === owner) unlinkSync(path); } catch {} this.cached = undefined; }
  }
  begin(action: 'start' | 'stop') {
    if (this.operation?.status === 'pending') return { ...this.operation };
    const operation: Operation = { id:randomUUID(), action, status:'pending', message:action === 'start' ? 'Verifying configuration and runtime ownership…' : 'Verifying the companion before shutdown…' };
    this.operation = operation; this.cached = undefined;
    void this.exclusive(async () => {
      if (action === 'start') await this.start(operation); else await this.stop(operation);
      operation.status = 'completed'; operation.message = action === 'start' ? 'The companion started. Discord and AI readiness are shown separately.' : 'The companion and its AI worker stopped.';
    }).catch(error => { operation.status = 'failed'; operation.message = safeError(error); this.cached = undefined; });
    return { ...operation };
  }
  private async start(operation: Operation) {
    if (existsSync(join(this.settings.root,'data/import.pending'))) throw new UserError('An interrupted import needs verified recovery before starting.');
    const { env } = this.settings.effective();
    if (this.settings.missing(env).length) throw new UserError('Complete the required fields in Settings before starting the bot.');
    validateValues(Object.fromEntries(valueKeys.map(key => [key,env[key] ?? ''])));
    botConfig(env);
    if (this.lockPaths(env).length) throw new UserError('A runtime lock already exists. Verify the current bot/auth process or follow the recovery instructions before starting.');
    const previous = readRuntimeIdentity(this.settings.root);
    if (previous && await this.deps.inspect(previous.pid)) throw new UserError('A companion process already exists. No duplicate was started.');
    const previousLaunch = this.launchRecord();
    if (previousLaunch && await this.deps.inspect(previousLaunch.pid)) throw new UserError('A previous launch is still running. Inspect it before retrying; no duplicate was started.');
    const assets = resolve(env.SLEEP_ASSET_DIR || (process.env.RAINBOT_RESOURCE_ROOT ? defaultAssets : join(this.settings.root,'assets')));
    for (const key of ['RAIN_ASSET_PATH','SUNNY_ASSET_PATH']) if (env[key] && !existsSync(resolve(env[key]!))) throw new UserError('A configured ambience asset is missing. Check the deployment paths.');
    for (const file of ['rain-loop.pcm','rain-soft-loop.pcm','rain-indoor-loop.pcm','rain-glass-loop.pcm','rain-heavy-loop.pcm','sunny-birds-loop.pcm','thunder-distant-a.pcm','thunder-distant-b.pcm','thunder-distant-c.pcm','thunder-distant-d.pcm']) {
      if (!existsSync(join(assets,file))) throw new UserError('Required ambience assets are missing. Restore the bundled assets before starting.');
    }
    const pid = await this.deps.launch(this.settings.launchEnvironment());
    writeFileSync(join(this.settings.directory,'supervisor.json'),JSON.stringify({pid,root:this.settings.root,launching:true}),{mode:0o600});
    operation.message = 'Starting the companion and waiting for its verified control channel…';
    const until = Date.now()+this.deps.timeout;
    while (Date.now() < until) {
      const identity = readRuntimeIdentity(this.settings.root);
      if (identity?.pid === pid) {
        try {
          const current = await this.verify(identity);
          writeFileSync(join(this.settings.directory,'supervisor.json'),JSON.stringify({pid,created:current.created,instance:current.instance,root:this.settings.root,revision:current.revision}),{mode:0o600});
          return;
        } catch { /* Child/control or worker may still be initializing. */ }
      }
      let processInfo;
      try { processInfo = await this.deps.inspect(pid); }
      catch { await delay(this.deps.interval); continue; }
      if (!processInfo) throw new UserError('The companion exited during startup. Check the local bot logs and configuration.');
      await delay(this.deps.interval);
    }
    throw new UserError('Startup has not been verified. Inspect the existing process before retrying; no automatic duplicate or restart was attempted.');
  }
  private async stop(operation: Operation) {
    const identity = readRuntimeIdentity(this.settings.root);
    if (!identity) throw new UserError('No controllable companion was found. Stop older instances from their terminal.');
    const current = await this.verify(identity);
    // Recheck exact creation identity immediately before the authenticated shutdown request.
    const info = await this.deps.inspect(identity.pid);
    if (!info || info.created !== identity.created || !ownsProcess(info,this.settings.root,'src/main.ts')) throw new UserError('Bot ownership changed. Shutdown was not sent.');
    await this.deps.request(this.settings.root,identity,'shutdown');
    operation.message = 'Shutdown accepted. Waiting for the companion and worker to exit…';
    const until = Date.now()+this.deps.timeout;
    while (Date.now() < until) {
      const front = await this.deps.inspect(identity.pid);
      const worker = current.workerPid ? await this.deps.inspect(current.workerPid) : null;
      if ((!front || front.created !== current.created) && (!worker || worker.created !== current.workerCreated)) return;
      await delay(this.deps.interval);
    }
    throw new UserError('Shutdown did not complete within the deadline. No process was force-stopped. Inspect the remaining owned process before retrying.');
  }
  private launch(env: NodeJS.ProcessEnv): Promise<number> {
    const output = openSync(join(this.settings.root,'data/bot.stdout.log'),'a',0o600);
    const errors = openSync(join(this.settings.root,'data/bot.stderr.log'),'a',0o600);
    return new Promise((resolve,reject) => {
      const child = spawn(process.execPath,[...runtimeArguments,runtimeEntry(this.settings.root,'src/main.ts')], {
        cwd:this.settings.root, env, windowsHide:true, detached:true, stdio:['ignore',output,errors], shell:false,
      });
      closeSync(output); closeSync(errors);
      child.once('error',() => reject(new UserError('The companion could not be launched. Check the local Node.js installation.')));
      child.once('spawn',() => { child.unref(); resolve(child.pid!); });
    });
  }
}
