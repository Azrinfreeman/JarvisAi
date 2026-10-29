import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsStore, validateValues } from '../src/settings.js';
import { DashboardService, readVoiceSummaryStatus } from '../src/dashboard/service.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { OwnerSessions } from '../src/dashboard/sessions.js';
import { DesktopController } from '../src/desktop/controller.js';
import { validateRequest } from '../desktop/security.mjs';
import { LocalSpeechSetup } from '../src/voice-summary/local-setup.js';
import { voiceConfig } from '../src/voice-summary/config.js';
import { runInNewContext } from 'node:vm';

const codec = (value: string, decrypt = false) => decrypt ? Buffer.from(value,'base64').toString() : Buffer.from(value).toString('base64');
async function fixture(run: (settings: SettingsStore, path: string) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(),'rainbot-voice-settings-'));
  mkdirSync(join(root,'data'));
  try { await run(new SettingsStore(root,{},codec),join(root,'data/voice-summary-status.json')); }
  finally { rmSync(root,{recursive:true,force:true}); }
}
const snapshot = () => ({at:new Date().toISOString(),stopped:false,state:'listening',channelId:'123456789012345678',
  coverageSeconds:120.5,participants:3,model:'gpt-transcribe',message:'Listening.',usageSeconds:90});

test('voice defaults are disabled, bounded, and independent of the text provider', async () => fixture(settings => {
  const view = settings.view();
  assert.deepEqual(Object.fromEntries(Object.entries(view.values).filter(([key]) => key.startsWith('VOICE_'))), {
    VOICE_SUMMARY_ENABLED:'false',VOICE_SUMMARY_CONSENT_MODE:'individual',VOICE_SUMMARY_PROVIDER:'local',VOICE_SUMMARY_LOCAL_DEVICE:'vulkan',VOICE_SUMMARY_MODEL:'gpt-transcribe',VOICE_SUMMARY_LANGUAGES:'ms,en',
    VOICE_SUMMARY_GLOSSARY:'',VOICE_SUMMARY_MINUTES:'5',VOICE_SUMMARY_MONTHLY_MINUTES:'60',VOICE_SUMMARY_LANGUAGE:'Malay',
  });
  assert.equal(view.secrets.VOICE_SUMMARY_API_KEY,false);
  assert.ok(!view.missing.includes('VOICE_SUMMARY_API_KEY'));
  settings.update({revision:view.revision,values:{VOICE_SUMMARY_ENABLED:'true',AI_PROVIDER:'chatgpt'},secrets:{OPENAI_API_KEY:{action:'replace',value:'synthetic-text-key'}}});
  assert.ok(!settings.missing().includes('VOICE_SUMMARY_API_KEY'));
  assert.equal(settings.effective().env.VOICE_SUMMARY_API_KEY,undefined);
  const cloud=settings.update({revision:settings.view().revision,values:{VOICE_SUMMARY_PROVIDER:'openai'}});
  assert.ok(cloud.missing.includes('VOICE_SUMMARY_API_KEY'));
  const disabled=settings.update({revision:cloud.revision,values:{VOICE_SUMMARY_ENABLED:'false'}});
  assert.ok(!disabled.missing.includes('VOICE_SUMMARY_API_KEY'));
}));

test('voice settings validate windows, integer budget, model, language hints and glossary bounds', () => {
  for (const [key, values] of Object.entries({
    VOICE_SUMMARY_CONSENT_MODE:['','auto','true','SERVER'],
    VOICE_SUMMARY_ENABLED:['yes','1',''],VOICE_SUMMARY_PROVIDER:['cloud','whisper',''],VOICE_SUMMARY_LOCAL_DEVICE:['cuda','auto',''],VOICE_SUMMARY_MINUTES:['3','6','4.0','05',''],
    VOICE_SUMMARY_MONTHLY_MINUTES:['0','10001','1.1','1e2','-1','NaN','01',''],
    VOICE_SUMMARY_MODEL:['','x'.repeat(201),'../model','model\nkey'],
    VOICE_SUMMARY_LANGUAGES:['','Malay','ms,,en','ms;en','en-US','ms,en,'.repeat(30),'ms,en,fr,de,es,it'],
    VOICE_SUMMARY_GLOSSARY:['x'.repeat(1001),'terms\nprivate','<instruction>'],VOICE_SUMMARY_LANGUAGE:['',' ','x'.repeat(81),'Malay\0'],
  })) for (const value of values) assert.throws(() => validateValues({[key]:value}),`${key}: ${JSON.stringify(value)}`);
  validateValues({VOICE_SUMMARY_MINUTES:'4',VOICE_SUMMARY_MONTHLY_MINUTES:'1',VOICE_SUMMARY_LANGUAGES:'ms,en-us',
    VOICE_SUMMARY_MODEL:'gpt-transcribe',VOICE_SUMMARY_GLOSSARY:'x'.repeat(1000),VOICE_SUMMARY_LANGUAGE:'x'.repeat(80)});
  validateValues({VOICE_SUMMARY_MONTHLY_MINUTES:'10000',VOICE_SUMMARY_MINUTES:'5',VOICE_SUMMARY_PROVIDER:'local',VOICE_SUMMARY_LOCAL_DEVICE:'vulkan'});
  validateValues({VOICE_SUMMARY_PROVIDER:'openai',VOICE_SUMMARY_LOCAL_DEVICE:'cpu'});
});

