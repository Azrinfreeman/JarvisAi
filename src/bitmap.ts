import { UserError } from './errors.js';

// Windows bitmap screenshots: uncompressed 24/32-bit BMP with standard RGB masks.
export function decodeBitmap(bytes: Buffer) {
  const invalid = () => new UserError('This bitmap is damaged or uses an unsupported encoding. Paste it as PNG or JPEG instead.');
  if (bytes.length < 54 || bytes.toString('ascii', 0, 2) !== 'BM') throw invalid();
  const offset = bytes.readUInt32LE(10);
  const header = bytes.readUInt32LE(14);
  if (![40, 52, 56, 108, 124].includes(header) || bytes.length < 14 + header || offset < 14 + header) throw invalid();
  const width = bytes.readInt32LE(18);
  const signedHeight = bytes.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const bits = bytes.readUInt16LE(28);
  const compression = bytes.readUInt32LE(30);
  if (width <= 0 || height <= 0 || width * height > 40_000_000 || bytes.readUInt16LE(26) !== 1
    || ![24, 32].includes(bits) || ![0, 3].includes(compression)) throw invalid();
  if (compression === 3) {
    if (bits !== 32 || bytes.length < 66 || offset < 66 || bytes.readUInt32LE(54) !== 0xff0000
      || bytes.readUInt32LE(58) !== 0xff00 || bytes.readUInt32LE(62) !== 0xff) throw invalid();
  }
  const stride = Math.ceil(width * bits / 32) * 4;
  if (offset + stride * height > bytes.length) throw invalid();
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = offset + (signedHeight < 0 ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const source = row + x * (bits / 8);
      const target = (y * width + x) * 3;
      rgb[target] = bytes[source + 2]!;
      rgb[target + 1] = bytes[source + 1]!;
      rgb[target + 2] = bytes[source]!;
    }
  }
  return { bytes: rgb, raw: { width, height, channels: 3 as const } };
}
