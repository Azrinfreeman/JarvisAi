// Disposable lifecycle fixture: no Discord connection, inference, or production data.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { startRuntimeControl } from '../../src/integration/runtime-control.js';

const root=process.cwd();
const lock=join(root,'data/frontend/123456789012345678/runtime.lock');
mkdirSync(join(root,'data/frontend/123456789012345678'),{recursive:true});
writeFileSync(lock,String(process.pid),{flag:'wx'});
const worker=fork(join(root,'src/integration/ai-worker.ts'),[],{execArgv:['--import',import.meta.resolve('tsx')],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
let stopping: Promise<void> | undefined;
const shutdown = () => stopping ??= (async () => {
  if (worker.exitCode === null && worker.signalCode === null) { const ended=once(worker,'exit'); worker.send('stop'); await ended; }
  unlinkSync(lock); control.close(); process.exit(0);
})();
const control=await startRuntimeControl({root,secret:process.env.RUNTIME_FIXTURE_SECRET,revision:'fixture-revision',workerPid:() => worker.pid,shutdown});
process.on('message',message => { if (message==='fixture-stop') void shutdown(); });
process.on('disconnect',() => void shutdown());
