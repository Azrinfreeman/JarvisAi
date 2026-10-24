import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsStore } from '../src/settings.js';

// Reversible test codec; production always uses CurrentUser DPAPI.
const codec = (value: string, decrypt = false) => decrypt ? Buffer.from(value,'base64').toString() : Buffer.from(value).toString('base64');
function fixture(run: (store: SettingsStore) => void) {
  const root=mkdtempSync(join(tmpdir(),'rainbot-settings-'));
  try { run(new SettingsStore(root,{},codec)); } finally { rmSync(root,{recursive:true,force:true}); }
}

test('settings preserve legacy configuration, defaults, aliases, and explicit environment precedence',() => fixture(store => {
  writeFileSync(join(store.root,'.env'),'DISCORD_TOKEN=legacy-token\nCHATGPT_MODEL=legacy-model\nRAIN_VOLUME=0.2\nAI_DATA_DIR=custom-data\n');
  assert.equal(store.effective().env.DISCORD_BOT_TOKEN,'legacy-token');
  assert.equal(store.effective().env.DISCORD_TOKEN,undefined);
  assert.equal(store.effective().env.AI_DATA_DIR,join(store.root,'custom-data'));
  writeFileSync(join(store.root,'.env'),'DISCORD_TOKEN=legacy-token\nCHATGPT_MODEL=legacy-model\nRAIN_VOLUME=0.20\nAI_DATA_DIR=custom-data\n');
  assert.equal(store.view().values.RAIN_VOLUME,'0.2');
  store.update({revision:'legacy',values:{CHATGPT_MODEL:'saved-model'}});
  assert.equal(store.effective().env.CHATGPT_MODEL,'saved-model');
  const external=new SettingsStore(store.root,{CHATGPT_MODEL:'deployment-model',DISCORD_TOKEN:'external-token'},codec);
  assert.equal(external.effective().env.CHATGPT_MODEL,'deployment-model');
  assert.equal(external.effective().env.DISCORD_BOT_TOKEN,'external-token');
  assert.ok(external.view().overridden.includes('DISCORD_BOT_TOKEN'));
  assert.throws(() => external.update({revision:external.view().revision,values:{CHATGPT_MODEL:'ignored'}}),/deployment environment/);
}));

test('credential replacement is redacted and removal does not resurrect legacy secrets',() => fixture(store => {
  writeFileSync(join(store.root,'.env'),'DISCORD_TOKEN=legacy-token\nOPENAI_API_KEY=legacy-key\n');
  const first=store.update({revision:'legacy',values:{AI_PROVIDER:'openai'},secrets:{OPENAI_API_KEY:{action:'replace',value:'synthetic-new-key'}}});
  assert.equal(store.effective().env.OPENAI_API_KEY,'synthetic-new-key');
  assert.equal(first.secrets.OPENAI_API_KEY,true);
  assert.doesNotMatch(JSON.stringify(first),/synthetic|legacy-token|legacy-key/);
  const result=store.update({revision:first.revision,values:{},secrets:{OPENAI_API_KEY:{action:'remove'},DISCORD_BOT_TOKEN:{action:'remove'}}});
  assert.equal(store.effective().env.OPENAI_API_KEY,undefined);
  assert.equal(store.effective().env.DISCORD_BOT_TOKEN,undefined);
  assert.equal(store.effective().env.DISCORD_TOKEN,undefined);
  assert.equal(result.secrets.OPENAI_API_KEY,false);
  assert.doesNotMatch(readFileSync(join(store.directory,'settings.json'),'utf8'),/synthetic-new-key|legacy-token/);
}));

test('settings reject stale revisions, unknown fields, invalid IDs, models, secret actions, and control characters',() => fixture(store => {
  for (const input of [
    {revision:'legacy',values:{COMMAND:'node'}}, {revision:'legacy',values:{OWNER_DISCORD_ID:'abc'}},
    {revision:'legacy',values:{ALLOWED_ROLE_IDS:'123,456'}}, {revision:'legacy',values:{RAIN_VOLUME:'NaN'}},
    {revision:'legacy',values:{OPENAI_MODEL:'model\nsecret'}}, {revision:'legacy',values:{AI_PROVIDER:'arbitrary'}},
    {revision:'legacy',values:{OPENAI_WEB_SEARCH:'yes'}}, {revision:'legacy',values:{},secrets:{OPENAI_API_KEY:{action:'replace',value:'invalid key'}}},
    {revision:'legacy',values:{},secrets:{OPENAI_API_KEY:{action:'remove',value:'ignored'}}},
  ]) assert.throws(() => store.update(input));
  const first=store.update({revision:'legacy',values:{RAIN_VOLUME:'0.3'}});
  assert.throws(() => store.update({revision:'legacy',values:{RAIN_VOLUME:'0.8'}}),/another window/);
  assert.equal(store.view().revision,first.revision);
}));

test('failed encryption cannot replace a valid revision; previous settings reference intact credentials',() => fixture(store => {
  const first=store.update({revision:'legacy',values:{RAIN_VOLUME:'0.2'},secrets:{OPENAI_API_KEY:{action:'replace',value:'synthetic-key'}}});
  const failing=new SettingsStore(store.root,{},(value,decrypt) => { if (!decrypt) throw new Error('encryption failed'); return codec(value,true); });
  assert.throws(() => failing.update({revision:first.revision,values:{RAIN_VOLUME:'0.9'}}));
  assert.equal(store.view().revision,first.revision);
  assert.equal(store.effective().env.OPENAI_API_KEY,'synthetic-key');
  store.update({revision:first.revision,values:{RAIN_VOLUME:'0.3'}});
  const backup=JSON.parse(readFileSync(join(store.directory,'settings.previous.json'),'utf8'));
  assert.equal(backup.revision,first.revision);
  assert.ok(existsSync(join(store.directory,backup.secretsFile)));
  assert.ok(readdirSync(store.directory).every(name => !name.endsWith('.tmp') && name !== 'settings.lock'));
}));

test('corrupted settings or encrypted credentials fail closed',() => fixture(store => {
  store.update({revision:'legacy',values:{RAIN_VOLUME:'0.2'}});
  const doc=JSON.parse(readFileSync(join(store.directory,'settings.json'),'utf8'));
  writeFileSync(join(store.directory,doc.secretsFile),'broken');
  const view=store.view();
  assert.equal(view.credentialsUnreadable,true);
  assert.deepEqual(view.secrets,{DISCORD_BOT_TOKEN:false,OPENAI_API_KEY:false});
  writeFileSync(join(store.directory,'settings.json'),JSON.stringify({...doc,secretsFile:'../../.env'}));
  assert.throws(() => store.effective(),/unreadable/);
}));

test('launch environment excludes inherited injection and unrelated credentials',() => fixture(store => {
  const deployment=new SettingsStore(store.root,{PATH:'runtime',NODE_OPTIONS:'injected',NODE_PATH:'injected',OTHER_SECRET:'secret',OPENAI_API_KEY:'key'},codec);
  assert.deepEqual(deployment.launchEnvironment(),{PATH:'runtime',OPENAI_API_KEY:'key'});
}));
