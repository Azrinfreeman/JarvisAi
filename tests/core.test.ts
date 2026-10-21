import test from 'node:test';
import assert from 'node:assert/strict';
import { authorized, botConfig, reasoningEffort } from '../src/config.js';
import { Conversations } from '../src/storage.js';
import { RequestQueue, splitReply } from '../src/queue.js';
import { ChatGPTProvider, consumeResponse, sseEvents } from '../src/provider.js';
import { safeError } from '../src/errors.js';

const config = { guildId: 'g1', ownerId: 'owner', channels: ['c1'], roles: ['r1'] };
test('access fails closed for other users, servers, channels, roles and DMs', () => {
  const allowed = { guildId: 'g1', userId: 'owner', channelId: 'c1', roles: ['r1'] };
  assert.equal(authorized(config, allowed), true);
  for (const change of [{ userId: 'other' }, { guildId: 'other' }, { guildId: null }, { channelId: 'c2' }, { roles: [] }]) {
    assert.equal(authorized(config, { ...allowed, ...change }), false);
  }
  assert.throws(() => botConfig({ AI_PROVIDER: 'paid-api' }));
  assert.throws(() => botConfig({ DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: 'x' }));
});

test('server access admits different members but preserves guild, role and channel restrictions', () => {
  const server = { ...config, accessMode: 'server' };
  const member = { guildId: 'g1', userId: 'member-a', channelId: 'c1', roles: ['r1'] };
  assert.equal(authorized(server, member), true);
  assert.equal(authorized(server, { ...member, userId: 'member-b' }), true);
  assert.equal(authorized(server, { ...member, guildId: 'other' }), false);
  assert.equal(authorized(server, { ...member, guildId: null }), false);
  assert.equal(authorized(server, { ...member, channelId: 'other' }), false);
  assert.equal(authorized(server, { ...member, roles: [] }), false);
  assert.throws(() => botConfig({ ACCESS_MODE: 'invalid' }), /ACCESS_MODE/);
});

test('context is isolated, bounded to complete turns, and deleted by reset', () => {
  const store = new Conversations(':memory:');
  try {
    store.append('member-a', 'secret-a', 'answer-a');
    assert.deepEqual(store.get('member-b'), []);
    store.append('member-b', 'question-b', 'answer-b');
    for (let i = 0; i < 20; i++) store.append('member-a', `question-${i}`, `answer-${i}`);
    assert.equal(store.get('member-a').length, 20);
    assert.equal(store.get('member-a')[0]?.role, 'user');
    store.reset('member-a');
    assert.deepEqual(store.get('member-a'), []);
    assert.equal(store.get('member-b')[0]?.content, 'question-b');
  } finally { store.close(); }
});

test('queue bounds capacity and duplicate requests and recovers after rejection', async () => {
  const queue = new RequestQueue(2, 0);
  let finish!: () => void;
  const first = queue.run('a', () => new Promise<void>(resolve => { finish = resolve; }));
  const second = queue.run('b', async () => { throw new Error('failed'); });
  const rejection = assert.rejects(second, /failed/);
  await assert.rejects(queue.run('a', async () => {}), /already/);
  await assert.rejects(queue.run('c', async () => {}), /busy/);
  await Promise.resolve(); finish();
  await first; await rejection;
  assert.equal(await queue.run('c', async () => 42), 42);
});

test('queue enforces cooldown after a completed request', async () => {
  const queue = new RequestQueue(2, 5000);
  await queue.run('a', async () => {});
  await assert.rejects(queue.run('a', async () => {}), /few seconds/);
});

test('members cannot bypass cooldown by switching channels or reply visibility', async () => {
  const queue = new RequestQueue(4, 5000);
  await queue.run('channel-a:private', async () => {}, 'member-a');
  await assert.rejects(queue.run('channel-b:public', async () => {}, 'member-a'), /few seconds/);
  assert.equal(await queue.run('channel-b:public', async () => 42, 'member-b'), 42);
});

