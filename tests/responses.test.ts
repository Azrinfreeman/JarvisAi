import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { responseMessages } from '../src/responses.js';
import { ChatService, conversationKey, type ChatIdentity } from '../src/chat.js';
import { Conversations } from '../src/storage.js';
import { RequestQueue } from '../src/queue.js';

const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
const imageData = `data:image/png;base64,${png.toString('base64')}`;

test('long image questions use one reply with ordered question/image/answer embeds and a complete Unicode transcript', async () => {
  const question = '😀'.repeat(2000);
  const answer = 'answer\n'.repeat(1700);
  const source = 'https://discord.com/channels/guild/channel/message';
  const messages = await responseMessages(question, answer, imageData, source);
  assert.equal(messages.length, 1);
  const file = messages[0].files![0]!;
  assert.equal(file.name, 'question.png');
  assert.deepEqual(file.attachment, png);
  assert.deepEqual(messages[0].embeds!.map(embed => embed.title), ['Question', 'Answer']);
  assert.equal(messages[0].embeds![0]!.image!.url, 'attachment://question.png');
  assert.ok(messages[0].embeds!.every(embed => embed.description!.length <= 4096 && !/[\uD800-\uDBFF]\n/.test(embed.description!)));
  assert.ok(messages[0].embeds!.reduce((size, embed) => size + embed.title!.length + embed.description!.length, 0) <= 6000);
  const transcript = messages[0].files!.find(file => file.name === 'response.txt')!;
  assert.equal(transcript.attachment.toString('utf8'), `**In reply to:** ${source}\n\n**Question**\n${question}\n\n**Answer**\n${answer}`);
});

test('image preview fits the Discord upload limit while ordinary text responses keep question and answer together', async () => {
  const padded = Buffer.concat([png, Buffer.alloc(9 * 1024 * 1024)]);
  const messages = await responseMessages('Look at this', 'Red', `data:image/png;base64,${padded.toString('base64')}`);
  const preview = messages[0]!.files![0]!;
  assert.equal(preview.name, 'question.jpg');
  assert.ok(preview.attachment.length < 8 * 1024 * 1024);
  assert.equal((await sharp(preview.attachment).metadata()).width, 2);
  const text = await responseMessages('Hello', 'Hi');
  assert.deepEqual(text, [{ content: '**Question**\nHello\n\n**Answer**\nHi' }]);
});

test('private image delivery reuses the analyzed image without a second download or storing preview bytes', async () => {
  const store = new Conversations(':memory:');
  let downloads = 0;
  const chat = new ChatService({ generate: async messages => {
    assert.deepEqual(messages.at(-1)?.content, [
      { type: 'input_text', text: 'What is this?' },
      { type: 'input_image', image_url: imageData, detail: 'auto' },
    ]);
    return 'Red.';
  } }, store, new RequestQueue(4, 0), async () => { downloads++; return imageData; });
  const identity: ChatIdentity = { guildId: 'g', channelId: 'c', userId: 'u', visibility: 'private' };
  try {
    await chat.ask(identity, 'What is this?', async (answer, preview) => {
      const messages = await responseMessages('What is this?', answer, preview);
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0]?.files?.[0]?.attachment, png);
      assert.equal(messages[0].embeds![1]!.description, 'Red.');
    }, { image: { url: 'https://cdn.discordapp.com/attachments/g/c/image.png', size: png.length, contentType: 'image/png' } });
    assert.equal(downloads, 1);
    assert.ok(!JSON.stringify(store.get(conversationKey(identity))).includes('base64'));
    assert.deepEqual(store.get(conversationKey({ ...identity, visibility: 'public' })), []);
  } finally { chat.close(); store.close(); }
});

test('long text and channels without Embed Links keep all content in one reply instead of posting follow-ups', async () => {
  const question = '😀'.repeat(2000);
  const answer = 'Correct answer. '.repeat(700);
  for (const data of [undefined, imageData]) {
    const messages = await responseMessages(question, answer, data, undefined, undefined, false);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].content.length <= 1900);
    assert.ok(messages[0].content.includes('**Answer**'));
    assert.ok(!/[\uD800-\uDBFF]\n/.test(messages[0].content));
    assert.equal(messages[0].embeds, undefined);
    assert.equal(messages[0].files!.find(file => file.name === 'response.txt')!.attachment.toString('utf8'), `**Question**\n${question}\n\n**Answer**\n${answer}`);
    assert.equal(messages[0].files!.some(file => file.name === 'question.png'), !!data);
  }
});
