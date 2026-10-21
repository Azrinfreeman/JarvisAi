import { readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';

const FRAME_BYTES = 960 * 2 * 2; // 20 ms, 48 kHz, stereo, signed 16-bit PCM.
export const VARIETY_SEQUENCE = [
  { scene: 'soft', seconds: 240 },
  { scene: 'forest', seconds: 180 },
  { scene: 'indoor', seconds: 180 },
  { scene: 'glass', seconds: 150 },
  { scene: 'heavy', seconds: 60 },
  { scene: 'glass', seconds: 150 },
  { scene: 'indoor', seconds: 180 },
  { scene: 'forest', seconds: 180 },
];
export const MILD_THUNDER_SEQUENCE = [
  { scene: 'soft', seconds: 240 },
  { scene: 'forest', seconds: 180 },
  { scene: 'indoor', seconds: 180 },
  { scene: 'glass', seconds: 150 },
  { scene: 'indoor', seconds: 180 },
  { scene: 'forest', seconds: 180 },
];
const RAIN_SCENES = ['soft', 'forest', 'indoor', 'glass', 'heavy'];
const FADE_FRAMES = 10 * 50; // Ten-second scene transitions.
const cache = new Map();

export const RAIN_STYLES = ['variety', 'mild-thunder', ...RAIN_SCENES];

function isChangingStyle(style) {
  return style === 'variety' || style === 'mild-thunder';
}

function sequenceForStyle(style) {
  return style === 'mild-thunder' ? MILD_THUNDER_SEQUENCE : VARIETY_SEQUENCE;
}

export function loadRainLoop(path) {
  const mtimeMs = statSync(path).mtimeMs;
  let entry = cache.get(path);
  if (!entry || entry.mtimeMs !== mtimeMs) {
    const pcm = readFileSync(path);
    if (pcm.length < FRAME_BYTES * 2 || pcm.length % FRAME_BYTES !== 0) {
      throw new Error('Rain asset must contain whole 20 ms stereo PCM frames');
    }
    entry = { mtimeMs, pcm, volumes: new Map() };
    cache.set(path, entry);
  }
  return entry.pcm;
}

export function loadRainAtVolume(path, volume = 0.2) {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new Error('Rain volume must be a number from 0 to 1');
  }
  const pcm = loadRainLoop(path);
  if (volume === 1) return pcm;
  const entry = cache.get(path);
  let scaled = entry.volumes.get(volume);
  if (!scaled) {
    scaled = Buffer.allocUnsafe(pcm.length);
    for (let i = 0; i < pcm.length; i += 2) {
      scaled.writeInt16LE(Math.round(pcm.readInt16LE(i) * volume), i);
    }
    entry.volumes.set(volume, scaled);
  }
  return scaled;
}

export function createRainStream(path, volume = 0.2) {
  const pcm = loadRainAtVolume(path, volume);
  let offset = 0;
  return new Readable({
    read() {
      if (offset >= pcm.length) offset = 0;
      this.push(pcm.subarray(offset, offset + FRAME_BYTES));
      offset += FRAME_BYTES;
    },
  });
}

