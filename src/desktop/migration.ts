import { DatabaseSync, backup } from 'node:sqlite';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SettingsStore, secretKeys, valueKeys, validateValues } from '../settings.js';
import { inspectProcess } from '../integration/runtime-control.js';
import { runtimeLock } from '../vault.js';
import { protect } from '../secret-protection.js';
import { readPersonality } from '../personality.js';
import { UserError } from '../errors.js';

function inside(root: string, path: string) {
  const rel = relative(realpathSync(root),realpathSync(path));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new UserError('Import files must stay inside the selected installation.');
  return path;
}
export class InstallationImport {
  constructor(private destination: string, private inspect = inspectProcess, private codec = protect) {}
  private source(path: string) {
    const root = realpathSync(path);
    if (root.toLowerCase() === resolve(this.destination).toLowerCase() || !existsSync(join(root,'package.json')) || !existsSync(join(root,'src/main.ts'))) throw new UserError('Select the existing combined bot project folder.');
    for (const parent of ['data','data/dashboard','data/ai','data/sleep','data/frontend']) {
      if (existsSync(join(root,parent))) inside(root,join(root,parent));
    }
    for(const file of ['.env','package.json','src/main.ts','data/dashboard/settings.json'])if(existsSync(join(root,file)))inside(root,join(root,file));
    const store = new SettingsStore(root,{},this.codec);
    const {env} = store.effective();
    for (const [key,expected] of [['AI_DATA_DIR','data/ai'],['SLEEP_DATABASE_PATH','data/sleep/sessions.sqlite']] as const) {
      if (env[key] && resolve(env[key]!).toLowerCase() !== resolve(root,expected).toLowerCase()) throw new UserError('This installation uses custom data paths. Use the documented manual migration procedure.');
    }
    const values = Object.fromEntries(valueKeys.map(key=>[key,env[key] ?? '']));
    validateValues(values);
    if (!/^\d{17,20}$/.test(env.DISCORD_APPLICATION_ID ?? '')) throw new UserError('Save a valid application ID in the source installation first.');
    return {root,env,values};
  }
  private emptyDestination() {
    if (existsSync(join(this.destination,'data/import.pending'))) throw new UserError('An interrupted import needs recovery. See the desktop recovery instructions.');
    for (const path of ['data/dashboard/settings.json','data/ai','data/sleep','data/frontend','PERSONALITY.md']) {
      if (existsSync(join(this.destination,path))) throw new UserError('Import requires an empty desktop profile. Existing data will not be overwritten.');
    }
  }
  private files(root: string) {
    const files = ['PERSONALITY.md','data/ai/chatgpt.dpapi','data/ai/host-id','data/ai/conversations.sqlite','data/sleep/sessions.sqlite'];
    const frontend = join(root,'data/frontend');
    if (existsSync(frontend)) {
      const dirs = readdirSync(frontend,{withFileTypes:true});
      if (dirs.length > 100) throw new UserError('Too many frontend profiles to import automatically.');
      for (const dir of dirs) {
        if (!dir.isDirectory() || !/^\d{17,20}$/.test(dir.name)) continue;
        inside(root,join(frontend,dir.name));
        files.push(`data/frontend/${dir.name}/nickname-events.sqlite`);
      }
    }
    return files.filter(path=>existsSync(join(root,path))).map(path=> {
      const full = inside(root,join(root,path));
      if (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) throw new UserError('Import requires ordinary local data files.');
      return path;
    });
  }
  private async stopped(root: string) {
    const locks = [join(root,'data/ai/runtime.lock')];
    const frontend=join(root,'data/frontend');
    if (existsSync(frontend)) for (const item of readdirSync(frontend,{withFileTypes:true})) {
      if (item.isDirectory()) locks.push(join(frontend,item.name,'runtime.lock'));
    }
    for (const lock of locks.filter(existsSync)) {
      const pid = Number(readFileSync(inside(root,lock),'utf8').trim());
      const live = Number.isSafeInteger(pid) && pid > 0 ? await this.inspect(pid) : null;
      throw new UserError(live ? 'Stop the source bot and any sign-in operation before importing.' : 'A source runtime lock needs verified recovery before importing.');
    }
  }
  async preview(path: string) {
    this.emptyDestination();
    const {root,env} = this.source(path); await this.stopped(root);
    const files = this.files(root);
    return {files:files.length, databases:files.filter(file=>file.endsWith('.sqlite')).length,
      protectedConnection:files.includes('data/ai/chatgpt.dpapi'),
      message:'Import saved settings, personality and history. The original installation will be preserved. Keep the original bot stopped after import.'};
  }
  async commit(path: string) {
    this.emptyDestination();
    const {root,env,values} = this.source(path); await this.stopped(root);
    const files = this.files(root);
    const releases: (()=>void)[] = [];
    const stage = join(this.destination,`.import-${randomUUID()}`);
    const published: string[] = [];
    const marker=join(this.destination,'data/import.pending');
    try {
      releases.push(runtimeLock(join(root,'data/frontend',env.DISCORD_APPLICATION_ID!)));
      releases.push(runtimeLock(join(root,'data/ai')));
      mkdirSync(stage,{recursive:true});
      if (files.includes('data/ai/chatgpt.dpapi')) {
        if (!files.includes('data/ai/host-id')) throw new UserError('The protected connection is missing its host binding. Reconnect the source account before importing.');
        // Verify DPAPI compatibility without exporting the credential to the interface.
        JSON.parse(this.codec(readFileSync(join(root,'data/ai/chatgpt.dpapi'),'utf8'),true));
      }
      const secrets = Object.fromEntries(secretKeys.filter(key=>env[key] && !env[key]!.startsWith('replace-with-')).map(key=>[key,{action:'replace',value:env[key]}]));
      new SettingsStore(stage,{},this.codec).update({revision:'legacy',values,secrets});
      for (const file of files) {
        const from=inside(root,join(root,file)), to=join(stage,file);
        mkdirSync(resolve(to,'..'),{recursive:true});
        if (file.endsWith('.sqlite')) {
          const db=new DatabaseSync(from,{readOnly:true});
          try {
            if (Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0] !== 'ok') throw new UserError('A source database failed its integrity check.');
            await backup(db,to);
          } finally { db.close(); }
          const copied=new DatabaseSync(to,{readOnly:true});
          try { if (Object.values(copied.prepare('PRAGMA quick_check').get() ?? {})[0] !== 'ok') throw new UserError('An imported database failed its integrity check.'); }
          finally { copied.close(); }
        } else {
          if (file === 'PERSONALITY.md') readPersonality(from);
          copyFileSync(from,to,constants.COPYFILE_EXCL);
        }
      }
      const docDir=join(stage,'data/dashboard');
      const settingsFiles=readdirSync(docDir).map(file=>`data/dashboard/${file}`);
      const order=[...files,...settingsFiles.filter(file=>!file.endsWith('/settings.json')),'data/dashboard/settings.json'];
      mkdirSync(join(this.destination,'data'),{recursive:true});
      writeFileSync(marker,JSON.stringify({version:1,files:order}),{flag:'wx',mode:0o600});
      for (const file of order) {
        const to=join(this.destination,file); mkdirSync(resolve(to,'..'),{recursive:true});
        copyFileSync(join(stage,file),to,constants.COPYFILE_EXCL); published.push(to);
      }
      unlinkSync(marker);
      return {message:'Installation imported. Keep the original bot stopped; review Settings before starting this copy.'};
    } catch(error) {
      for (const file of published.reverse()) unlinkSync(file);
      if (existsSync(marker)) unlinkSync(marker);
      throw error;
    } finally {
      if (existsSync(stage)) rmSync(stage,{recursive:true,force:true});
      for (const release of releases.reverse()) release();
    }
  }
}
