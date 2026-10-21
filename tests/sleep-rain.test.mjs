import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VARIETY_SEQUENCE, createRainSceneStream, createRainStream, loadRainAtVolume, loadRainLoop } from '../src/sleep/audio/rain.js';

const path = resolve('./assets/rain-loop.pcm');

async function takeFrames(stream, count) {
  const frames = [];
  for await (const chunk of stream) {
    frames.push(Buffer.from(chunk));
    if (frames.length >= count) {
      stream.destroy();
      break;
    }
  }
  return frames;
}

test('rain starts at 20 percent of the recording level', () => {
  const original = loadRainLoop(path);
  const quiet = loadRainAtVolume(path);
  assert.equal(quiet.length, original.length);
  for (const offset of [0, 2, 3840, 3842, original.length - 2]) {
    assert.equal(quiet.readInt16LE(offset), Math.round(original.readInt16LE(offset) * 0.2));
  }
  assert.throws(() => loadRainAtVolume(path, 1.1), /Rain volume/);
});

test('bundled rain is framed stereo PCM with audible signal', () => {
  const pcm = loadRainLoop(path);
  assert.equal(pcm.length % 3840, 0);
  assert.ok(pcm.length > 45 * 48_000 * 4);
  assert.ok(Math.abs(pcm.readInt16LE(pcm.length - 4) - pcm.readInt16LE(0)) < 500);
  assert.ok(Math.abs(pcm.readInt16LE(pcm.length - 2) - pcm.readInt16LE(2)) < 500);
  let sumSquares = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  let cross = 0;
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 4) {
    const left = pcm.readInt16LE(i);
    const right = pcm.readInt16LE(i + 2);
    sumSquares += left * left + right * right;
    leftSquares += left * left;
    rightSquares += right * right;
    cross += left * right;
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
  }
  const rmsDb = 20 * Math.log10(Math.sqrt(sumSquares / (pcm.length / 2)) / 32768);
  assert.ok(rmsDb > -33 && rmsDb < -24, `rain average level ${rmsDb.toFixed(1)} dBFS`);
  assert.ok(peak < 9_000, 'isolated drops must remain below the sleep-friendly peak ceiling');
  assert.ok(cross / Math.sqrt(leftSquares * rightSquares) < 0.95, 'rain must retain stereo detail');
});

test('rain stream keeps producing frames across the loop boundary', async () => {
  const stream = createRainStream(path);
  const loopFrames = loadRainLoop(path).length / 3840;
  let frames = 0;
  for await (const chunk of stream) {
    assert.equal(chunk.length % 3840, 0);
    if (frames === 0) {
      assert.equal(chunk.readInt16LE(0), Math.round(loadRainLoop(path).readInt16LE(0) * 0.2));
    }
    frames += chunk.length / 3840;
    if (frames > loopFrames + 5) {
      stream.destroy();
      break;
    }
  }
  assert.ok(frames > loopFrames);
});

test('variety moves through distinct recordings and manual style changes stay in one stream', async () => {
  const paths = Object.fromEntries(['soft', 'forest', 'indoor', 'glass', 'heavy'].map((scene) => [
    scene, resolve(scene === 'forest' ? './assets/rain-loop.pcm' : `./assets/rain-${scene}-loop.pcm`),
  ]));
  const stream = createRainSceneStream(paths, 'variety', 0.5, { sceneFrames: 5, fadeFrames: 2 });
  const observed = new Set();
  let frames = 0;
  for await (const chunk of stream) {
    assert.equal(chunk.length, 3840);
    observed.add(stream.currentScene());
    frames += 1;
    if (frames === 16) stream.setStyle('heavy');
    if (frames === 25) {
      assert.equal(stream.currentScene(), 'heavy');
      stream.setStyle('soft');
    }
    if (frames === 30) {
      assert.equal(stream.currentScene(), 'soft');
      stream.destroy();
      break;
    }
  }
  assert.ok(observed.has('forest'));
  assert.ok(observed.has('indoor'));
  assert.ok(observed.has('heavy'));
});

test('variety grows heavier and then eases back', async () => {
  const paths = Object.fromEntries(['soft', 'forest', 'indoor', 'glass', 'heavy'].map((scene) => [
    scene, resolve(scene === 'forest' ? './assets/rain-loop.pcm' : `./assets/rain-${scene}-loop.pcm`),
  ]));
  const stream = createRainSceneStream(paths, 'variety', 0.5, { sceneFrames: 5, fadeFrames: 2 });
  const sequence = [];
  let frames = 0;
  for await (const chunk of stream) {
    assert.equal(chunk.length, 3840);
    const scene = stream.currentScene();
    if (scene !== sequence.at(-1)) sequence.push(scene);
    if (++frames >= 40) {
      stream.destroy();
      break;
    }
  }
  assert.deepEqual(sequence.slice(0, 8), ['soft', 'forest', 'indoor', 'glass', 'heavy', 'glass', 'indoor', 'forest']);
});

test('gentle rain lasts longer than the heavy rain passage', () => {
  const heavy = VARIETY_SEQUENCE.find(({ scene }) => scene === 'heavy').seconds;
  const gentle = VARIETY_SEQUENCE.filter(({ scene }) => scene !== 'heavy');
  assert.equal(heavy, 60);
  assert.ok(gentle.every(({ seconds }) => seconds > heavy));
  assert.ok(gentle.reduce((sum, { seconds }) => sum + seconds, 0) >= 10 * heavy);
});

