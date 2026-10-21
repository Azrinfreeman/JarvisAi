import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseInstructions, botInstructions, readPersonality, maxPersonalityChars } from '../src/personality.js';
import { ChatGPTProvider } from '../src/provider.js';

test('personality changes are read on the next request without restarting and absent/blank files use the base', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-personality-'));
  const path = join(dir, 'PERSONALITY.md');
  const instructions: string[] = [];
  const provider = new ChatGPTProvider('gpt-6-luna', async () => 'synthetic', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); instructions.push(body.instructions);
    assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.deepEqual(body.input, [{ role: 'user', content: 'Hello' }]);
    return new Response('data: {"type":"response.output_text.delta","delta":"Hai"}\n\ndata: {"type":"response.completed"}\n\n');
  }, 'high', () => botInstructions(path));
  try {
    assert.equal(botInstructions(path), baseInstructions);
    writeFileSync(path, 'Jawab dalam Bahasa Melayu santai, aku/kau.');
    await provider.generate([{ role: 'user', content: 'Hello' }], AbortSignal.timeout(1000));
    writeFileSync(path, 'Guna loghat Kedah, hang/aku.');
    await provider.generate([{ role: 'user', content: 'Hello' }], AbortSignal.timeout(1000));
    assert.match(instructions[0]!, /Bahasa Melayu santai, aku\/kau/);
    assert.match(instructions[1]!, /loghat Kedah, hang\/aku/);
    assert.ok(!instructions[1]!.includes('Bahasa Melayu santai, aku/kau'));
    assert.ok(instructions.every(value => value.startsWith(baseInstructions)));
    writeFileSync(path, '  \n'); assert.equal(botInstructions(path), baseInstructions);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('oversized or unreadable personality files fail before inference without exposing file contents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-personality-'));
  const path = join(dir, 'PERSONALITY.md');
  let requests = 0;
  try {
    writeFileSync(path, 's'.repeat(maxPersonalityChars + 1));
    assert.throws(() => readPersonality(path), /at most 8000/);
    const provider = new ChatGPTProvider('gpt-6-luna', async () => 'synthetic', async () => {
      requests++; throw new Error('Must not call inference');
    }, 'high', () => botInstructions(path));
    await assert.rejects(provider.generate([], AbortSignal.timeout(1000)), /at most 8000/);
    assert.equal(requests, 0);
    assert.throws(() => readPersonality(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
