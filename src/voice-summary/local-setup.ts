import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { resourceRoot } from '../app-paths.js';
import { safeError, UserError } from '../errors.js';

export const localAssets={
  engineVersion:'whisper.cpp-1.9.5-vulkan-nyancodex-0.1.0',
  engineUrl:'https://github.com/nyancodex/whisper-server-vulkan-windows/releases/download/v0.1.0/whisper-server-bundle.zip',
  engineHash:'587d04a2805737436d134ab9e02c80437f41a7cb64018a7cd4d8f65a76a56af1',engineBytes:19616442,
  model:'large-v3-q5_0',modelBytes:1081140203,modelHash:'d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1',
  modelUrl:'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-q5_0.bin',
};
export type LocalSetupStatus={state:'missing'|'downloading'|'ready'|'failed';message:string;progress:number;model:string;engineVersion:string};
type Manifest={version:string;modelHash:string;files:Record<string,string>};
const execute=promisify(execFile);
function setupPath(base:string,path:string) {
  if(!resolve(path).toLowerCase().startsWith(resolve(base).toLowerCase()+sep))throw new UserError('Invalid local speech setup path.');
  return path;
}
export const localDirectory=(root:string)=>join(root,'data/local-speech',localAssets.engineVersion);
export function nativeEnvironment(directory:string,env=process.env):NodeJS.ProcessEnv {
  const result:NodeJS.ProcessEnv={};
  for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA'])if(env[key]!==undefined)result[key]=env[key];
  result.PATH=[directory,join(env.SystemRoot||'C:/Windows','System32')].join(';');return result;
}
export async function fileHash(path:string) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');
}
export async function localReady(root:string,verify=false) {
  const directory=localDirectory(root);
  try {
    if((await stat(join(directory,'manifest.json'))).size>16384)return false;
    const document=await readFile(join(directory,'manifest.json'),'utf8');if(document.length>16384)return false;
    const manifest=JSON.parse(document) as Manifest;
    if(manifest.version!==localAssets.engineVersion || manifest.modelHash!==localAssets.modelHash || !manifest.files
      || Object.keys(manifest.files).length>40 || !manifest.files['whisper-server.exe'] || !manifest.files['ggml-vulkan.dll'])return false;
    if((await stat(join(directory,'model.bin'))).size!==localAssets.modelBytes)return false;
    for(const [name,digest] of Object.entries(manifest.files)) {
      if(!/^(?:whisper-(?:server|cli)\.exe|(?:libwhisper|whisper|ggml(?:-[a-z0-9]+)*)\.dll)$/.test(name) || !/^[a-f\d]{64}$/.test(digest)
        || !(await stat(join(directory,name))).isFile() || verify && await fileHash(join(directory,name))!==digest)return false;
    }
    return !verify || await fileHash(join(directory,'model.bin'))===localAssets.modelHash;
  } catch {return false;}
}

export async function downloadVerified(url:string,path:string,bytes:number,digest:string,signal:AbortSignal,progress:(bytes:number)=>void,request=fetch) {
  const response=await request(url,{signal,redirect:'follow'});
  if(!response.ok || !response.body)throw new UserError('Local speech download failed. Check connectivity and retry setup.');
  const hash=createHash('sha256');let received=0;
  const handle=await open(path,'wx',0o600);
  try {
    const counter=new Transform({transform(chunk:Buffer,_encoding,callback){
      received+=chunk.length;
      if(received>bytes){callback(new UserError('Local speech download exceeded its expected size.'));return;}
      hash.update(chunk);progress(received);callback(null,chunk);
    }});
    await pipeline(Readable.fromWeb(response.body as never),counter,handle.createWriteStream(),{signal});
    if(received!==bytes || hash.digest('hex')!==digest)throw new UserError('Local speech checksum verification failed. Nothing was installed.');
  } finally {await handle.close().catch(()=>{});}
}

