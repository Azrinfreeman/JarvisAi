import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const resources=join(root,'desktop/out/RainBot-win32-x64/resources');
const backend=join(resources,'backend');
const modelRoot=join(process.env.LOCALAPPDATA,'RainBot');
const env={};
for(const name of ['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA'])if(process.env[name]!==undefined)env[name]=process.env[name];
env.PATH=join(process.env.SystemRoot||'C:/Windows','System32');env.RAINBOT_RESOURCE_ROOT=backend;
const code=`
const {LocalSpeechEngine}=await import(${JSON.stringify(pathToFileURL(join(backend,'src/voice-summary/local-engine.js')).href)});
const engine=new LocalSpeechEngine(${JSON.stringify(modelRoot)},'vulkan');
try{await engine.start(AbortSignal.timeout(120000));console.log('Packaged local Vulkan engine loaded its verified model using bundled Node and packaged Windows lifecycle helpers. No audio/API request was used.');}
finally{await engine.close();}
`;
const result=await promisify(execFile)(join(resources,'node/node.exe'),['--input-type=module','-e',code],{
  env,cwd:dirname(join(resources,'node/node.exe')),windowsHide:true,timeout:130000,maxBuffer:64000,
});
console.log(result.stdout.trim());
