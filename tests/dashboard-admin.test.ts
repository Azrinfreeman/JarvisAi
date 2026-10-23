import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { SettingsStore } from '../src/settings.js';
import { OwnerSessions } from '../src/dashboard/sessions.js';

async function fixture(run: (context: {call: ReturnType<typeof client>; settings: SettingsStore; origin: string; sessions: OwnerSessions; calls: string[]}) => Promise<void>) {
  const root=mkdtempSync(join(tmpdir(),'rainbot-admin-'));
  const settings=new SettingsStore(root,{},(value,decrypt) => decrypt ? Buffer.from(value,'base64').toString() : Buffer.from(value).toString('base64'));
  const sessions=new OwnerSessions(); const calls: string[]=[];
  const server=createDashboardServer(join(root,'missing-status.json'),{settings,sessions,request:async input => {
    const url=String(input);calls.push(url);
    if (url.endsWith('/models')) return Response.json({data:[{id:'api-model'}]});
    if (url.endsWith('/applications/@me')) return Response.json({id:'123456789012345678'});
    if (url.includes('/guilds/')) return Response.json({id:'123456789012345678'});
    return new Response('sensitive-provider-response',{status:401});
  }});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address==='object');
  const origin=`http://127.0.0.1:${address.port}`;
  try {await run({call:client(origin),settings,origin,sessions,calls});}
  finally {await new Promise<void>(resolve => server.close(() => resolve()));rmSync(root,{recursive:true,force:true});}
}
function client(origin: string) {
  let cookie='';let csrf='';
  return async (path: string,method='GET',body?: unknown,headers: Record<string,string>={}) => {
    const response=await fetch(origin+path,{method,signal:AbortSignal.timeout(10000),headers:{...(cookie ? {Cookie:cookie}:{}),...(body !== undefined ? {'Content-Type':'application/json',Origin:origin,'X-CSRF-Token':csrf}:{}),...headers},...(body !== undefined ? {body:JSON.stringify(body)}:{})});
    const value=await response.json();
    if (response.headers.has('set-cookie')) cookie=response.headers.get('set-cookie')!.split(';')[0]!;
    if (value.csrf) csrf=value.csrf;
    return {status:response.status,value,headers:response.headers};
  };
}

test('administrative reads and writes require a single-use local session and CSRF',async () => fixture(async ({call,sessions,origin,settings}) => {
  assert.equal((await call('/api/session')).value.authorized,false);
  assert.equal((await call('/api/settings')).status,401);
  assert.equal((await call('/api/bot/start','POST',{})).status,401);
  const code=sessions.accessCode();
  const connected=await call('/api/session','POST',{code});
  assert.equal(connected.status,200);assert.match(connected.headers.get('set-cookie')!,/HttpOnly; SameSite=Strict/);
  assert.equal((await call('/api/session','POST',{code})).status,400);
  assert.equal((await call('/api/settings')).status,200);
  assert.equal((await call('/api/management?fresh=1')).value.state,'stopped');
  assert.equal((await call('/api/settings','PUT',{revision:'legacy',values:{RAIN_VOLUME:'0.3'}},{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await call('/api/settings','PUT',{revision:'legacy',values:{RAIN_VOLUME:'0.3'}},{Origin:'https://elsewhere.example'})).status,403);
  assert.equal((await call('/api/settings','PUT',{revision:'legacy',values:{RAIN_VOLUME:'0.3'}},{Origin:''})).status,403);
  assert.equal(settings.view().revision,'legacy');
  assert.equal((await call('/api/settings','PUT',{revision:'legacy',values:{RAIN_VOLUME:'0.3'}},{Origin:origin})).status,200);
}));

test('settings save is redacted, bounded, and does not launch, register, or contact providers',async () => fixture(async ({call,sessions,calls,settings}) => {
  await call('/api/session','POST',{code:sessions.accessCode()});
  const saved=await call('/api/settings','PUT',{revision:'legacy',values:{AI_PROVIDER:'openai',OPENAI_MODEL:'api-model'},secrets:{OPENAI_API_KEY:{action:'replace',value:'synthetic-secret-key'}}});
  assert.equal(saved.status,200);assert.equal(saved.value.secrets.OPENAI_API_KEY,true);
  assert.doesNotMatch(JSON.stringify(saved.value),/synthetic-secret-key/);assert.deepEqual(calls,[]);
  assert.equal(existsSync(join(settings.directory,'supervisor.json')),false);
  assert.equal((await call('/api/bot/start','POST',{pid:123,command:'arbitrary'})).status,400);
  assert.equal((await call('/api/settings','PUT',{revision:saved.value.revision,values:{UNKNOWN:'value'}})).status,400);
  assert.equal((await call('/api/settings','PUT',{revision:saved.value.revision,values:{CHATGPT_MODEL:'x'.repeat(17000)}})).status,413);
}));

test('catalog test makes no inference and repeated test requests are limited',async () => fixture(async ({call,sessions,calls,settings}) => {
  settings.update({revision:'legacy',values:{AI_PROVIDER:'openai',OPENAI_MODEL:'api-model'},secrets:{OPENAI_API_KEY:{action:'replace',value:'synthetic-secret-key'}}});
  await call('/api/session','POST',{code:sessions.accessCode()});
  const catalog=await call('/api/settings/test-ai','POST',{});
  assert.equal(catalog.status,200);assert.deepEqual(catalog.value.models,['api-model']);
  assert.deepEqual(calls,['https://api.openai.com/v1/models']);
  assert.equal((await call('/api/settings/test-ai-response','POST',{})).status,429);
  assert.equal(calls.length,1);
}));

test('an explicit response check invokes only the selected API and returns a sanitized failure',async () => fixture(async ({call,sessions,calls,settings}) => {
  settings.update({revision:'legacy',values:{AI_PROVIDER:'openai',OPENAI_MODEL:'api-model'},secrets:{OPENAI_API_KEY:{action:'replace',value:'synthetic-secret-key'}}});
  await call('/api/session','POST',{code:sessions.accessCode()});
  const response=await call('/api/settings/test-ai-response','POST',{});
  assert.equal(response.status,400);
  assert.deepEqual(calls,['https://api.openai.com/v1/responses']);
  assert.doesNotMatch(JSON.stringify(response.value),/synthetic-secret-key|sensitive-provider-response/);
}));

test('separate dashboard sessions do not share authorization cookies',async () => {
  const first=new OwnerSessions();const second=new OwnerSessions();
  const result=first.exchange(first.accessCode());
  const req={headers:{cookie:result.cookie.split(';')[0]}} as import('node:http').IncomingMessage;
  assert.ok(first.get(req));assert.equal(second.get(req),undefined);
});

test('authorized mutation requests are rate limited without launching a process',async () => fixture(async ({call,sessions,settings}) => {
  await call('/api/session','POST',{code:sessions.accessCode()});
  for (let i=0;i<30;i++) assert.equal((await call('/api/bot/start','POST',{pid:0})).status,400);
  assert.equal((await call('/api/bot/start','POST',{})).status,429);
  assert.equal(existsSync(join(settings.directory,'supervisor.json')),false);
}));
