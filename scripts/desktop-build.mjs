import { mkdir, readFile, writeFile, copyFile, cp, rm, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const root=fileURLToPath(new URL('../',import.meta.url));
const stage=join(root,'desktop/.stage');
const nodeVersion='24.22.0';
if(process.platform !== 'win32' || process.arch !== 'x64')throw new Error('Build the first desktop release on Windows x64.');
const npmCLI=process.env.npm_execpath;
if(!npmCLI || !existsSync(npmCLI))throw new Error('Run this build through npm run desktop:prepare.');
function run(entry,args,cwd=root) {
  const result=spawnSync(process.execPath,[entry,...args],{cwd,stdio:'inherit',windowsHide:true,shell:false});
  if(result.error || result.status !== 0)throw new Error('Desktop preparation failed; inspect the build output.');
}
function safeStage(path) {
  const part=relative(resolve(stage),resolve(path));
  if(!part || part.startsWith('..') || isAbsolute(part))throw new Error('Unsafe staging path.');
  return path;
}
async function download(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(120000),redirect:'error'});
  if(!response.ok)throw new Error(`Could not download build resource (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}
await mkdir(stage,{recursive:true});
for(const name of ['backend','ui'])await rm(safeStage(join(stage,name)),{recursive:true,force:true});
const backend=join(stage,'backend'), ui=join(stage,'ui'), runtime=join(stage,'node');
await Promise.all([mkdir(backend,{recursive:true}),mkdir(ui,{recursive:true}),mkdir(runtime,{recursive:true})]);
run(join(root,'node_modules/typescript/bin/tsc'),['-p','tsconfig.build.json']);
await copyFile(join(root,'package.json'),join(backend,'package.json'));
await copyFile(join(root,'package-lock.json'),join(backend,'package-lock.json'));
run(npmCLI,['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],backend);
await mkdir(join(backend,'scripts'),{recursive:true});
for(const file of ['inspect-runtime.ps1','process-directory.ps1'])await copyFile(join(root,'scripts',file),join(backend,'scripts',file));
const audio=['rain-loop.pcm','rain-soft-loop.pcm','rain-indoor-loop.pcm','rain-glass-loop.pcm','rain-heavy-loop.pcm','sunny-birds-loop.pcm','thunder-distant-a.pcm','thunder-distant-b.pcm','thunder-distant-c.pcm','thunder-distant-d.pcm'];
await mkdir(join(backend,'assets'),{recursive:true});
for(const file of audio)await copyFile(join(root,'assets',file),join(backend,'assets',file));
await writeFile(join(backend,'PERSONALITY.template.md'),'Be helpful, professional and concise. Use the language of the person asking.\n');
for(const file of ['index.html','app.js','styles.css','transport.js'])await copyFile(join(root,'src/dashboard/public',file),join(ui,file));
// Keep the optional recovery dashboard complete in the staged backend, too.
await cp(ui,join(backend,'src/dashboard/public'),{recursive:true});
const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="60" fill="#2563eb"/><path d="M70 146a35 35 0 1 1 5-69 44 44 0 0 1 82 13 28 28 0 1 1 15 56" fill="none" stroke="white" stroke-width="14" stroke-linecap="round"/><path d="m80 175-8 16m55-16-8 16m55-16-8 16" stroke="#b7f0dc" stroke-width="13" stroke-linecap="round"/></svg>');
const png=await sharp(svg).png().toBuffer();await writeFile(join(ui,'rainbot.png'),png);
const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
await writeFile(join(ui,'rainbot.ico'),Buffer.concat([header,png]));
const checksums=(await download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`)).toString('utf8');
const expected=checksums.split('\n').map(line=>line.trim().split(/\s+/)).find(parts=>parts[1] === 'win-x64/node.exe')?.[0];
if(!expected || !/^[a-f\d]{64}$/.test(expected))throw new Error('Missing official Node executable checksum.');
const executable=join(runtime,'node.exe');
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
if(!existsSync(executable) || hash(await readFile(executable)) !== expected) {
  const binary=await download(`https://nodejs.org/dist/v${nodeVersion}/win-x64/node.exe`);
  if(hash(binary) !== expected)throw new Error('Node executable checksum verification failed.');
  await writeFile(executable+'.tmp',binary);await rename(executable+'.tmp',executable);
}
await writeFile(join(runtime,'LICENSE'),await download(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`));
await writeFile(join(runtime,'runtime.json'),JSON.stringify({version:nodeVersion,platform:'win32',arch:'x64',sha256:expected},null,2));
// The package is assembled from this allowlist; source .env/data/personality are never copied.
for(const name of await readdir(backend))if(!['src','scripts','assets','node_modules','package.json','package-lock.json','PERSONALITY.template.md'].includes(name))throw new Error('Unexpected file in backend stage.');
console.log(`Prepared Windows x64 app resources with Node ${nodeVersion}. No user configuration or history was included.`);
