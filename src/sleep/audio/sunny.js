import { Readable } from 'node:stream';
import { loadRainLoop } from './rain.js';

const FRAME_BYTES = 3840;
const beds = new WeakMap();

function outdoorBed(pcm) {
  if (beds.has(pcm)) return beds.get(pcm);
  const bed = Buffer.allocUnsafe(pcm.length);
  const alpha = 1 - Math.exp(-2 * Math.PI * 350 / 48000);
  const first = [0, 0];
  const second = [0, 0];
  // Warm the filter through one loop so the background joins smoothly.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < pcm.length; i += 2) {
      const channel = (i / 2) % 2;
      first[channel] += alpha * (pcm.readInt16LE(i) - first[channel]);
      second[channel] += alpha * (first[channel] - second[channel]);
      if (pass === 1) bed.writeInt16LE(Math.round(second[channel] * 0.12), i);
    }
  }
  beds.set(pcm, bed);
  return bed;
}

// Sparse excerpts of the field recording over a very quiet filtered outdoor bed.
export function createSunnyStream(path, volume = 0.2, options = {}) {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('Invalid sunny volume');
  const pcm = loadRainLoop(path);
  const bed = outdoorBed(pcm);
  const sourceFrames = pcm.length / FRAME_BYTES;
  const random = options.random ?? Math.random;
  const gapRange = options.gapFrames ?? [25 * 50, 55 * 50];
  const callRange = options.callFrames ?? [5 * 50, 9 * 50];
  const fadeFrames = options.fadeFrames ?? 75;
  for (const range of [gapRange, callRange]) {
    if (!Array.isArray(range) || range.length !== 2 || range.some(v => !Number.isInteger(v) || v < 1) || range[1] < range[0]) {
      throw new Error('Invalid sunny timing');
    }
  }
  if (!Number.isInteger(fadeFrames) || fadeFrames < 1) throw new Error('Invalid sunny fade');
  const pick = range => range[0] + Math.floor(random() * (range[1] - range[0] + 1));
  let gap = pick(gapRange);
  let remaining = 0;
  let duration = 0;
  let callOffset = 0;
  let bedOffset = 0;
  let frames = 0;
  return new Readable({
    highWaterMark: FRAME_BYTES,
    read() {
      if (!remaining && gap === 0) {
        duration = Math.min(pick(callRange), sourceFrames);
        remaining = duration;
        callOffset = Math.floor(random() * (sourceFrames - duration + 1)) * FRAME_BYTES;
      }
      const frame = Buffer.allocUnsafe(FRAME_BYTES);
      const progress = duration - remaining;
      const envelope = remaining ? Math.min(1, progress / fadeFrames, (remaining - 1) / fadeFrames) : 0;
      const gain = 0.4 * (0.5 - 0.5 * Math.cos(Math.PI * envelope));
      const startup = Math.min(1, frames / 25);
      for (let i = 0; i < FRAME_BYTES; i += 2) {
        const sample = bed.readInt16LE(bedOffset + i) + (remaining ? pcm.readInt16LE(callOffset + i) * gain : 0);
        frame.writeInt16LE(Math.round(sample * volume * startup), i);
      }
      bedOffset = (bedOffset + FRAME_BYTES) % bed.length;
      frames += 1;
      if (remaining) {
        callOffset += FRAME_BYTES;
        remaining -= 1;
        if (!remaining) gap = pick(gapRange);
      } else gap -= 1;
      this.push(frame);
    },
  });
}
