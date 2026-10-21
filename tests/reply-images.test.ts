import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { referencedInput, type ReplyTarget } from '../src/replies.js';
import { ChatService, conversationKey } from '../src/chat.js';
import { Conversations } from '../src/storage.js';
import { RequestQueue } from '../src/queue.js';
import { maxImageBytes, downloadImage } from '../src/images.js';
import type { ProviderMessage } from '../src/provider.js';

const scope = { guildId: 'guild', channelId: 'channel', botId: 'jarvis', botName: 'Jarvis', userId: 'member', userName: 'Melon' };
const reference = { guildId: scope.guildId, channelId: scope.channelId, messageId: 'original' };
const image = { url: 'https://cdn.discordapp.com/attachments/channel/message/screenshot.png?ex=signature', size: 100, contentType: 'application/unknown', filename: 'screenshot.png' };
const target: ReplyTarget = { id: 'original', channelId: scope.channelId, content: '', author: { id: 'another-member', name: 'Friend' }, attachments: [image] };
const signal = () => AbortSignal.timeout(1000);

test('image-only and whitespace-only selected messages provide an image without leaking its URL into quoted history', async () => {
  for (const content of ['', '   ']) {
    const input = await referencedInput(reference, scope, async () => ({ ...target, content }), signal());
    assert.equal(input.image?.url, image.url);
    const quote = JSON.parse(input.text);
    assert.equal(quote.selected_message.image_supplied, true);
    assert.match(quote.selected_message.text, /visual analysis/);
    assert.equal(quote.selected_message.speaker, 'another member');
    assert.ok(!input.text.includes('cdn.discordapp.com') && !input.text.includes('signature'));
  }
});

test('selected caption and reply-chain context are preserved, but ancestor attachments are not analyzed', async () => {
  const input = await referencedInput(reference, scope, async (_channel, id) => id === 'original'
    ? { ...target, content: 'Explain this diagram.', reference: { messageId: 'parent' } }
    : { ...target, id: 'parent', attachments: [{ ...image, url: 'https://example.com/never-download.png' }] }, signal());
  const quote = JSON.parse(input.text);
  assert.equal(quote.selected_message.text, 'Explain this diagram.');
  assert.equal(input.image?.url, image.url);
  assert.match(quote.earlier_replies_newest_first[0].text, /not supplied/);
  assert.ok(!input.text.includes('example.com'));
});

test('referenced attachments retain image count, size, source, nonimage and scope validation', async () => {
  for (const [attachments, error] of [
    [[image, image], /multiple images/],
    [[{ ...image, size: maxImageBytes + 1 }], /maximum is 14 MB/],
    [[{ ...image, url: 'https://example.com/screenshot.png' }], /uploaded to Discord/],
    [[{ ...image, contentType: 'application/pdf', filename: 'document.pdf' }], /no readable text or supported image/],
  ] as const) {
    await assert.rejects(referencedInput(reference, scope, async () => ({ ...target, attachments: [...attachments] }), signal()), error);
  }
  let reads = 0;
  await assert.rejects(referencedInput({ ...reference, channelId: 'private-channel' }, scope, async () => { reads++; return target; }, signal()), /same channel/);
  assert.equal(reads, 0);
  await assert.rejects(referencedInput(reference, scope, async () => ({ ...target, attachments: [] }), signal()), /Message Content Intent/);
});

test('reply-image bytes use the existing converter, reach the model once, and do not get reposted or saved', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const original = { ...target, attachments: [{ ...image, size: png.length }] };
  const store = new Conversations(':memory:');
  const inputs: ProviderMessage[][] = [];
  const identity = { guildId: scope.guildId, channelId: scope.channelId, userId: scope.userId, visibility: 'public' as const };
  let downloads = 0; let deliveries = 0;
  const chat = new ChatService({ generate: async messages => { inputs.push(messages); return 'Red.'; } }, store, new RequestQueue(4, 0),
    (attachment, abort) => downloadImage(attachment, abort, async url => { downloads++; assert.equal(String(url), image.url); return new Response(png); }));
  try {
    await chat.ask(identity, 'boleh explain tak bah', async (answer, preview) => {
      deliveries++; assert.equal(answer, 'Red.'); assert.equal(preview, undefined);
    }, { reference: abort => referencedInput(reference, scope, async () => original, abort) });
    assert.equal(downloads, 1); assert.equal(deliveries, 1);
    const content = inputs[0]!.at(-1)!.content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0]!.type, 'input_text');
    assert.deepEqual(content[1], { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}`, detail: 'auto' });
    const saved = JSON.stringify(store.get(conversationKey(identity)));
    assert.match(saved, /Image attached/);
    assert.ok(!saved.includes('base64') && !saved.includes('cdn.discordapp.com') && !saved.includes('signature'));
    assert.deepEqual(store.get(conversationKey({ ...identity, visibility: 'private' })), []);
    assert.deepEqual(store.get(conversationKey({ ...identity, userId: 'another-member' })), []);
  } finally { chat.close(); store.close(); }
});

test('an explicitly attached image takes priority over referenced multiple images', async () => {
  const store = new Conversations(':memory:');
  let downloads = 0;
  const own = { ...image, url: 'https://cdn.discordapp.com/attachments/channel/new/own.png' };
  const chat = new ChatService({ generate: async () => 'Own image.' }, store, new RequestQueue(4, 0), async attachment => {
    downloads++; assert.equal(attachment.url, own.url); return 'data:image/png;base64,own';
  });
  try {
    await chat.ask({ guildId: 'guild', channelId: 'channel', userId: 'member' }, 'Explain my attachment.', async (_answer, preview) => {
      assert.equal(preview, 'data:image/png;base64,own');
    }, { image: own, reference: abort => referencedInput(reference, scope, async () => ({ ...target, attachments: [image, image] }), abort, { useImage: false }) });
    assert.equal(downloads, 1);
  } finally { chat.close(); store.close(); }
});

test('expired referenced downloads and cancellation stop generation, delivery and history updates', async () => {
  for (const cancelled of [false, true]) {
    const store = new Conversations(':memory:');
    const controller = new AbortController();
    const identity = { guildId: 'guild', channelId: 'channel', userId: 'member' };
    let generations = 0; let deliveries = 0;
    const chat = new ChatService({ generate: async () => { generations++; return 'answer'; } }, store, new RequestQueue(4, 0), async () => {
      if (cancelled) { controller.abort(); return 'data:image/png;base64,unused'; }
      throw new Error('expired download');
    });
    try {
      await assert.rejects(chat.ask(identity, 'Explain.', async () => { deliveries++; }, {
        signal: controller.signal, reference: abort => referencedInput(reference, scope, async () => target, abort),
      }), cancelled ? { name: 'AbortError' } : /expired download/);
      assert.equal(generations, 0); assert.equal(deliveries, 0);
      assert.deepEqual(store.get(conversationKey(identity)), []);
    } finally { chat.close(); store.close(); }
  }
});
