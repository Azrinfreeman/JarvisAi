import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadRainLoop } from '../src/sleep/audio/rain.js';
import { createSunnyStream } from '../src/sleep/audio/sunny.js';

const path = resolve('./assets/sunny-birds-loop.pcm');

test('sunny birdsong has a long continuous loop and controlled peaks', () => {
  const pcm = loadRainLoop(path);
  assert.ok(pcm.length >= 100 * 192000);
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  assert.ok(peak > 0 && peak < 9000);
  assert.ok(Math.abs(pcm.readInt16LE(0) - pcm.readInt16LE(pcm.length - 4)) < 500);
  assert.ok(Math.abs(pcm.readInt16LE(2) - pcm.readInt16LE(pcm.length - 2)) < 500);
});

test('quiet sunny stream stays continuous beyond the source length without loud peaks', async () => {
  const pcm = loadRainLoop(path);
  const stream = createSunnyStream(path);
  let bytes = 0;
  for await (const chunk of stream) {
    assert.equal(chunk.length % 3840, 0);
    for (let i = 0; i < chunk.length; i += 2) assert.ok(Math.abs(chunk.readInt16LE(i)) < 920);
    bytes += chunk.length;
    if (bytes > pcm.length + 3840) { stream.destroy(); break; }
  }
  assert.ok(bytes > pcm.length);
});

test('sunny calls are quieter, faded, and separated by randomly selected gaps', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'sunny-test-'));
  const fixture = resolve(directory, 'birds.pcm');
  const pcm = Buffer.alloc(3840 * 10);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  writeFileSync(fixture, pcm);
  async function render(random) {
    const stream = createSunnyStream(fixture, 0.5, { random, gapFrames: [2, 5], callFrames: [4, 4], fadeFrames: 1 });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes >= 3840 * 90) { stream.destroy(); break; }
    }
    return Buffer.concat(chunks);
  }
  try {
    const frequent = await render(() => 0);
    const sparse = await render(() => 0.999);
    const sample = (buffer, frame) => buffer.readInt16LE(frame * 3840);
    assert.equal(sample(frequent, 30), 60); // Background only.
    assert.equal(sample(frequent, 32), 60); // Call fades in from the background.
    assert.equal(sample(frequent, 33), 260); // Quieter than the original half-volume 500.
    assert.equal(sample(frequent, 35), 60); // Call fades out before the gap.
    assert.notDeepEqual(frequent, sparse);
    const calls = buffer => Array.from({length: 54}, (_, i) => sample(buffer, i + 30)).filter(v => v > 60).length;
    assert.ok(calls(frequent) > calls(sparse));
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
