import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SettingsStore } from '../src/settings.js';
import { DesktopController } from '../src/desktop/controller.js';
import { InstallationImport } from '../src/desktop/migration.js';
import { authURL, resourcePath, validSender, validateRequest } from '../desktop/security.mjs';
import { login } from '../src/auth.js';

const codec=(value: string)=>value;
const ids={DISCORD_APPLICATION_ID:'123456789012345678',DISCORD_GUILD_ID:'223456789012345678',OWNER_DISCORD_ID:'323456789012345678'};
test('cancelled sign-in does not open a browser, read credentials, or contact a provider',async()=>{
  let opened=false;
  await assert.rejects(login({signal:AbortSignal.abort(),openBrowser:()=>{opened=true;}}),/cancelled/);
  assert.equal(opened,false);
});
test('desktop bridge rejects unknown operations, arbitrary arguments and foreign/subframe senders',()=>{
  assert.throws(()=>validateRequest('exec',{command:'anything'}));
  assert.throws(()=>validateRequest('start',{pid:123}));
  assert.throws(()=>validateRequest('saveSettings',{large:'x'.repeat(20000)}));
  assert.throws(()=>validateRequest('importCommit',{source:'C:/private'}));
  validateRequest('operation',{id:'12345678-1234-1234-1234-123456789012'});
  const frame={url:'rainbot://app/#settings'}, contents={mainFrame:frame};
  assert.equal(validSender({sender:contents,senderFrame:frame},{webContents:contents}),true);
  assert.equal(validSender({sender:contents,senderFrame:{url:frame.url}},{webContents:contents}),false);
  frame.url='https://example.com/';
  assert.equal(validSender({sender:contents,senderFrame:frame},{webContents:contents}),false);
});
test('desktop resources and authorization destinations are tightly restricted',()=>{
  assert.equal(resourcePath('rainbot://app/app.js','C:/ui'),join('C:/ui','app.js'));
  assert.equal(resourcePath('rainbot://app/#settings','C:/ui'),join('C:/ui','index.html'));
  for(const url of ['rainbot://other/app.js','rainbot://app/.env','rainbot://app/%2e%2e%2f.env','file:///C:/ui/app.js','rainbot://app/app.js?file=.env'])assert.equal(resourcePath(url,'C:/ui'),undefined);
  assert.equal(authURL('https://auth.openai.com/api/accounts/authorize?state=fixture'),'https://auth.openai.com/api/accounts/authorize?state=fixture');
  for(const url of ['https://evil.example/api/accounts/authorize','javascript:alert(1)','https://auth.openai.com/other','https://user@auth.openai.com/api/accounts/authorize'])assert.throws(()=>authURL(url));
});
test('desktop controller validates requests and redacts saved credentials',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rainbot-desktop-'));
  try {
    const settings=new SettingsStore(root,{},codec), controller=new DesktopController(settings);
    await assert.rejects(controller.dispatch('start',{pid:1}));
    await assert.rejects(controller.dispatch('unknown',{}));
    await assert.rejects(controller.dispatch('operation',{id:'invalid'}));
    const result=await controller.dispatch('saveSettings',{revision:'legacy',values:ids,secrets:{DISCORD_BOT_TOKEN:{action:'replace',value:'synthetic-token'}}});
    assert.equal(JSON.stringify(result).includes('synthetic-token'),false);
    assert.equal((await controller.dispatch('settings') as ReturnType<SettingsStore['view']>).secrets.DISCORD_BOT_TOKEN,true);
    writeFileSync(join(root,'data/import.pending'),'{}');
    await assert.rejects(controller.dispatch('start',{}),/interrupted import/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('import copies consistent databases and settings without copying ownership or changing source',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rainbot-import-')), source=join(root,'source'), destination=join(root,'destination');
  try {
    mkdirSync(join(source,'src'),{recursive:true});writeFileSync(join(source,'src/main.ts'),'// fixture');writeFileSync(join(source,'package.json'),'{}');
    writeFileSync(join(source,'.env'),`${Object.entries(ids).map(([key,value])=>`${key}=${value}`).join('\n')}\nDISCORD_BOT_TOKEN=synthetic-token\nRAIN_VOLUME=0.2\n`);
    mkdirSync(join(source,'data/ai'),{recursive:true});
    const db=new DatabaseSync(join(source,'data/ai/conversations.sqlite'));db.exec('CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'preserved\')');db.close();
    writeFileSync(join(source,'PERSONALITY.md'),'Synthetic personality');
    const importer=new InstallationImport(destination,async()=>null,codec);
    assert.equal((await importer.preview(source)).databases,1);
    await importer.commit(source);
    const copied=new DatabaseSync(join(destination,'data/ai/conversations.sqlite'));
    assert.equal(copied.prepare('SELECT value FROM fixture').get()?.value,'preserved');copied.close();
    assert.equal(new SettingsStore(destination,{},codec).effective().env.DISCORD_BOT_TOKEN,'synthetic-token');
    assert.equal(existsSync(join(source,'data/ai/runtime.lock')),false);
    assert.equal(existsSync(join(destination,'data/ai/runtime.lock')),false);
    assert.equal(existsSync(join(destination,'data/import.pending')),false);
    assert.equal(readFileSync(join(source,'PERSONALITY.md'),'utf8'),'Synthetic personality');
    await assert.rejects(importer.commit(source),/empty desktop profile/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('import refuses live/stale locks, incompatible encrypted credentials, and partial profiles',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rainbot-import-reject-')), source=join(root,'source'), destination=join(root,'destination');
  try {
    mkdirSync(join(source,'src'),{recursive:true});writeFileSync(join(source,'src/main.ts'),'// fixture');writeFileSync(join(source,'package.json'),'{}');
    writeFileSync(join(source,'.env'),`DISCORD_APPLICATION_ID=${ids.DISCORD_APPLICATION_ID}\n`);
    mkdirSync(join(source,'data/ai'),{recursive:true});
    writeFileSync(join(source,'data/ai/runtime.lock'),'123');
    const importer=new InstallationImport(destination,async()=>null,codec);
    await assert.rejects(importer.preview(source),/verified recovery/);
    rmSync(join(source,'data/ai/runtime.lock'));
    writeFileSync(join(source,'data/ai/chatgpt.dpapi'),'invalid protected grant');writeFileSync(join(source,'data/ai/host-id'),'synthetic-host');
    await assert.rejects(importer.commit(source));
    assert.equal(existsSync(join(destination,'data/dashboard/settings.json')),false);
    assert.equal(existsSync(join(source,'data/ai/runtime.lock')),false);
    mkdirSync(join(destination,'data'),{recursive:true});writeFileSync(join(destination,'data/import.pending'),'{}');
    await assert.rejects(importer.preview(source),/interrupted import/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
