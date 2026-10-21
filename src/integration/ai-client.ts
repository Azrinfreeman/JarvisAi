import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { readFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { UserError } from '../errors.js';
import { safeError } from '../errors.js';
import type { NicknameRequest } from '../nickname-request.js';
import type { ReferencedInput } from '../replies.js';
import type { ReplyPayload } from '../responses.js';
import type { ChatIdentity } from '../chat.js';
import { validToWorker, validFromWorker, workerEnvironment, type AskInput, type ToWorker, type WorkerStatus } from './protocol.js';

type Pending = {
  resolve: (result: boolean) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  deliver?: (payload: ReplyPayload) => Promise<void>; reference?: (signal: AbortSignal) => Promise<ReferencedInput>;
  controller: AbortController; deliveryStarted: boolean; referenceStarted: boolean;
  nickname?: (request:NicknameRequest,signal:AbortSignal)=>Promise<string>;
  nicknameRequest?:NicknameRequest; nicknameResult?:Promise<string>;
};
export class AIClient extends EventEmitter {
  private child?: ChildProcess;
  private requests = new Map<string,Pending>();
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private failures = 0;
  status: WorkerStatus = {phase:'starting',label:'Starting AI connection'};
  constructor(private options: { env?: NodeJS.ProcessEnv; entry?: string; restartMs?: number } = {}) { super(); }
  start() {
    if (this.stopped || this.child) return;
    const env = workerEnvironment(this.options.env ?? process.env);
    const child = fork(this.options.entry ?? fileURLToPath(new URL('./ai-worker.ts',import.meta.url)),[],{
      execArgv:['--import','tsx'], env,
      stdio:['ignore','ignore','ignore','ipc'], serialization:'advanced', windowsHide:true,
    });
    this.child = child;
    const failed = () => {
      if (this.child !== child) return;
      this.child = undefined;
      child.removeAllListeners('message');
      for (const [id,p] of this.requests) { clearTimeout(p.timer); p.controller.abort(); p.reject(new UserError('AI worker restarted. Send a new question; sleep playback continues.')); this.requests.delete(id); }
      if (this.stopped) return;
      this.update({phase:'restarting',label:'AI unavailable; reconnecting. Sleep controls remain available.'});
      const delay = this.options.restartMs ?? Math.min(60000,2000 * 2 ** Math.min(this.failures++,5));
      this.retry = setTimeout(() => this.start(),delay);
    };
    child.once('error',() => { if (child.pid) child.kill(); else failed(); });
    child.once('exit',() => {
      // Only this exact, now-exited child may have its orphaned lock removed.
      // Never clear a lock owned by auth, another worker, or an unrelated PID.
      const lock = join(resolve(env.AI_DATA_DIR || fileURLToPath(new URL('../../data/ai/',import.meta.url))),'runtime.lock');
      try { if (child.pid && readFileSync(lock,'utf8').trim() === String(child.pid)) unlinkSync(lock); } catch {}
      failed();
    });
    child.on('message',raw => {
      if (this.child !== child || !validFromWorker(raw)) return;
      if (raw.type === 'status') { if (raw.status.phase === 'ready') this.failures = 0; this.update(raw.status); return; }
      const pending = this.requests.get(raw.id); if (!pending) return;
      if (raw.type === 'failed' || raw.type === 'done' || raw.type === 'duplicate') {
        clearTimeout(pending.timer); pending.controller.abort(); this.requests.delete(raw.id);
        if (raw.type === 'failed') pending.reject(new UserError(raw.error));
        else pending.resolve(raw.type === 'done');
      } else if (raw.type === 'nickname') {
        const expected=pending.nicknameRequest;
        if (!expected || !pending.nickname || raw.request.targetId!==expected.targetId || raw.request.nickname!==expected.nickname) {
          try { this.send({type:'nickname_result',id:raw.id,error:'Nickname action did not match the current authorized request.'}); } catch {}
          return;
        }
        pending.nicknameResult ??= Promise.resolve().then(()=>pending.nickname!(raw.request,pending.controller.signal));
        void pending.nicknameResult.then(result=>{
          if (this.requests.get(raw.id)===pending) { try { this.send({type:'nickname_result',id:raw.id,result}); } catch {} }
        }).catch(error=>{
          if (this.requests.get(raw.id)===pending) { try { this.send({type:'nickname_result',id:raw.id,error:safeError(error)}); } catch {} }
        });
      } else if (raw.type === 'reference' && !pending.referenceStarted) {
        pending.referenceStarted = true;
        void (async () => {
          if (!pending.reference) throw new Error('No reference loader');
          return pending.reference(AbortSignal.any([pending.controller.signal,AbortSignal.timeout(15000)]));
        })().then(value => {
          if (this.requests.get(raw.id) === pending) this.send({type:'reference',id:raw.id,value});
        }).catch(() => {
          if (this.requests.get(raw.id) === pending) this.send({type:'reference',id:raw.id,error:'Could not read the selected message. Check Message Content access, channel permissions, and whether it was deleted.'});
        });
      } else if (raw.type === 'result' && !pending.deliveryStarted) {
        pending.deliveryStarted = true;
        void (async () => { if (!pending.deliver) throw new Error('No delivery handler'); await pending.deliver(raw.payload); })()
          .then(() => { if (this.requests.get(raw.id) === pending) this.send({type:'delivered',id:raw.id,success:true}); })
          .catch(() => { if (this.requests.get(raw.id) === pending) this.send({type:'delivered',id:raw.id,success:false}); });
      }
    });
  }
  private update(status: WorkerStatus) { this.status = status; this.emit('status',status); }
  private send(message: ToWorker) {
    if (!validToWorker(message)) throw new UserError('Invalid AI request payload.');
    if (!this.child?.connected) throw new UserError('AI connection is unavailable; sleep controls still work.');
    this.child.send(message,() => {});
  }
  private request(message: { type:'ask';input:AskInput } | { type:'reset';identity:ChatIdentity },
    callbacks: Pick<Pending,'deliver'|'reference'|'nickname'|'nicknameRequest'> = {}): Promise<boolean> {
    if (this.status.phase !== 'ready') return Promise.reject(new UserError('AI is unavailable or starting. Sleep controls still work; try again shortly.'));
    if (this.requests.size >= 8) return Promise.reject(new UserError('AI is busy. Try again shortly.'));
    const id = randomUUID();
    return new Promise((resolve,reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        this.requests.delete(id); controller.abort();
        try { this.send({type:'cancel',id}); } catch {}
        reject(new UserError('AI request timed out. Send a new question.'));
      },message.type === 'reset' ? 10000 : 690000);
      this.requests.set(id,{resolve,reject,timer,controller,deliveryStarted:false,referenceStarted:false,...callbacks});
      try { this.send({...message,id}); }
      catch(error) { clearTimeout(timer); this.requests.delete(id); reject(error as Error); }
    });
  }
  ask(input: AskInput, deliver: NonNullable<Pending['deliver']>, reference?: Pending['reference'], nickname?:Pending['nickname']) {
    return this.request({type:'ask',input},{deliver,reference,nickname,nicknameRequest:input.nickname});
  }
  reset(identity: ChatIdentity) { return this.request({type:'reset',identity}); }
  close() {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.retry);
    for (const p of this.requests.values()) { clearTimeout(p.timer); p.controller.abort(); p.reject(new UserError('Bot is shutting down.')); }
    this.requests.clear();
    const child = this.child;
    if (child?.connected) child.send({type:'shutdown'},() => {});
    if (child) { const timer = setTimeout(() => child.kill(),3000); timer.unref(); child.once('exit',() => clearTimeout(timer)); }
  }
}
