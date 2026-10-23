import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntimeControl, runtimeRequest, readRuntimeIdentity, inspectProcess, ownsProcess } from '../src/integration/runtime-control.js';
import { SettingsStore } from '../src/settings.js';
import { BotSupervisor } from '../src/dashboard/supervisor.js';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('authenticated named-pipe control accepts identity/shutdown and rejects forged requests',async () => {
  const root=mkdtempSync(join(tmpdir(),'rainbot-pipe-')); const secret='a'.repeat(64); let shutdown=0;
  let stopped!: () => void;
  const accepted = new Promise<void>(resolve => { stopped=resolve; });
  const control=await startRuntimeControl({root,revision:'fixture-revision',secret,workerPid:() => undefined,
    inspect:async pid => ({pid,parentPid:1,created:'fixture-created',executable:process.execPath,directory:root,commandLine:'node src/main.ts'}),
    shutdown:async () => {shutdown++;stopped();}});
  try {
    const saved=readRuntimeIdentity(root)!;
    const result=await runtimeRequest(root,saved,'identity',secret);
    assert.equal(result.revision,'fixture-revision'); assert.equal(result.workerPid,null);
    await assert.rejects(runtimeRequest(root,saved,'shutdown','b'.repeat(64)),/unavailable/);
    assert.equal(shutdown,0);
    await assert.rejects(runtimeRequest(root,{...saved,instance:'other-instance'},'shutdown',secret),/unavailable/);
    assert.equal(shutdown,0);
    await runtimeRequest(root,saved,'shutdown',secret);
    await accepted;
    assert.equal(shutdown,1);
  } finally {control.close();rmSync(root,{recursive:true,force:true});}
});

test('Windows metadata inspection identifies a real process without exposing its environment',async () => {
  const info=await inspectProcess(process.pid);
  assert.ok(info); assert.equal(info.pid,process.pid); assert.equal(info.executable.toLowerCase(),process.execPath.toLowerCase());
  assert.equal(ownsProcess(info,process.cwd(),'src/main.ts'),false);
  assert.equal('environment' in info,false);
});

test('real supervisor starts a disposable frontend/worker, reconnects, and stops both cooperatively', {timeout:180000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'rainbot-real-lifecycle-'));
  const secret='c'.repeat(64); let child: ChildProcess | undefined;
  try {
    mkdirSync(join(root,'assets')); mkdirSync(join(root,'src/integration'),{recursive:true});
    writeFileSync(join(root,'package.json'),'{"type":"module"}');
    writeFileSync(join(root,'.env'),'DISCORD_BOT_TOKEN=synthetic-token\nDISCORD_APPLICATION_ID=123456789012345678\nDISCORD_GUILD_ID=123456789012345678\nOWNER_DISCORD_ID=123456789012345678\nAI_PROVIDER=stub\n');
    for (const name of ['rain-loop','rain-soft-loop','rain-indoor-loop','rain-glass-loop','rain-heavy-loop','sunny-birds-loop','thunder-distant-a','thunder-distant-b','thunder-distant-c','thunder-distant-d']) writeFileSync(join(root,'assets',name+'.pcm'),'fixture');
    writeFileSync(join(root,'src/main.ts'),`import ${JSON.stringify(new URL('./fixtures/managed-runtime.ts',import.meta.url).href)};`);
    writeFileSync(join(root,'src/integration/ai-worker.ts'),"process.on('message',()=>process.exit(0)); process.once('disconnect',()=>process.exit(0));");
    const settings=new SettingsStore(root,{});
    const dependencies={request:(directory: string,identity: Parameters<typeof runtimeRequest>[1],action: 'identity'|'shutdown') => runtimeRequest(directory,identity,action,secret),timeout:90000,interval:100,
      launch:async () => {
        child=fork(join(root,'src/main.ts'),[],{cwd:root,env:{...process.env,RUNTIME_FIXTURE_SECRET:secret},execArgv:['--import',import.meta.resolve('tsx')],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
        await once(child,'spawn');return child.pid!;
      }};
    const supervisor=new BotSupervisor(settings,dependencies);
    const wait = async (manager: BotSupervisor,operation: {id: string}) => {
      for (let i=0;i<1200;i++) { const result=manager.getOperation(operation.id)!; if (result.status!=='pending') return result; await delay(100); }
      throw new Error('Fixture operation deadline exceeded');
    };
    const started=await wait(supervisor,supervisor.begin('start'));
    assert.equal(started.status,'completed',started.message);
    const identity=readRuntimeIdentity(root)!;
    assert.equal(identity.pid,child!.pid);
    const reopened=new BotSupervisor(settings,dependencies);
    assert.equal((await reopened.status()).state,'running');
    const stopped=await wait(reopened,reopened.begin('stop'));
    assert.equal(stopped.status,'completed',stopped.message);
    assert.equal(await inspectProcess(identity.pid),null);
    assert.equal((await reopened.status(true)).state,'stopped');
  } finally {
    if (child?.connected) { const ended=once(child,'exit');child.send('fixture-stop');await Promise.race([ended,delay(15000)]); }
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(root,{recursive:true,force:true});
  }
});
