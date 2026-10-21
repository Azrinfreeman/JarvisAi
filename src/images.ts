import { UserError } from './errors.js';
import sharp from 'sharp';
import { decodeBitmap } from './bitmap.js';

// Base64 adds about one third; keep the data URL below the provider's 20 MiB field limit.
export const maxImageBytes = 14 * 1024 * 1024;
export type ImageAttachment = { url: string; size: number; contentType: string | null };
const formatError = () => new UserError('I could not decode this screenshot. Paste or upload a PNG, JPEG, WEBP, BMP, GIF, AVIF, or TIFF image. HEIC, SVG, documents, and damaged images are not supported.');
const sizeError = (bytes: number) => new UserError(`That image is ${(bytes / 1024 / 1024).toFixed(1)} MB. The maximum is 14 MB. Resize or compress it and try again.`);
const sourceError = () => new UserError('The image must be uploaded to Discord. Attach it using /ask image or paste it into a message mentioning me.');
function normalizedType(value: string | null): string | null {
  const mime = value?.split(';')[0]?.trim().toLowerCase();
  if (!mime || mime === 'application/octet-stream') return null;
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

export function validateImage(image: ImageAttachment): ImageAttachment {
  let url: URL;
  try { url = new URL(image.url); } catch { throw sourceError(); }
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
    || url.username || url.password || url.port || !/^\/(?:ephemeral-)?attachments\//.test(url.pathname)) throw sourceError();
  if (!Number.isSafeInteger(image.size) || image.size <= 0) throw new UserError('Discord returned an invalid image size. Upload the image again.');
  if (image.size > maxImageBytes) throw sizeError(image.size);
  const contentType = normalizedType(image.contentType);
  // Clipboard uploads can have missing, generic, aliased, or incorrect MIME labels.
  // The decoder validates the actual downloaded bytes instead.
  return { url: url.href, size: image.size, contentType };
}

function detectedType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (['49492a00', '4d4d002a'].includes(bytes.subarray(0, 4).toString('hex'))) return 'image/tiff';
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const end = Math.min(bytes.readUInt32BE(0), bytes.length, 128);
    for (let index = 8; index + 4 <= end; index += 4) {
      if (index !== 12 && ['avif', 'avis'].includes(bytes.toString('ascii', index, index + 4))) return 'image/avif';
    }
  }
  return undefined;
}

export async function normalizeImage(bytes: Buffer, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (bytes.length > maxImageBytes) throw sizeError(bytes.length);
  const type = detectedType(bytes);
  if (!type) throw formatError();
  try {
    const bitmap = type === 'image/bmp' ? decodeBitmap(bytes) : undefined;
    const input = sharp(bitmap?.bytes ?? bytes, { ...(bitmap ? { raw: bitmap.raw } : {}),
      limitInputPixels: 40_000_000, animated: false, failOn: 'warning' });
    const metadata = await input.metadata();
    signal.throwIfAborted();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) {
      throw new UserError('This screenshot has too many pixels. Crop or resize it below 40 megapixels and try again.');
    }
    const pipeline = input.rotate().toColourspace('srgb');
    let output = await pipeline.clone().png().timeout({ seconds: 10 }).toBuffer();
    signal.throwIfAborted();
    let mime = 'image/png';
    if (output.length > maxImageBytes) {
      output = await pipeline.clone().flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).timeout({ seconds: 10 }).toBuffer();
      signal.throwIfAborted();
      mime = 'image/jpeg';
    }
    if (output.length > maxImageBytes) throw sizeError(output.length);
    return `data:${mime};base64,${output.toString('base64')}`;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof UserError) throw error;
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      throw new UserError('This screenshot has too many pixels. Crop or resize it below 40 megapixels and try again.');
    }
    throw formatError();
  }
}

export async function downloadImage(image: ImageAttachment, signal: AbortSignal, request: typeof fetch = fetch): Promise<string> {
  image = validateImage(image);
  const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const response = await request(image.url, { signal: combined, redirect: 'error' });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new UserError('The image could not be downloaded from Discord. Attach it again and retry.');
  }
  const reader = response.body.getReader();
  try {
    const declaredSize = response.headers.get('content-length');
    if (declaredSize && !/^\d+$/.test(declaredSize)) throw new UserError('Discord returned an invalid download size. Upload the image again.');
    if (declaredSize && Number(declaredSize) > maxImageBytes) throw sizeError(Number(declaredSize));
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      combined.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxImageBytes) throw sizeError(size);
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    return normalizeImage(bytes, combined);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
