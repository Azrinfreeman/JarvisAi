import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadImage, maxImageBytes, normalizeImage, validateImage } from '../src/images.js';
import { ChatService, conversationKey, type ChatIdentity } from '../src/chat.js';
import { Conversations } from '../src/storage.js';
import { RequestQueue } from '../src/queue.js';
import { ChatGPTProvider, type ProviderMessage } from '../src/provider.js';
import { commands } from '../src/commands.js';
import { UserError } from '../src/errors.js';
import sharp from 'sharp';
import { decodeBitmap } from '../src/bitmap.js';

const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
const image = { url: 'https://cdn.discordapp.com/attachments/123/456/image.png?ex=signed', size: png.length, contentType: 'image/png' };
const signal = () => AbortSignal.timeout(1000);

test('image validation accepts Discord attachments and rejects other hosts, protocols, types and sizes', () => {
  assert.deepEqual(validateImage(image), image);
  assert.ok(validateImage({ ...image, url: image.url.replace('cdn.discordapp.com', 'media.discordapp.net') }));
  assert.ok(validateImage({ ...image, url: image.url.replace('/attachments/', '/ephemeral-attachments/') }));
  for (const change of [
    { url: 'http://cdn.discordapp.com/attachments/123/456/x.png' },
    { url: 'https://cdn.discordapp.com.attacker.test/attachments/123/456/x.png' },
    { url: 'https://127.0.0.1/attachments/123/456/x.png' },
    { url: 'https://user:password@cdn.discordapp.com/attachments/123/456/x.png' },
    { url: 'https://cdn.discordapp.com:8443/attachments/123/456/x.png' },
    { url: 'https://cdn.discordapp.com/avatars/x.png' },
    { size: maxImageBytes + 1 }, { size: 0 }, { size: NaN },
  ]) assert.throws(() => validateImage({ ...image, ...change }), UserError);
});

test('download uses bounded Discord fetch without credentials and converts valid bytes to image input', async () => {
  const data = await downloadImage(image, signal(), async (url, init) => {
    assert.equal(url, image.url);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.headers, undefined);
    assert.ok(init?.signal);
    return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
  });
  assert.equal(data, `data:image/png;base64,${png.toString('base64')}`);
});

test('image download rejects disguised files and HTTP failures based on bytes rather than labels', async () => {
  for (const response of [
    new Response('<html>not an image</html>', { headers: { 'content-type': 'image/png' } }),
    new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/png' } }),
    new Response(png.subarray(0, 20), { headers: { 'content-type': 'image/png' } }),
    new Response(null, { status: 302, headers: { location: 'http://127.0.0.1' } }),
    new Response(null, { status: 404 }),
  ]) await assert.rejects(downloadImage(image, signal(), async () => response));
});

test('image download enforces actual streamed bytes, rejects oversized headers and cancels the body', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(maxImageBytes + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(downloadImage(image, signal(), async () => new Response(body, { headers: { 'content-type': 'image/png' } })), /maximum is 14 MB/);
  assert.equal(cancelled, true);
  await assert.rejects(downloadImage(image, signal(), async () => new Response(png, {
    headers: { 'content-type': 'image/png', 'content-length': String(maxImageBytes + 1) },
  })), /maximum is 14 MB/);
});

test('larger images pass the former 8 MB cap while the new limit stays within the inline data URL limit', async () => {
  assert.ok(validateImage({ ...image, size: maxImageBytes }));
  assert.ok(4 * Math.ceil(maxImageBytes / 3) + 'data:image/jpeg;base64,'.length < 20 * 1024 * 1024);
  const larger = Buffer.alloc(9 * 1024 * 1024); png.copy(larger);
  const data = await downloadImage({ ...image, size: larger.length }, signal(), async () => new Response(larger, {
    headers: { 'content-type': 'image/png', 'content-length': String(larger.length) },
  }));
  assert.equal((await sharp(Buffer.from(data.split(',')[1]!, 'base64')).metadata()).width, 2);
  assert.throws(() => validateImage({ ...image, size: 16 * 1024 * 1024 }), /16.0 MB.*maximum is 14 MB/);
  assert.throws(() => validateImage({ ...image, url: 'https://example.com/image.png' }), /uploaded to Discord/);
});

test('generic download MIME is accepted only when the actual bytes are a supported image', async () => {
  const generic = { ...image, contentType: 'application/octet-stream' };
  assert.equal(await downloadImage(generic, signal(), async () => new Response(png, {
    headers: { 'content-type': 'application/octet-stream' },
  })), `data:image/png;base64,${png.toString('base64')}`);
  await assert.rejects(downloadImage(generic, signal(), async () => new Response('not an image', {
    headers: { 'content-type': 'application/octet-stream' },
  })), /could not decode this screenshot/);
});

test('Windows screenshot PNG bytes work with unknown, aliased, missing and incorrect upload MIME labels', async () => {
  for (const contentType of ['image/unknown', 'image/x-png', 'image/jpeg', 'application/unknown', null]) {
    const data = await downloadImage({ ...image, contentType }, signal(), async () => new Response(png, {
      headers: { 'content-type': 'application/octet-stream' },
    }));
    const decoded = await sharp(Buffer.from(data.split(',')[1]!, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 2);
    assert.deepEqual([...decoded.data.subarray(0, 3)], [255, 0, 0]);
  }
});

function bitmap(bits: 24 | 32 = 24, topDown = false): Buffer {
  const stride = bits === 24 ? 8 : 8;
  const bytes = Buffer.alloc(54 + stride * 2);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(2, 18); bytes.writeInt32LE(topDown ? -2 : 2, 22);
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(bits, 28);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const row = 54 + (topDown ? y : 1 - y) * stride;
    bytes[row + x * (bits / 8) + (y === 0 ? 2 : 0)] = 255;
  }
  return bytes;
}

