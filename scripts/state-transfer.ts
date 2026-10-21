import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, copyFileSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

export async function copyDatabase(source:string,destination:string) {
  if (existsSync(destination)) throw new Error('Refusing to overwrite an existing destination database.');
  mkdirSync(dirname(destination),{recursive:true});
  const db=new DatabaseSync(source,{readOnly:true});
  try { await backup(db,destination); } finally { db.close(); }
  const copied=new DatabaseSync(destination,{readOnly:true});
  try { if (copied.prepare('PRAGMA quick_check').get()!.quick_check!=='ok') throw new Error('Copied database failed integrity verification.'); }
  finally { copied.close(); }
}

async function main() {
  const rehearsal=process.argv.includes('--rehearsal');
  if (!rehearsal && !process.argv.includes('--originals-stopped')) throw new Error('Verify and stop both original runtimes first; then pass --originals-stopped.');
  const sourceAI=resolve('../data'); const sleepRoot=resolve('../../DiscordSleepBot');
  const env=parseEnv(readFileSync(join(sleepRoot,'.env'),'utf8'));
  const sleepDB=resolve(sleepRoot,env.DATABASE_PATH || 'data/sessions.sqlite');
  if (!rehearsal && existsSync(join(sourceAI,'runtime.lock'))) throw new Error('Original AI runtime/auth lock still exists; confirm its owner has exited first.');
  const archive=resolve('data/backups',`${rehearsal?'rehearsal':'cutover'}-${Date.now()}`);
  mkdirSync(archive,{recursive:true});
  await copyDatabase(join(sourceAI,'conversations.sqlite'),join(archive,'conversations.sqlite'));
  await copyDatabase(sleepDB,join(archive,'sessions.sqlite'));
  if (!rehearsal) {
    for (const file of ['chatgpt.dpapi','host-id']) copyFileSync(join(sourceAI,file),join(archive,file),constants.COPYFILE_EXCL);
    mkdirSync('data/ai',{recursive:true}); mkdirSync('data/sleep',{recursive:true});
    for (const file of ['chatgpt.dpapi','host-id','conversations.sqlite']) copyFileSync(join(archive,file),join('data/ai',file),constants.COPYFILE_EXCL);
    copyFileSync(join(archive,'sessions.sqlite'),'data/sleep/sessions.sqlite',constants.COPYFILE_EXCL);
  }
  writeFileSync(join(archive,'manifest.json'),JSON.stringify({at:new Date().toISOString(),rehearsal,integrity:'ok',originalsPreserved:true},null,2));
  console.log(`${rehearsal?'Rehearsal':'Cutover'} state copy passed SQLite integrity checks. Originals preserved; no credential or conversation contents displayed.`);
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await main();
