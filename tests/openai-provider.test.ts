import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, apiModels } from '../src/openai-provider.js';
import { workerEnvironment } from '../src/integration/protocol.js';

function stream(events: object[]) { return new ReadableStream<Uint8Array>({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } }); }
const completed = [{type:'response.output_text.delta',delta:'Answer'}, {type:'response.completed'}];

test('API adapter sends server-side credentials and images with explicit options and no default search',async () => {
  let calls=0;
  const request: typeof fetch=async (url,init) => {
    calls++; assert.equal(String(url),'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-api-key');
    const body=JSON.parse(String(init?.body));
    assert.equal(body.model,'api-model'); assert.equal(body.store,false); assert.equal(body.stream,true);
    assert.deepEqual(body.tools,[]); assert.equal(body.reasoning,undefined); assert.equal(body.max_output_tokens,4000);
    assert.equal(body.tool_choice,undefined);
    assert.match(body.instructions,/Web search is disabled/);
    assert.equal(body.input[0].content[1].type,'input_image');
    assert.equal(init?.redirect,'error');
    return new Response(stream(completed));
  };
  const provider=new OpenAIProvider('api-model','synthetic-api-key',undefined,false,request);
  assert.equal(await provider.generate([{role:'user',content:[{type:'input_text',text:'Describe'},{type:'input_image',image_url:'data:image/png;base64,synthetic',detail:'auto'}]}],AbortSignal.timeout(1000)),'Answer');
  assert.equal(calls,1);
});

test('API failures are sanitized, use API-specific guidance, and never retry or fall back',async () => {
  for (const status of [401,403,404,429,500]) {
    let calls=0;
    const provider=new OpenAIProvider('api-model','synthetic-api-key',undefined,false,async () => { calls++; return new Response('private-provider-response',{status}); });
    await assert.rejects(provider.generate([],AbortSignal.timeout(1000)),error => {
      assert.doesNotMatch(String(error),/synthetic-api-key|private-provider-response|ChatGPT plan|auth -- login/); return true;
    });
    assert.equal(calls,1);
  }
  const limited=new OpenAIProvider('api-model','key',undefined,false,async () => new Response(stream([{type:'response.output_text.delta',delta:'partial'},{type:'response.failed',response:{error:{code:'insufficient_quota'}}}])));
  await assert.rejects(limited.generate([],AbortSignal.timeout(1000)),/quota and billing/);
});

test('API nickname actions retain exact capability checks and completion gating',async () => {
  const capability={targetId:'123456789012345678',nickname:'Exact name'};
  let actions=0;
  const request: typeof fetch=async (_url,init) => {
    const body=JSON.parse(String(init?.body));
    assert.equal(body.tools.length,2); assert.equal(body.tools[0].type,'web_search');
    assert.equal(body.reasoning.effort,'low'); assert.equal(body.parallel_tool_calls,false);
    return new Response(stream([{type:'response.completed',response:{output:[{type:'function_call',name:'change_server_nickname',arguments:JSON.stringify(capability)}]}}]));
  };
  const provider=new OpenAIProvider('model','key','low',true,request);
  assert.equal(await provider.generate([],AbortSignal.timeout(1000),{nickname:{request:capability,execute:async () => {actions++;return 'Confirmed';}}}),'Confirmed');
  assert.equal(actions,1);
  const mismatch=new OpenAIProvider('model','key',undefined,false,async () => new Response(stream([{type:'response.completed',response:{output:[{type:'function_call',name:'change_server_nickname',arguments:JSON.stringify({...capability,nickname:'Other'})}]}}])));
  await assert.rejects(mismatch.generate([],AbortSignal.timeout(1000),{nickname:{request:capability,execute:async () => {actions++;return 'bad';}}}),/did not match/);
  assert.equal(actions,1);
});

test('API catalog parsing is distinct from subscription catalogs and never performs inference',async () => {
  let url='';
  const models=await apiModels('key',async input => {url=String(input);return Response.json({data:[{id:'z-model'},{id:'a-model'},{id:'<unsafe>'},{}]});});
  assert.equal(url,'https://api.openai.com/v1/models'); assert.deepEqual(models,['a-model','z-model']);
  await assert.rejects(apiModels('key',async () => Response.json({models:[]})),/unexpected model catalog/);
});

test('only explicit API mode passes its credential into the isolated worker',() => {
  const env={AI_PROVIDER:'chatgpt',OPENAI_API_KEY:'private-key',DISCORD_BOT_TOKEN:'discord-secret',NODE_OPTIONS:'injection'};
  assert.equal(workerEnvironment(env).OPENAI_API_KEY,undefined);
  assert.deepEqual(workerEnvironment({...env,AI_PROVIDER:'openai',OPENAI_MODEL:'model'}),{AI_PROVIDER:'openai',OPENAI_API_KEY:'private-key',OPENAI_MODEL:'model'});
});
