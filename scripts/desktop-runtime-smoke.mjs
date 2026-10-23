import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url)), resources=join(root,'desktop/.stage');
const profile=join(root,'output/desktop-runtime',randomUUID());
const code=join(profile,'code'), state=join(profile,'state');
const backend=join(resources,'backend'), executable=join(resources,'node/node.exe');
await mkdir(join(code,'src/integration'),{recursive:true});await mkdir(state,{recursive:true});
await cp(join(backend,'scripts'),join(code,'scripts'),{recursive:true});
await writeFile(join(code,'package.json'),' {"type":"module"}\n');
const moduleURL=file=>JSON.stringify(pathToFileURL(join(backend,'src',file)).href);
await writeFile(join(code,'src/integration/ai-worker.js'),`
import {runtimeLock} from ${moduleURL('vault.js')};
const release=runtimeLock();process.on('exit',release);
process.on('message',message=>{if(message==='stop'){release();process.exit(0);}});
process.send('ready');
`);
await writeFile(join(code,'src/main.js'),`
// Disposable packaged lifecycle fixture: no Discord or AI network access.
import {fork} from 'node:child_process';import {once} from 'node:events';import {join} from 'node:path';
import {runtimeLock} from ${moduleURL('vault.js')};
import {SettingsStore} from ${moduleURL('settings.js')};
import {startRuntimeControl} from ${moduleURL('integration/runtime-control.js')};
const release=runtimeLock(join(process.cwd(),'data/frontend/123456789012345678'));
const worker=fork(join(process.env.RAINBOT_RESOURCE_ROOT,'src/integration/ai-worker.js'),[],{execArgv:[],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
await once(worker,'message');let stopping;
const shutdown=()=>stopping??=(async()=>{const ended=once(worker,'exit');worker.send('stop');await ended;control.close();release();process.exit(0);})();
const control=await startRuntimeControl({revision:new SettingsStore().effective().revision,workerPid:()=>worker.pid,shutdown});
process.on('exit',release);
`);
let controller;
const pending=new Map();
function connect() {
  const env={};for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key] !== undefined)env[key]=process.env[key];
  Object.assign(env,{RAINBOT_STATE_ROOT:state,RAINBOT_RESOURCE_ROOT:code,SLEEP_ASSET_DIR:join(backend,'assets')});
  controller=fork(join(backend,'src/desktop/controller.js'),[],{execPath:executable,execArgv:[],cwd:state,env,windowsHide:true,serialization:'json',stdio:['ignore','ignore','inherit','ipc']});
  controller.on('message',reply=>{const p=pending.get(reply.id);if(!p)return;clearTimeout(p.timer);pending.delete(reply.id);if(reply.error)p.reject(new Error(reply.error));else p.resolve(reply.value);});
  controller.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Controller exited during a request.'));}pending.clear();});
}
function request(operation,argument={}) {
  return new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Runtime smoke request timed out.'));},65000);pending.set(id,{resolve,reject,timer});controller.send({id,operation,argument});});
}
async function completed(operation) {
  const deadline=Date.now()+65000;
  let value=operation;
  while(value.status === 'pending' && Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,300));value=await request('operation',{id:operation.id});}
  assert.equal(value.status,'completed',value.message);return value;
}
async function disconnect() {const exited=once(controller,'exit');controller.disconnect();await exited;}
connect();
try {
  await request('saveSettings',{revision:'legacy',values:{DISCORD_APPLICATION_ID:'123456789012345678',DISCORD_GUILD_ID:'223456789012345678',OWNER_DISCORD_ID:'323456789012345678',AI_PROVIDER:'stub'},secrets:{DISCORD_BOT_TOKEN:{action:'replace',value:'synthetic-discord-token'}}});
  const starting=await request('start');assert.equal(starting.status,'pending');
  // Closing the UI during startup must let its controller finish persisting ownership.
  await disconnect();connect();
  assert.equal((await request('freshManagement')).state,'running');
  await completed(await request('stop'));
  assert.equal((await request('freshManagement')).state,'stopped');
  await disconnect();
  await writeFile(join(root,'output/desktop-runtime/result.json'),JSON.stringify({passed:true,node:JSON.parse(await readFile(join(resources,'node/runtime.json'),'utf8')),checks:['compiled controller using bundled Node','DPAPI synthetic settings','compiled frontend and worker ownership','reconnection after controller exit','cooperative shutdown of both fixture processes'],profile},null,2));
  console.log('Packaged runtime smoke passed. No Discord connection or inference was made.');
} catch(error) {
  try {await completed(await request('stop'));} catch {}
  if(controller?.connected)await disconnect();
  throw error;
}