test('server consent is explicitly saved and passed to the runtime, with individual consent as default',async()=>fixture(settings=>{
  assert.equal(voiceConfig({}).consentMode,'individual');
  const saved=settings.update({revision:settings.view().revision,values:{VOICE_SUMMARY_CONSENT_MODE:'server'}});
  assert.equal(saved.values.VOICE_SUMMARY_CONSENT_MODE,'server');
  assert.equal(voiceConfig(new SettingsStore(settings.root,{},codec).effective().env).consentMode,'server');
  const deployed=new SettingsStore(settings.root,{VOICE_SUMMARY_CONSENT_MODE:'server'},codec);
  assert.equal(voiceConfig(deployed.launchEnvironment()).consentMode,'server');
  for(const mode of ['','auto','true'])assert.throws(()=>voiceConfig({VOICE_SUMMARY_CONSENT_MODE:mode}),/Invalid voice-summary/);
}));

test('speech key is protected, redacted, independently replaced/removed and honors deployment precedence', async () => fixture(settings => {
  writeFileSync(join(settings.root,'.env'),'VOICE_SUMMARY_API_KEY=synthetic-legacy-speech\n');
  const saved=settings.update({revision:'legacy',values:{VOICE_SUMMARY_ENABLED:'true',VOICE_SUMMARY_PROVIDER:'openai'},
    secrets:{VOICE_SUMMARY_API_KEY:{action:'replace',value:'synthetic-protected-speech'}}});
  assert.equal(saved.secrets.VOICE_SUMMARY_API_KEY,true);
  assert.equal(settings.effective().env.VOICE_SUMMARY_API_KEY,'synthetic-protected-speech');
  assert.doesNotMatch(JSON.stringify(saved),/synthetic-/);
  assert.doesNotMatch(readFileSync(join(settings.directory,'settings.json'),'utf8'),/synthetic-/);
  const external = new SettingsStore(settings.root,{VOICE_SUMMARY_API_KEY:'synthetic-deployment-speech'},codec);
  assert.ok(external.view().overridden.includes('VOICE_SUMMARY_API_KEY'));
  assert.throws(() => external.update({revision:saved.revision,values:{},secrets:{VOICE_SUMMARY_API_KEY:{action:'remove'}}}),/deployment environment/);
  assert.equal(external.launchEnvironment().VOICE_SUMMARY_API_KEY,'synthetic-deployment-speech');
  const removed=settings.update({revision:saved.revision,values:{},secrets:{VOICE_SUMMARY_API_KEY:{action:'remove'}}});
  assert.equal(settings.effective().env.VOICE_SUMMARY_API_KEY,undefined);
  assert.equal(removed.secrets.VOICE_SUMMARY_API_KEY,false);
  assert.ok(removed.missing.includes('VOICE_SUMMARY_API_KEY'));
}));

test('saving voice configuration makes no provider request or implicit setup/transcription test', async t => fixture(async settings => {
  const begin=t.mock.method(LocalSpeechSetup.prototype,'begin',async () => { throw new Error('Unexpected setup'); });
  let requests=0;
  const service = new DashboardService(settings,undefined,async () => { requests++; throw new Error('Unexpected request'); });
  await service.save({revision:'legacy',values:{VOICE_SUMMARY_ENABLED:'true'},secrets:{VOICE_SUMMARY_API_KEY:{action:'replace',value:'synthetic-speech-key'}}});
  await service.voiceSummaryStatus();
  await assert.rejects(service.test('voice-summary'),/Unknown connection test/);
  assert.equal(requests,0);
  assert.equal(begin.mock.callCount(),0);
}));

