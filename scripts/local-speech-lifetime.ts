import { fork } from 'node:child_process';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalSpeechEngine } from '../src/voice-summary/local-engine.js';
import { safeError, UserError } from '../src/errors.js';

const root=join(process.env.LOCALAPPDATA!,'RainBot');
if(process.argv.includes('--child')) {
  const engine=new LocalSpeechEngine(root,'vulkan');
  try {await engine.start(AbortSignal.timeout(120000));process.send?.({endpoint:engine.endpoint});}
  catch(error){process.send?.({error:safeError(error)});await engine.close();process.exitCode=1;}
} else {
  const child=fork(new URL(import.meta.url),['--child'],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  try {
    const result=await Promise.race([once(child,'message'),delay(130000,undefined,{ref:false}).then(()=>{throw new UserError('Lifetime test timed out.');})]);
    const message=result[0] as {endpoint?:string;error?:string};
    if(!message.endpoint)throw new UserError(message.error||'Local engine did not start.');
    const exited=once(child,'exit');child.kill();await exited;
    const health=message.endpoint.replace(/\/inference$/,'/health');let stopped=false;
    for(let attempt=0;attempt<30;attempt++) {
      try {await fetch(health,{signal:AbortSignal.timeout(300)});}
      catch {stopped=true;break;}
      await delay(200);
    }
    if(!stopped)throw new UserError('Native speech engine survived its owning process.');
    console.log('Local speech lifetime passed: terminating the owning Node process closed the native GPU server. No audio or API request was used.');
  } catch(error){console.error(safeError(error));process.exitCode=1;}
  finally {if(child.exitCode===null)child.kill();}
}
