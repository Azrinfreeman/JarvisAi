import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localDirectory, localReady, nativeEnvironment } from './local-setup.js';
import { resourceRoot } from '../app-paths.js';
import { UserError } from '../errors.js';

async function freePort() {
  const server=createServer();
  return new Promise<number>((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
      const address=server.address();const port=typeof address==='object'&&address ? address.port : 0;
      server.close(error=>error?reject(error):resolve(port));
    });
  });
}

export class LocalSpeechEngine {
  private child?:ChildProcessWithoutNullStreams;
  private prefix='';
  private port=0;
  private startup='';
  private ready=false;
  private aborted?:()=>void;
  constructor(readonly root:string,readonly device:'cpu'|'vulkan') {}
  get endpoint() {return `http://127.0.0.1:${this.port}${this.prefix}/inference`;}
  async start(signal:AbortSignal) {
    signal.throwIfAborted();
    if(!await localReady(this.root,true))throw new UserError('Local speech files are missing or invalid. Use Set up local transcription in Settings.');
    signal.throwIfAborted();this.port=await freePort();this.prefix=`/${randomUUID()}`;
    const directory=localDirectory(this.root);
    const child=spawn(join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),[
      '-NoProfile','-NonInteractive','-File',join(resourceRoot,'scripts/local-speech-host.ps1'),'-EngineDirectory',directory,
      '-ModelPath',join(directory,'model.bin'),'-Port',String(this.port),'-RequestPath',this.prefix,'-Device',this.device,
      '-Threads',String(Math.max(1,Math.min(8,availableParallelism()-2))),
    ],{windowsHide:true,env:nativeEnvironment(directory),stdio:'pipe',shell:false});
    this.child=child;
    let failed=false;child.on('error',()=>{failed=true;});child.stdin.on('error',()=>{});
    for(const stream of [child.stdout,child.stderr])stream.on('data',(chunk:Buffer)=>{if(!this.ready)this.startup=(this.startup+chunk.toString('utf8')).slice(-64000);});
    this.aborted=()=>{child.stdin.end();};signal.addEventListener('abort',this.aborted,{once:true});
    const until=Date.now()+120000;
    try {
      while(Date.now()<until) {
        signal.throwIfAborted();
        if(failed || child.exitCode!==null)throw new UserError('Local speech engine failed to start. Check runtime files and graphics drivers, or explicitly choose CPU.');
        try {
          const response=await fetch(`http://127.0.0.1:${this.port}${this.prefix}/health`,{signal:AbortSignal.any([signal,AbortSignal.timeout(1000)]),redirect:'error'});
          const value=await response.json() as {status?:string};
          if(response.ok && value.status==='ok') {
            if(this.device==='vulkan' && !/ggml_vulkan:.*(?:Found\s+[1-9]|AMD|Radeon)/i.test(this.startup))throw new UserError('Vulkan GPU initialization was not verified. Update the GPU driver or explicitly choose CPU; no API fallback was used.');
            this.ready=true;this.startup='';return;
          }
        } catch(error) {if(error instanceof UserError)throw error;}
        await delay(200,undefined,{signal});
      }
      throw new UserError('Local speech model loading timed out. Try CPU or check available memory.');
    } catch(error) {await this.close();throw error;}
    finally {if(this.aborted)signal.removeEventListener('abort',this.aborted);}
  }
  async close() {
    const child=this.child;this.child=undefined;this.ready=false;this.startup='';
    if(!child || child.exitCode!==null || child.signalCode!==null)return;
    await new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);resolve();};
      const timer=setTimeout(()=>{child.kill();resolve();},5000);child.once('exit',done);child.stdin.end();
    });
  }
}