test('private voice status exposes only bounded operational fields', async () => fixture(async (_settings,path) => {
  writeFileSync(path,JSON.stringify({...snapshot(),transcript:'private-transcript',audio:'private-audio',token:'private-token',speakers:['private-speaker']}));
  const status=await readVoiceSummaryStatus(path);
  assert.deepEqual(status, {state:'listening',channelId:'123456789012345678',coverageSeconds:120.5,participants:3,model:'gpt-transcribe',message:'Listening.',usageSeconds:90});
  assert.doesNotMatch(JSON.stringify(status),/private-|transcript|audio|token|speakers/);
  const {at,...published}=snapshot();
  writeFileSync(path,JSON.stringify({...published,updatedAt:at}));
  assert.deepEqual(await readVoiceSummaryStatus(path),status);
  writeFileSync(path,JSON.stringify({...snapshot(),channelId:'<script>',coverageSeconds:9999,participants:99.5,usageSeconds:-1,model:'<script>',message:'a\nb'.repeat(200)}));
  const bounded=await readVoiceSummaryStatus(path);
  assert.equal(bounded.coverageSeconds,300); assert.equal(bounded.participants,10); assert.equal(bounded.usageSeconds,0);
  assert.equal(bounded.model,''); assert.equal('channelId' in bounded,false);
  assert.equal(bounded.message.length,240); assert.doesNotMatch(bounded.message,/[\x00-\x1f]/);
}));

test('missing, oversized, stale, stopped and malformed voice snapshots reset to off', async () => fixture(async (_settings,path) => {
  const off=await readVoiceSummaryStatus(path);
  assert.equal(off.state,'off');
  for (const patch of [{at:new Date(Date.now()-30001).toISOString()}, {at:new Date(Date.now()+60000).toISOString()},
    {at:'invalid'}, {stopped:true}, {state:'unexpected'}]) {
    writeFileSync(path,JSON.stringify({...snapshot(),...patch}));
    const result=await readVoiceSummaryStatus(path);
    assert.equal(result.state,'off'); assert.equal(result.coverageSeconds,0); assert.equal(result.participants,0);
    assert.equal('channelId' in result,false);
  }
  for (const body of ['null','[]','{partial','x'.repeat(16385)]) {
    writeFileSync(path,body); assert.deepEqual(await readVoiceSummaryStatus(path),off);
  }
  writeFileSync(path,JSON.stringify(snapshot()));
  const old=new Date(Date.now()-31000); utimesSync(path,old,old);
  assert.deepEqual(await readVoiceSummaryStatus(path),off);
  const now=Date.now(); writeFileSync(path,JSON.stringify({...snapshot(),at:new Date(now-30000).toISOString()}));
  assert.equal((await readVoiceSummaryStatus(path,now)).state,'listening');
}));