// Keep one voice audio resource active while moving between recordings.
// Each scene is pre-normalized and the transition blends 20 ms frames.
export function createRainSceneStream(paths, style = 'variety', volume = 0.2, options = {}) {
  if (!RAIN_STYLES.includes(style)) throw new Error('Unknown rain style');
  const pcm = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, loadRainAtVolume(path, volume)]));
  for (const scene of RAIN_SCENES) {
    if (!pcm[scene]) throw new Error(`Missing rain asset: ${scene}`);
  }
  const sceneFrames = options.sceneFrames;
  const fadeFrames = options.fadeFrames ?? FADE_FRAMES;
  const sceneDurations = options.sceneDurationsFrames;
  if ((sceneFrames !== undefined && (!Number.isInteger(sceneFrames) || sceneFrames <= fadeFrames)) ||
      !Number.isInteger(fadeFrames) || fadeFrames < 1 ||
      (sceneDurations !== undefined &&
       (![VARIETY_SEQUENCE.length, MILD_THUNDER_SEQUENCE.length].includes(sceneDurations.length) ||
        sceneDurations.some((frames) => !Number.isInteger(frames) || frames <= fadeFrames)))) {
    throw new Error('Invalid rain timing');
  }
  const thunderPcm = (options.thunderPaths ?? []).map((path) => loadRainAtVolume(path, volume * 0.35));
  const random = options.random ?? Math.random;
  const thunderChance = options.thunderChance ?? 1;
  const thunderDelayFrames = options.thunderDelayFrames;
  const mildThunderInterval = options.mildThunderIntervalFrames ?? [3 * 60 * 50, 6 * 60 * 50];
  if (!Number.isFinite(thunderChance) || thunderChance < 0 || thunderChance > 1 ||
      (thunderDelayFrames !== undefined && (!Number.isInteger(thunderDelayFrames) || thunderDelayFrames < 0)) ||
      !Array.isArray(mildThunderInterval) || mildThunderInterval.length !== 2 ||
      mildThunderInterval.some((frames) => !Number.isInteger(frames) || frames < 1) ||
      mildThunderInterval[1] < mildThunderInterval[0]) {
    throw new Error('Invalid thunder timing');
  }
  const offsets = Object.fromEntries(Object.keys(pcm).map((name) => [name, 0]));
  let sequence = sequenceForStyle(style);
  let current = isChangingStyle(style) ? sequence[0].scene : style;
  let target = null;
  let fadeProgress = 0;
  let varietyIndex = 0;
  let varietyFrames = 0;
  let pendingTarget = null;
  let outputFrames = 0;
  let thunderClip = null;
  let thunderStartFrame = 0;
  let thunderOffset = 0;
  let thunderStopFrame = null;
  let lastThunderIndex = -1;
  let thunderGain = 1;

  function mildThunderGap() {
    return mildThunderInterval[0] + Math.floor(random() * (mildThunderInterval[1] - mildThunderInterval[0] + 1));
  }
  let nextMildThunderFrame = style === 'mild-thunder' ? mildThunderGap() : Infinity;

  function queueThunder(delayFrames, gain = 1) {
    const choices = thunderPcm.length - (lastThunderIndex >= 0 && thunderPcm.length > 1 ? 1 : 0);
    let index = Math.floor(random() * choices);
    if (thunderPcm.length > 1 && lastThunderIndex >= 0 && index >= lastThunderIndex) index += 1;
    lastThunderIndex = index;
    thunderClip = thunderPcm[index];
    thunderStartFrame = outputFrames + delayFrames;
    thunderOffset = 0;
    thunderStopFrame = null;
    thunderGain = gain;
  }

  function nextFrame(scene) {
    const source = pcm[scene];
    let offset = offsets[scene];
    if (offset >= source.length) offset = 0;
    offsets[scene] = offset + FRAME_BYTES;
    return source.subarray(offset, offset + FRAME_BYTES);
  }

  const stream = new Readable({
    highWaterMark: FRAME_BYTES,
    read() {
      if (isChangingStyle(stream.style)) {
        varietyFrames += 1;
        const duration = sceneFrames ?? (sceneDurations?.length === sequence.length
          ? sceneDurations[varietyIndex] : sequence[varietyIndex].seconds * 50);
        if (varietyFrames >= duration && !target) {
          varietyFrames = 0;
          varietyIndex = (varietyIndex + 1) % sequence.length;
          target = sequence[varietyIndex].scene;
          fadeProgress = 0;
          if (target === 'heavy' && thunderPcm.length && !thunderClip && random() < thunderChance) {
            queueThunder(fadeFrames + (thunderDelayFrames ?? (4 + Math.floor(random() * 8)) * 50));
          }
        }
      }
      if (stream.style === 'mild-thunder' && thunderPcm.length && !thunderClip && outputFrames >= nextMildThunderFrame) {
        queueThunder(0, 0.75);
      }
      const from = nextFrame(current);
      let frame = from;
      if (target) {
        const to = nextFrame(target);
        const weight = (fadeProgress + 1) / fadeFrames;
        frame = Buffer.allocUnsafe(FRAME_BYTES);
        for (let i = 0; i < FRAME_BYTES; i += 2) {
          const sample = Math.round(from.readInt16LE(i) * (1 - weight) + to.readInt16LE(i) * weight);
          frame.writeInt16LE(sample, i);
        }
        fadeProgress += 1;
        if (fadeProgress >= fadeFrames) {
          current = target;
          target = null;
          if (pendingTarget && pendingTarget !== current) {
            target = pendingTarget;
            fadeProgress = 0;
          }
          pendingTarget = null;
        }
      }
      if (thunderClip && outputFrames >= thunderStartFrame) {
        const thunder = thunderClip.subarray(thunderOffset, thunderOffset + FRAME_BYTES);
        const fadeOut = thunderStopFrame === null ? 1 :
          Math.max(0, (thunderStopFrame - outputFrames) / (2 * 50));
        const mixed = Buffer.allocUnsafe(FRAME_BYTES);
        for (let i = 0; i < FRAME_BYTES; i += 2) {
          const sample = frame.readInt16LE(i) + Math.round(thunder.readInt16LE(i) * fadeOut * thunderGain);
          mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
        }
        frame = mixed;
        thunderOffset += FRAME_BYTES;
        if (thunderOffset >= thunderClip.length || fadeOut === 0) {
          thunderClip = null;
          if (stream.style === 'mild-thunder') nextMildThunderFrame = outputFrames + 1 + mildThunderGap();
        }
      }
      this.push(frame);
      outputFrames += 1;
    },
  });
  stream.style = style;
  stream.currentScene = () => target ?? current;
  stream.setStyle = (newStyle) => {
    if (!RAIN_STYLES.includes(newStyle)) throw new Error('Unknown rain style');
    stream.style = newStyle;
    varietyFrames = 0;
    if (!isChangingStyle(newStyle) && thunderClip) {
      if (outputFrames < thunderStartFrame) thunderClip = null;
      else thunderStopFrame = outputFrames + 2 * 50;
    }
    nextMildThunderFrame = newStyle === 'mild-thunder' ? outputFrames + mildThunderGap() : Infinity;
    let desiredScene = newStyle;
    if (isChangingStyle(newStyle)) {
      sequence = sequenceForStyle(newStyle);
      varietyIndex = sequence.findIndex(({ scene }) => scene === (target ?? current));
      if (varietyIndex < 0) varietyIndex = 0;
      desiredScene = sequence[varietyIndex].scene;
    }
    if (target) {
      pendingTarget = desiredScene === target ? null : desiredScene;
    } else if (desiredScene !== current) {
      target = desiredScene;
      fadeProgress = 0;
    }
  };
  return stream;
}