test('variety includes distant thunder while fixed rain styles remain quiet', async () => {
  const paths = Object.fromEntries(['soft', 'forest', 'indoor', 'glass', 'heavy'].map((scene) => [
    scene, resolve(scene === 'forest' ? './assets/rain-loop.pcm' : `./assets/rain-${scene}-loop.pcm`),
  ]));
  const thunderPath = resolve('./assets/thunder-distant-a.pcm');
  const options = { sceneFrames: 5, fadeFrames: 2, thunderChance: 1, thunderDelayFrames: 1, random: () => 0 };
  const plain = await takeFrames(createRainSceneStream(paths, 'variety', 0.5, options), 30);
  const storm = await takeFrames(createRainSceneStream(paths, 'variety', 0.5, {
    ...options, thunderPaths: [thunderPath],
  }), 30);
  assert.ok(plain.slice(0, 18).every((frame, index) => frame.equals(storm[index])));
  assert.ok(plain.slice(22).some((frame, index) => !frame.equals(storm[index + 22])));
  const fixed = await takeFrames(createRainSceneStream(paths, 'heavy', 0.5, {
    ...options, thunderPaths: [thunderPath],
  }), 30);
  const fixedPlain = await takeFrames(createRainSceneStream(paths, 'heavy', 0.5, options), 30);
  assert.ok(fixed.every((frame, index) => frame.equals(fixedPlain[index])));
});

test('mild thunder stays on gentle scenes and never repeats the last rumble', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-bot-thunder-'));
  try {
    const thunderPaths = [1000, 2000].map((value, index) => {
      const clip = Buffer.alloc(3840 * 2);
      for (let i = 0; i < clip.length; i += 2) clip.writeInt16LE(value, i);
      const path = join(dir, `thunder-${index}.pcm`);
      writeFileSync(path, clip);
      return path;
    });
    const paths = Object.fromEntries(['soft', 'forest', 'indoor', 'glass', 'heavy'].map((scene) => [
      scene, resolve(scene === 'forest' ? './assets/rain-loop.pcm' : `./assets/rain-${scene}-loop.pcm`),
    ]));
    const options = { sceneFrames: 5, fadeFrames: 2, mildThunderIntervalFrames: [2, 2], random: () => 0 };
    const plain = await takeFrames(createRainSceneStream(paths, 'mild-thunder', 0.5, options), 64);
    const stream = createRainSceneStream(paths, 'mild-thunder', 0.5, { ...options, thunderPaths });
    const scenes = new Set();
    const storm = [];
    for await (const chunk of stream) {
      storm.push(Buffer.from(chunk));
      scenes.add(stream.currentScene());
      if (storm.length >= 64) { stream.destroy(); break; }
    }
    const deltas = storm.map((frame, index) => frame.readInt16LE(0) - plain[index].readInt16LE(0));
    assert.deepEqual(deltas.slice(0, 2), [0, 0], 'the first rumble follows a quiet interval');
    const events = deltas.filter((value, index) => value > 0 && (index === 0 || deltas[index - 1] === 0));
    assert.ok(events.length >= 3, 'more than one rumble plays over time');
    assert.ok(events.every((value, index) => index === 0 || value !== events[index - 1]));
    assert.ok(deltas.every((value) => value >= 0 && value < 1000), 'thunder remains subtle');
    assert.ok(!scenes.has('heavy'));
    assert.ok(scenes.has('soft') && scenes.has('indoor') && scenes.has('glass'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all bundled thunder recordings have quiet peaks and faded edges', () => {
  for (const letter of ['a', 'b', 'c', 'd']) {
    const pcm = loadRainLoop(resolve(`./assets/thunder-distant-${letter}.pcm`));
    assert.ok(pcm.length / 192000 <= 34, 'the rumble fits the brief heavy passage');
    assert.ok(pcm.subarray(0, 3840).every((sample) => sample === 0));
    assert.ok(pcm.subarray(-3840).every((sample) => sample === 0));
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    assert.ok(peak > 0 && peak <= 5200, `quiet thunder peak for ${letter}`);
  }
});

test('switching to mild thunder during a scene fade settles on gentle rain', async () => {
  const paths = Object.fromEntries(['soft', 'forest', 'indoor', 'glass', 'heavy'].map((scene) => [
    scene, resolve(scene === 'forest' ? './assets/rain-loop.pcm' : `./assets/rain-${scene}-loop.pcm`),
  ]));
  const stream = createRainSceneStream(paths, 'heavy', 0.5, { sceneFrames: 500, fadeFrames: 2 });
  let frames = 0;
  for await (const chunk of stream) {
    assert.equal(chunk.length, 3840);
    frames += 1;
    if (frames === 2) stream.setStyle('mild-thunder');
    if (frames === 3) stream.setStyle('variety');
    if (frames === 4) stream.setStyle('mild-thunder');
    if (frames === 8) assert.equal(stream.currentScene(), 'soft');
    if (frames === 9) stream.setStyle('glass');
    if (frames === 10) stream.setStyle('mild-thunder');
    if (frames === 14) {
      assert.equal(stream.currentScene(), 'glass');
      assert.equal(stream.style, 'mild-thunder');
      stream.destroy();
      break;
    }
  }
});
