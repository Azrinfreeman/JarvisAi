import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTProvider, consumeResponse, type ProviderMessage } from '../src/provider.js';
import { renderWebCitations, webSearchInstructions } from '../src/web-search.js';

function stream(events: unknown[]): ReadableStream<Uint8Array> {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')).body!;
}
const source = { type: 'url_citation', url: 'https://nodejs.org/en/blog/release/v24.0.0', title: 'Node.js release' };

test('search stays optional and uses all supplied context with Luna/high and subscription-only fields', async () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'My previous question' }, { role: 'assistant', content: 'My previous answer' },
    { role: 'user', content: [{ type: 'input_text', text: 'Explain the selected message: quoted context' },
      { type: 'input_image', image_url: 'data:image/png;base64,synthetic', detail: 'auto' }] },
  ];
  let calls = 0;
  const provider = new ChatGPTProvider('gpt-6-luna', async () => 'synthetic-oauth', async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.input, messages);
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.ok(body.instructions.endsWith(webSearchInstructions));
    assert.match(body.instructions, /available context is insufficient/);
    assert.match(body.instructions, /never send Discord identities, private messages/);
    return new Response(stream([{ type: 'response.output_text.delta', delta: 'Context answer' }, { type: 'response.completed' }]));
  }, 'high', () => 'Owner style');
  assert.equal(await provider.generate(messages, AbortSignal.timeout(1000)), 'Context answer');
  assert.equal(calls, 1);
});

test('streamed web citations become clickable beside claims and repeated metadata is deduplicated', async () => {
  const marker = '\uE200cite\uE202turn0search0\uE201';
  const text = `Release 😀 ${marker}`;
  const annotation = { ...source, start_index: Array.from('Release 😀 ').length, end_index: Array.from(text).length };
  const answer = await consumeResponse(stream([
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.output_text.annotation.added', annotation },
    { type: 'response.content_part.done', part: { annotations: [annotation] } },
    { type: 'response.completed' },
  ]));
  assert.equal(answer, `Release 😀 [Node.js release](${source.url})`);
});

test('completed output supplies canonical text and citations even without delta annotations', async () => {
  const answer = await consumeResponse(stream([
    { type: 'response.output_text.delta', delta: 'Partial' },
    { type: 'response.completed', response: { output: [
      { type: 'web_search_call', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text', text: 'Full answer', annotations: [source] }] },
    ] } },
  ]));
  assert.equal(answer, `Full answer\n\nSources: [Node.js release](${source.url})`);
});

test('unsafe citation URLs are dropped and Markdown syntax in titles/URLs is escaped', () => {
  const answer = renderWebCitations('Facts', [
    { ...source, url: 'javascript:alert(1)' }, { ...source, url: 'https://user:secret@example.com' },
    { ...source, url: 'https://example.com/page(test)', title: '[Click] @everyone\n*test*' },
    { type: 'file_citation', url: 'https://example.com/ignored' },
  ]);
  assert.ok(!answer.includes('javascript:'));
  assert.ok(!answer.includes('secret')); assert.ok(!answer.includes('@everyone'));
  assert.match(answer, /https:\/\/example.com\/page%28test%29/);
  assert.ok(!answer.includes('ignored'));
});

test('output cap includes final text and rendered source links', async () => {
  await assert.rejects(consumeResponse(stream([
    { type: 'response.output_text.delta', delta: 'Short' },
    { type: 'response.output_text.annotation.added', annotation: source },
    { type: 'response.completed' },
  ]), 10), /output limit/);
  await assert.rejects(consumeResponse(stream([
    { type: 'response.completed', response: { output: [
      { type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(30) }] },
    ] } },
  ]), 10), /output limit/);
});

test('a late tool/provider failure is not delivered as a partial successful answer', async () => {
  await assert.rejects(consumeResponse(stream([
    { type: 'response.output_text.delta', delta: 'Partial fact' },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
  ])), /usage is currently limited/);
});
