import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inspectProcess } from '../desktop/.stage/backend/src/integration/runtime-control.js';

const exec=promisify(execFile), root=fileURLToPath(new URL('../',import.meta.url));
const packaged=join(root,'desktop/out/RainBot-win32-x64');
const executable=join(packaged,'RainBot.exe'), resources=join(packaged,'resources');
const output=join(root,'output/desktop-package',randomUUID());await mkdir(output,{recursive:true});
const env={};for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','PATHEXT'])if(process.env[key] !== undefined)env[key]=process.env[key];
Object.assign(env,{LOCALAPPDATA:output,APPDATA:join(output,'roaming'),PATH:join(process.env.SystemRoot || 'C:/Windows','System32')});
const node=join(resources,'node/node.exe'), backend=join(resources,'backend');
const check=join(output,'dependencies.mjs');
await writeFile(check,`
import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(${JSON.stringify(pathToFileURL(join(backend,'package.json')).href)});
const sharp=(await import(pathToFileURL(require.resolve('sharp')).href)).default;
assert.ok((await sharp({create:{width:8,height:8,channels:3,background:'#2463eb'}}).png().toBuffer()).length > 0);
const Opus=(await import(pathToFileURL(require.resolve('opusscript')).href)).default;
const encoder=new Opus(48000,2,Opus.Application.AUDIO);const packet=encoder.encode(Buffer.alloc(3840),960);assert.ok(packet.length > 0);encoder.delete();
const decode=(await import(${JSON.stringify(pathToFileURL(join(backend,'src/voice-summary/transcription.js')).href)})).chunkWav;
assert.equal(decode({speakerId:'synthetic',start:0,end:20,frames:[{at:0,packet}]}).length,1964);
const speech=await import(${JSON.stringify(pathToFileURL(join(backend,'src/voice-summary/speech-client.js')).href)});
const configuration=(await import(${JSON.stringify(pathToFileURL(join(backend,'src/voice-summary/config.js')).href)})).voiceConfig({VOICE_SUMMARY_PROVIDER:'openai',VOICE_SUMMARY_API_KEY:'synthetic-disabled-test'});
await assert.rejects(speech.transcribeSnapshot({epoch:'synthetic',start:0,end:20,chunks:[{speakerId:'synthetic',start:0,end:20,frames:[{at:0,packet}]}]},configuration,AbortSignal.timeout(10000),()=>{throw new Error('Synthetic budget denial before any API submission');}),/Synthetic budget denial/);
console.log('Packaged voice decoder and budget-gated speech worker passed without an API submission.');
const db=new DatabaseSync(':memory:');assert.equal(db.prepare('SELECT 1 AS value').get().value,1);db.close();
console.log('Packaged native/image/audio/database dependencies passed.');
`);
const dependencies=await exec(node,[check],{env,cwd:output,windowsHide:true,timeout:20000});console.log(dependencies.stdout.trim());
for(const forbidden of ['.env','data','PERSONALITY.md'])assert.equal(existsSync(join(backend,forbidden)),false);
const asar=await import(pathToFileURL(join(root,'desktop/node_modules/@electron/asar/lib/asar.js')).href);
const paths=asar.listPackage(join(resources,'app.asar'));
assert.equal(paths.some(path=>/[/\\](\.stage|out|\.env|smoke\.mjs)([/\\]|$)/.test(path)),false);
const children=[];
function launch() {
  const child=spawn(executable,[],{env,cwd:output,windowsHide:false,stdio:['ignore','pipe','pipe'],shell:false});children.push(child);
  let diagnostics='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{diagnostics=(diagnostics+data).slice(-4000);});
  child.on('exit',(code,signal)=>{if(code && !signal)console.error('Packaged startup exit:',code,diagnostics);});
  return child;
}
let controllerPid;
try {
  const first=launch();
  let ready=false;const titles=new Set();
  const until=Date.now()+30000;
  while(Date.now()<until) {
    if(first.exitCode !== null)throw new Error('Packaged application exited before its window was ready.');
    const result=await exec(resolve(process.env.SystemRoot || 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${first.pid} -ErrorAction SilentlyContinue; if($p){$p.MainWindowTitle}; exit 0`],{windowsHide:true,timeout:10000});
    titles.add(result.stdout.trim());
    if(result.stdout.trim().includes('RainBot')){ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(ready,true,`Packaged RainBot window did not become ready. Titles: ${JSON.stringify([...titles])}`);
  const graph=await exec(resolve(process.env.SystemRoot || 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter 'ParentProcessId=${first.pid}' | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`],{windowsHide:true,timeout:10000});
  const parsed=JSON.parse(graph.stdout);const records=Array.isArray(parsed)?parsed:[parsed];
  const controller=records.find(record=>record.ExecutablePath?.toLowerCase() === node.toLowerCase());
  assert.ok(controller?.CommandLine.includes('desktop/controller.js') || controller?.CommandLine.includes('desktop\\controller.js'));
  controllerPid=controller.ProcessId;
  const second=launch();
  await Promise.race([once(second,'exit'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Second instance did not exit.')),10000))]);
  assert.equal(second.exitCode,0);assert.equal(first.exitCode,null);
  assert.equal(existsSync(join(output,'RainBot/data/frontend')),false);
  console.log('Packaged window and single-instance checks passed without a system Node installation on PATH.');
} finally {
  // These are only this script's idle GUI children, using a fresh profile with no bot configuration.
  for(const child of children)if(child.exitCode === null && child.signalCode === null){const exited=once(child,'exit');child.kill();await exited;}
}
if(controllerPid) {
  const until=Date.now()+8000;let remaining;
  do {remaining=await inspectProcess(controllerPid);if(remaining)await new Promise(resolve=>setTimeout(resolve,200));}while(remaining && Date.now()<until);
  assert.equal(remaining,null,'The controller should exit after its app disconnects.');
}
await writeFile(join(root,'output/desktop-package/result.json'),JSON.stringify({passed:true,checks:['packaged executable startup','bundled Node with no system Node on PATH','sharp/Opus/SQLite dependencies','no private data or smoke code in application package','single-instance focus/exit','controller exits after app disconnect'],installerBytes:(await stat(join(root,'desktop/out/make/squirrel.windows/x64/RainBotSetup.exe'))).size,output},null,2));