export class LocalSpeechSetup {
  private controller?:AbortController;
  private operation?:Promise<void>;
  private generation=0;
  private current:LocalSetupStatus={state:'missing',message:'Local speech files are not installed.',progress:0,model:localAssets.model,engineVersion:localAssets.engineVersion};
  constructor(readonly root:string,private readiness=localReady) {}
  async status():Promise<LocalSetupStatus> {
    if(!this.controller && this.current.state!=='failed') {
      const generation=this.generation;const ready=await this.readiness(this.root);
      if(!this.controller && generation===this.generation)this.current={...this.current,state:ready?'ready':'missing',progress:ready?100:0,message:ready?'Local transcription is ready.':'Download local speech engine and model (about 1.1 GB).'};
    }
    return {...this.current};
  }
  async begin():Promise<LocalSetupStatus> {
    if(this.controller)return this.status();
    if(process.platform!=='win32' || process.arch!=='x64')throw new UserError('Local speech setup currently supports Windows x64.');
    const controller=new AbortController();this.controller=controller;this.generation++;
    if(await this.readiness(this.root)){this.controller=undefined;this.generation++;return this.status();}
    this.current={...this.current,state:'downloading',message:'Downloading verified local speech files…',progress:0};
    this.operation=this.install(controller.signal).catch(error=>{
      this.current={...this.current,state:'failed',message:controller.signal.aborted?'Local setup cancelled.':safeError(error),progress:0};
    }).finally(()=>{if(this.controller===controller){this.controller=undefined;this.generation++;}});
    return {...this.current};
  }
  cancel() {this.controller?.abort();return {...this.current,message:this.controller?'Cancelling local speech setup…':this.current.message};}
  async wait() {await this.operation;return this.status();}
  protected async install(signal:AbortSignal) {
    signal.throwIfAborted();
    const base=resolve(this.root,'data/local-speech');await mkdir(base,{recursive:true});
    const staging=setupPath(base,join(base,`download-${randomUUID()}`));
    const lockPath=join(base,'setup.lock');const owner=randomUUID();
    let lock;
    try {lock=await open(lockPath,'wx',0o600);}
    catch {
      try {
        const previous=await readFile(lockPath,'utf8');const record=JSON.parse(previous);
        if(!Number.isSafeInteger(record.pid)||record.pid<=0)throw new Error();
        try{process.kill(record.pid,0);throw new Error();}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
        if(await readFile(lockPath,'utf8')!==previous)throw new Error();
        await unlink(lockPath);lock=await open(lockPath,'wx',0o600);
      } catch {throw new UserError('Another local speech setup is active or its owner cannot be verified. Wait for it to finish.');}
    }
    const destination=setupPath(base,localDirectory(this.root));let published=false;let backup:string|undefined;
    try {
      await lock.writeFile(JSON.stringify({pid:process.pid,owner}));
      if(await localReady(this.root)){this.current={...this.current,state:'ready',progress:100,message:'Local transcription is ready.'};return;}
      await mkdir(staging);
      let engineDone=0,modelDone=0;
      const update=()=>{this.current.progress=Math.floor((engineDone+modelDone)/(localAssets.engineBytes+localAssets.modelBytes)*95);};
      const archive=join(staging,'engine.zip');
      await downloadVerified(localAssets.engineUrl,archive,localAssets.engineBytes,localAssets.engineHash,signal,bytes=>{engineDone=bytes;update();});
      const powershell=join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
      await execute(powershell,['-NoProfile','-NonInteractive','-File',join(resourceRoot,'scripts/local-speech-extract.ps1'),'-Archive',archive,'-Destination',staging],
        {windowsHide:true,signal,timeout:60000,maxBuffer:16384,env:nativeEnvironment(staging)});
      await rm(archive);
      await downloadVerified(localAssets.modelUrl,join(staging,'model.bin'),localAssets.modelBytes,localAssets.modelHash,signal,bytes=>{modelDone=bytes;update();});
      signal.throwIfAborted();this.current.message='Checking local speech files…';this.current.progress=97;
      const files:Record<string,string>={};
      for(const name of await readdir(staging))if(name.endsWith('.exe')||name.endsWith('.dll'))files[name]=await fileHash(join(staging,name));
      if(!files['whisper-server.exe']||!files['ggml-vulkan.dll'])throw new UserError('The local speech bundle is incomplete.');
      const manifest:Manifest={version:localAssets.engineVersion,modelHash:localAssets.modelHash,files};
      await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
      await writeFile(join(staging,'LICENSES.txt'),await readFile(join(resourceRoot,'scripts/local-speech-licenses.txt')),{mode:0o600});
      await writeFile(join(staging,'NOTICE.txt'),'whisper.cpp / ggml: MIT, Georgi Gerganov and contributors. Whisper models: MIT, OpenAI. Vulkan Windows build: nyancodex/whisper-server-vulkan-windows v0.1.0, upstream d1be6fde11ac6e0407606b4e42fe72d34add8037. MinGW runtime: GCC Runtime Library Exception. Source and licenses: https://github.com/ggml-org/whisper.cpp ; https://github.com/nyancodex/whisper-server-vulkan-windows\n');
      signal.throwIfAborted();
      try {
        await stat(destination);
        if(await localReady(this.root))return;
        backup=setupPath(base,join(base,`${localAssets.engineVersion}.previous-${randomUUID()}`));await rename(destination,backup);
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await rename(staging,destination);published=true;
      if(backup)await rm(setupPath(base,backup),{recursive:true,force:true});
      this.current={...this.current,state:'ready',progress:100,message:'Local transcription is ready.'};
    } finally {
      if(!published){await rm(setupPath(base,staging),{recursive:true,force:true});if(backup)await rename(backup,destination).catch(()=>{});}
      await lock.close();
      try{if(JSON.parse(await readFile(lockPath,'utf8')).owner===owner)await unlink(lockPath);}catch{}
    }
  }
}