test('HTTP voice status requires owner authentication and uses the configured settings root', async () => fixture(async (settings,path) => {
  writeFileSync(path,JSON.stringify({...snapshot(),transcript:'private-transcript'}));
  const sessions=new OwnerSessions(), server=createDashboardServer(undefined,{settings,sessions});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert.ok(address && typeof address === 'object');
  const origin=`http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(origin+'/api/voice-summary')).status,401);
    const connected=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:sessions.accessCode()})});
    const cookie=connected.headers.get('set-cookie')!.split(';')[0]!;
    const response=await fetch(origin+'/api/voice-summary',{headers:{Cookie:cookie}});
    assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
    const status=await response.json(); assert.equal(status.state,'listening'); assert.doesNotMatch(JSON.stringify(status),/private-transcript/);
    assert.equal((await fetch(origin+'/api/voice-summary',{headers:{Cookie:cookie,Origin:'https://elsewhere.example'}})).status,403);
    assert.equal((await fetch(origin+'/api/voice-summary',{method:'HEAD',headers:{Cookie:cookie}})).status,200);
    assert.equal((await fetch(origin+'/api/voice-summary',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test('desktop voice status is a fixed no-argument operation and returns the same sanitized status', async () => fixture(async (settings,path) => {
  validateRequest('voiceSummaryStatus',{});
  assert.throws(() => validateRequest('voiceSummaryStatus',{path:'elsewhere.json'}));
  const controller = new DesktopController(settings);
  await assert.rejects(controller.dispatch('voiceSummaryStatus',{path}),/does not accept arguments/);
  writeFileSync(path,JSON.stringify({...snapshot(),transcript:'private-transcript',audio:'private-audio'}));
  assert.deepEqual(await controller.dispatch('voiceSummaryStatus'),await readVoiceSummaryStatus(path));
}));


test('switching to local preserves the cloud credential/model and forwards local settings to the bot', async () => fixture(settings => {
  const saved=settings.update({revision:'legacy',values:{VOICE_SUMMARY_ENABLED:'true',VOICE_SUMMARY_PROVIDER:'openai',VOICE_SUMMARY_MODEL:'cloud-custom'},
    secrets:{VOICE_SUMMARY_API_KEY:{action:'replace',value:'synthetic-cloud-speech'}}});
  const local=settings.update({revision:saved.revision,values:{VOICE_SUMMARY_PROVIDER:'local',VOICE_SUMMARY_LOCAL_DEVICE:'cpu'}});
  assert.equal(local.values.VOICE_SUMMARY_MODEL,'cloud-custom');
  assert.equal(local.secrets.VOICE_SUMMARY_API_KEY,true);
  assert.equal(settings.effective().env.VOICE_SUMMARY_API_KEY,'synthetic-cloud-speech');
  assert.ok(!local.missing.includes('VOICE_SUMMARY_API_KEY'));
  const external=new SettingsStore(settings.root,{VOICE_SUMMARY_PROVIDER:'local',VOICE_SUMMARY_LOCAL_DEVICE:'cpu'},codec);
  assert.equal(external.launchEnvironment().VOICE_SUMMARY_PROVIDER,'local');
  assert.equal(external.launchEnvironment().VOICE_SUMMARY_LOCAL_DEVICE,'cpu');
  assert.throws(()=>external.update({revision:local.revision,values:{VOICE_SUMMARY_LOCAL_DEVICE:'vulkan'}}),/deployment environment/);
}));

const setupStatus = (state: 'missing'|'downloading'|'ready'|'failed' = 'missing') => ({state,message:state === 'downloading' ? 'Downloading model.' : 'Local setup status.',
  progress:state === 'downloading' ? 25 : state === 'ready' ? 100 : 0,model:'whisper-small',engineVersion:'pinned-version'});

test('service and desktop delegate fixed local setup operations without starting or enabling the bot', async t => fixture(async settings => {
  const service=new DashboardService(settings);
  assert.ok(service.localSpeech instanceof LocalSpeechSetup);
  const status=t.mock.method(service.localSpeech,'status',async () => setupStatus());
  const begin=t.mock.method(service.localSpeech,'begin',async () => setupStatus('downloading'));
  const cancel=t.mock.method(service.localSpeech,'cancel',() => setupStatus());
  const start=t.mock.method(service.supervisor,'begin',() => { throw new Error('Unexpected bot start'); });
  assert.deepEqual(await service.localSpeechStatus(),setupStatus());
  assert.deepEqual(await service.localSpeechSetup(),setupStatus('downloading'));
  assert.deepEqual(await service.localSpeechCancel(),setupStatus());
  assert.equal(status.mock.callCount(),1); assert.equal(begin.mock.callCount(),1); assert.equal(cancel.mock.callCount(),1);
  assert.equal(start.mock.callCount(),0);
  assert.equal(settings.view().values.VOICE_SUMMARY_ENABLED,'false');
  const controller=new DesktopController(settings);
  const operations={localSpeechStatus:'status',localSpeechSetup:'begin',localSpeechCancel:'cancel'} as const;
  for (const [operation, method] of Object.entries(operations)) {
    validateRequest(operation,{});
    assert.throws(()=>validateRequest(operation,{url:'https://untrusted.example/model'}),/does not accept arguments/);
    await assert.rejects(controller.dispatch(operation,{root:'elsewhere'}),/does not accept arguments/);
    const delegate=t.mock.method(controller.service.localSpeech,method,async () => setupStatus(method === 'begin' ? 'downloading' : 'missing'));
    assert.deepEqual(await controller.dispatch(operation),setupStatus(method === 'begin' ? 'downloading' : 'missing'));
    assert.equal(delegate.mock.callCount(),1);
  }
  assert.equal(settings.view().values.VOICE_SUMMARY_ENABLED,'false');
}));

test('local setup HTTP routes require authentication, CSRF and empty bounded requests; polling never begins setup', async t => fixture(async settings => {
  const status=t.mock.method(LocalSpeechSetup.prototype,'status',async () => setupStatus());
  const begin=t.mock.method(LocalSpeechSetup.prototype,'begin',async () => setupStatus('downloading'));
  const cancel=t.mock.method(LocalSpeechSetup.prototype,'cancel',async () => setupStatus());
  const sessions=new OwnerSessions(), server=createDashboardServer(undefined,{settings,sessions});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert.ok(address && typeof address === 'object');
  const origin=`http://127.0.0.1:${address.port}`, path='/api/voice-summary/local';
  try {
    assert.equal((await fetch(origin+path)).status,401);
    assert.equal((await fetch(origin+path+'/setup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,401);
    const connected=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:sessions.accessCode()})});
    const cookie=connected.headers.get('set-cookie')!.split(';')[0]!;
    const {csrf}=await connected.json();
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf};
    const response=await fetch(origin+path,{headers:{Cookie:cookie}});
    assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),setupStatus());
    assert.equal(status.mock.callCount(),1); assert.equal(begin.mock.callCount(),0);
    assert.equal((await fetch(origin+path,{method:'HEAD',headers:{Cookie:cookie}})).status,200);
    for (const action of ['setup','cancel']) {
      assert.equal((await fetch(origin+path+'/'+action,{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},body:'{}'})).status,403);
      assert.equal((await fetch(origin+path+'/'+action,{method:'POST',headers:{...headers,Origin:'https://elsewhere.example'},body:'{}'})).status,403);
      assert.equal((await fetch(origin+path+'/'+action,{method:'POST',headers,body:'{"url":"https://untrusted.example"}'})).status,400);
    }
    assert.equal(begin.mock.callCount(),0); assert.equal(cancel.mock.callCount(),0);
    assert.equal((await fetch(origin+path+'/setup',{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body:'{}'})).status,415);
    assert.equal((await fetch(origin+path+'/setup',{method:'POST',headers,body:JSON.stringify({payload:'x'.repeat(16385)})})).status,413);
    const setup=await fetch(origin+path+'/setup',{method:'POST',headers,body:'{}'});
    assert.equal(setup.status,202); assert.deepEqual(await setup.json(),setupStatus('downloading'));
    const cancelled=await fetch(origin+path+'/cancel',{method:'POST',headers,body:'{}'});
    assert.equal(cancelled.status,200); assert.deepEqual(await cancelled.json(),setupStatus());
    assert.equal(begin.mock.callCount(),1); assert.equal(cancel.mock.callCount(),1);
    assert.equal(settings.view().values.VOICE_SUMMARY_ENABLED,'false');
    // Existing per-session mutation limits also cover setup/cancel.
    let limited=false;
    for (let i=0;i<31;i++) {
      const next=await fetch(origin+path+'/cancel',{method:'POST',headers,body:'{}'});
      if (next.status === 429) { limited=true; break; }
      assert.equal(next.status,200);
    }
    assert.equal(limited,true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test('desktop transport and preload expose only fixed no-argument local setup routes', async () => {
  const calls: string[]=[];
  let bridge: Record<string,()=>Promise<unknown>>={};
  runInNewContext(readFileSync(new URL('../desktop/preload.cjs',import.meta.url),'utf8'),{
    require:(name: string)=>{assert.equal(name,'electron');return {
      contextBridge:{exposeInMainWorld:(name: string,value: typeof bridge)=>{assert.equal(name,'rainbot');bridge=value;}},
      ipcRenderer:{invoke:async (channel: string,operation: string,argument: unknown)=>{assert.equal(channel,'rainbot');calls.push(operation);assert.equal(JSON.stringify(argument),'{}');return setupStatus();}},
    };},
  });
  const window={rainbot:bridge} as {rainbot:typeof bridge;rainbotRequest:(path:string, options?:{method:string;body:string})=>Promise<{ok:boolean;json:()=>Promise<unknown>}>};
  runInNewContext(readFileSync(new URL('../src/dashboard/public/transport.js',import.meta.url),'utf8'),{window});
  for (const [path,method] of [['/api/voice-summary/local','GET'],['/api/voice-summary/local/setup','POST'],['/api/voice-summary/local/cancel','POST']]) {
    const response=await window.rainbotRequest(path!,{method:method!,body:'{}'});
    const body=await response.json();
    assert.equal(response.ok,true,JSON.stringify(body)); assert.deepEqual(body,setupStatus());
  }
  assert.deepEqual(calls,['localSpeechStatus','localSpeechSetup','localSpeechCancel']);
  assert.equal((await window.rainbotRequest('/api/voice-summary/local/arbitrary',{method:'POST',body:'{}'})).ok,false);
});