function stream(events: unknown[], chunkSize = 1): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map(event => `event: response\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
    controller.close();
  } });
}

test('stream handles byte-split UTF-8 and CRLF then requires completion', async () => {
  assert.equal(await consumeResponse(stream([
    { type: 'response.output_text.delta', delta: 'Hello 😀' }, { type: 'response.completed' },
  ])), 'Hello 😀');
  await assert.rejects(consumeResponse(stream([{ type: 'response.output_text.delta', delta: 'partial' }])), /before completion/);
});

test('a usage failure after text deltas is an error, not a successful answer', async () => {
  await assert.rejects(consumeResponse(stream([
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'sensitive provider details' } } },
  ])), /usage is currently limited/);
  await assert.rejects(consumeResponse(stream([{ type: 'response.incomplete' }])), /incomplete/);
  await assert.rejects(consumeResponse(stream([{ type: 'response.completed' }])), /without a text/);
  await assert.rejects(consumeResponse(stream([{ type: 'response.output_text.delta', delta: '123456' }]), 5), /output limit/);
});

test('malformed and oversized stream events are rejected', async () => {
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {bad}\n\n')); c.close(); } });
  await assert.rejects(async () => { for await (const _ of sseEvents(body)) {} }, /invalid stream/);
  const big = stream([{ type: 'x', payload: 'x'.repeat(1_000_001) }], 200000);
  await assert.rejects(async () => { for await (const _ of sseEvents(big)) {} }, /oversized/);
});

test('reply splitting preserves text, Unicode, and Discord content limits', () => {
  const content = 'a'.repeat(1899) + '😀' + '\n' + 'b'.repeat(4000);
  const chunks = splitReply(content);
  assert.equal(chunks.join(''), content);
  assert.ok(chunks.every(chunk => chunk.length <= 1900));
  assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
});

test('unexpected errors never expose credentials or response bodies', () => {
  assert.ok(!safeError(new Error('access_token=secret')).includes('secret'));
});

test('subscription adapter sends only supported request fields with OAuth, never a paid fallback', async () => {
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-oauth');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.model, 'account-visible-model');
    assert.deepEqual(body.input, [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(Object.keys(body).sort(), ['input', 'instructions', 'model', 'store', 'stream', 'tool_choice', 'tools']);
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.equal(body.tool_choice, 'auto');
    return new Response(stream([{ type: 'response.output_text.delta', delta: 'hello' }, { type: 'response.completed' }]));
  };
  const provider = new ChatGPTProvider('account-visible-model', async () => 'synthetic-oauth', request);
  assert.equal(await provider.generate([{ role: 'user', content: 'hello' }], AbortSignal.timeout(1000)), 'hello');
  assert.equal(calls, 1);
  let attempts = 0;
  const limited = new ChatGPTProvider('model', async () => 'synthetic-oauth', async () => {
    attempts++; return new Response('sensitive provider response', { status: 429 });
  });
  await assert.rejects(limited.generate([], AbortSignal.timeout(1000)), /No paid API fallback/);
  assert.equal(attempts, 1);
});

test('speed configuration sends explicit reasoning effort only when requested', async () => {
  assert.equal(reasoningEffort({}), undefined);
  assert.equal(reasoningEffort({ CHATGPT_REASONING_EFFORT: 'none' }), 'none');
  assert.throws(() => reasoningEffort({ CHATGPT_REASONING_EFFORT: 'invalid' }), /must be/);
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-6-luna');
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(body.store, false);
    return new Response(stream([{ type: 'response.output_text.delta', delta: 'hello' }, { type: 'response.completed' }]));
  };
  const provider = new ChatGPTProvider('gpt-6-luna', async () => 'synthetic-oauth', request, 'none');
  assert.equal(await provider.generate([{ role: 'user', content: 'hello' }], AbortSignal.timeout(1000)), 'hello');
});