test('Windows 24/32-bit bitmap screenshots normalize with correct colors and top/bottom orientation', async () => {
  for (const bits of [24, 32] as const) for (const topDown of [false, true]) {
    const data = await normalizeImage(bitmap(bits, topDown), signal());
    const decoded = await sharp(Buffer.from(data.split(',')[1]!, 'base64')).removeAlpha().raw().toBuffer();
    assert.deepEqual([...decoded.subarray(0, 3)], [255, 0, 0]);
    assert.deepEqual([...decoded.subarray(6, 9)], [0, 0, 255]);
  }
  const bad = bitmap(); bad.writeInt32LE(2_000_000_000, 18);
  assert.throws(() => decodeBitmap(bad), /unsupported encoding/);
  assert.throws(() => decodeBitmap(bitmap().subarray(0, 60)), /damaged/);
});

test('GIF, TIFF and AVIF input normalize into a supported still PNG', async () => {
  for (const format of ['gif', 'tiff', 'avif'] as const) {
    const source = await sharp(png).toFormat(format).toBuffer();
    const data = await normalizeImage(source, AbortSignal.timeout(10000));
    assert.ok(data.startsWith('data:image/png;base64,'));
    const metadata = await sharp(Buffer.from(data.split(',')[1]!, 'base64')).metadata();
    assert.equal(metadata.width, 2); assert.equal(metadata.height, 2);
  }
});

test('cancelled image requests stop before generation', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadImage(image, controller.signal, async () => new Response(png)), { name: 'AbortError' });
});

test('private image reaches the provider once, while stored and public context omit image bytes and URLs', async () => {
  const store = new Conversations(':memory:');
  const inputs: ProviderMessage[][] = [];
  let downloads = 0;
  const chat = new ChatService({ generate: async messages => { inputs.push(messages); return 'A picture.'; } }, store, new RequestQueue(4, 0),
    async () => { downloads++; return 'data:image/png;base64,synthetic-image'; });
  const identity: ChatIdentity = { guildId: 'g', channelId: 'c', userId: 'u', visibility: 'private' };
  try {
    await chat.ask(identity, 'What is this?', async () => {}, { image });
    assert.deepEqual(inputs[0]?.at(-1)?.content, [
      { type: 'input_text', text: 'What is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,synthetic-image', detail: 'auto' },
    ]);
    const saved = JSON.stringify(store.get(conversationKey(identity)));
    assert.match(saved, /Reattach for visual follow-ups/);
    assert.ok(!saved.includes('base64') && !saved.includes('discordapp.com'));
    await chat.ask(identity, 'Follow-up', async () => {});
    assert.ok(inputs[1]?.every(message => typeof message.content === 'string'));
    await chat.ask({ ...identity, visibility: 'public' }, 'Public question', async () => {});
    assert.deepEqual(inputs[2], [{ role: 'user', content: 'Public question' }]);
    await chat.ask({ ...identity, userId: 'other' }, 'Other member', async () => {});
    assert.deepEqual(inputs[3], [{ role: 'user', content: 'Other member' }]);
    assert.equal(downloads, 1);
  } finally { chat.close(); store.close(); }
});

test('failed image downloads never call the provider or save history', async () => {
  const store = new Conversations(':memory:');
  let generated = false;
  const chat = new ChatService({ generate: async () => { generated = true; return 'answer'; } }, store, new RequestQueue(4, 0),
    async () => { throw new Error('download failed'); });
  const identity = { guildId: 'g', channelId: 'c', userId: 'u' };
  try {
    await assert.rejects(chat.ask(identity, 'Describe it', async () => {}, { image }), /download failed/);
    assert.equal(generated, false);
    assert.deepEqual(store.get(conversationKey(identity)), []);
  } finally { chat.close(); store.close(); }
});

test('subscription request sends inline image content without uploads or a paid fallback', async () => {
  const input: ProviderMessage[] = [{ role: 'user', content: [
    { type: 'input_text', text: 'Describe it' },
    { type: 'input_image', image_url: 'data:image/png;base64,synthetic', detail: 'auto' },
  ] }];
  const provider = new ChatGPTProvider('gpt-6-luna', async () => 'synthetic-oauth', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload.input, input);
    assert.equal(payload.store, false);
    assert.equal(payload.stream, true);
    return new Response('data: {"type":"response.output_text.delta","delta":"An image."}\n\ndata: {"type":"response.completed"}\n\n');
  }, 'low');
  assert.equal(await provider.generate(input, signal()), 'An image.');
  const ask = commands.find(command => command.name === 'ask');
  assert.equal(ask?.options?.find(option => option.name === 'image')?.type, 11);
  assert.ok(!ask?.options?.find(option => option.name === 'prompt')?.required);
  assert.ok(ask?.options?.some(option => option.name === 'private'));
});
