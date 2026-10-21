import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatService, conversationKey, type ChatIdentity } from '../src/chat.js';
import { Conversations } from '../src/storage.js';
import type { ProviderMessage } from '../src/provider.js';
import { RequestQueue } from '../src/queue.js';
import { mentionedPrompt } from '../src/mentions.js';
import { commands } from '../src/commands.js';

test('shared chat isolates members and keeps private and legacy history out of public answers', async () => {
  const store = new Conversations(':memory:');
  const inputs: ProviderMessage[][] = [];
  const provider = { generate: async (messages: ProviderMessage[]) => { inputs.push(messages); return 'answer'; } };
  const chat = new ChatService(provider, store, new RequestQueue(4, 0));
  const a: ChatIdentity = { guildId: 'guild', channelId: 'voice-channel-text', userId: 'a', visibility: 'private' };
  const b: ChatIdentity = { ...a, userId: 'b', visibility: 'public' };
  try {
    const legacy = conversationKey({ ...a, visibility: undefined });
    store.append(legacy, 'old owner secret', 'old answer');
    await chat.ask(a, 'private secret', async () => {});
    await chat.ask({ ...a, visibility: 'public' }, 'public question', async () => {});
    await chat.ask(b, 'other member question', async () => {});
    await chat.ask({ ...a, visibility: 'public' }, 'follow-up', async () => {});
    assert.deepEqual(inputs[0], [{ role: 'user', content: 'private secret' }]);
    assert.deepEqual(inputs[1], [{ role: 'user', content: 'public question' }]);
    assert.deepEqual(inputs[2], [{ role: 'user', content: 'other member question' }]);
    assert.deepEqual(inputs[3]?.map(m => m.content), ['public question', 'answer', 'follow-up']);
    chat.reset(a);
    assert.deepEqual(store.get(conversationKey(a)), []);
    assert.deepEqual(store.get(conversationKey({ ...a, visibility: 'public' })), []);
    assert.deepEqual(store.get(legacy), []);
    assert.equal(store.get(conversationKey(b))[0]?.content, 'other member question');
  } finally { chat.close(); store.close(); }
});

test('undelivered answers do not become conversation history', async () => {
  const store = new Conversations(':memory:');
  const chat = new ChatService({ generate: async () => 'answer' }, store, new RequestQueue(4, 0));
  const identity = { guildId: 'g', channelId: 'c', userId: 'u' };
  try {
    await assert.rejects(chat.ask(identity, 'question', async () => { throw new Error('Discord delivery failed'); }), /delivery failed/);
    assert.deepEqual(store.get(conversationKey(identity)), []);
    await chat.ask(identity, 'retry', async () => {});
    assert.equal(store.get(conversationKey(identity))[0]?.content, 'retry');
  } finally { chat.close(); store.close(); }
});

test('reset is blocked until an active generation finishes', async () => {
  const store = new Conversations(':memory:');
  let finish!: (value: string) => void;
  const chat = new ChatService({ generate: () => new Promise(resolve => { finish = resolve; }) }, store, new RequestQueue(4, 0));
  const identity: ChatIdentity = { guildId: 'g', channelId: 'c', userId: 'u', visibility: 'public' };
  try {
    const answer = chat.ask(identity, 'question', async () => {});
    await Promise.resolve();
    assert.throws(() => chat.reset(identity), /current request/);
    finish('answer'); await answer;
    chat.reset(identity);
    assert.deepEqual(store.get(conversationKey(identity)), []);
  } finally { chat.close(); store.close(); }
});

test('mention parsing responds only to this bot and strips its mention from the prompt', () => {
  const bot = '123456789012345678';
  assert.equal(mentionedPrompt(`<@${bot}> hello`, bot), 'hello');
  assert.equal(mentionedPrompt(`hello <@!${bot}>`, bot), 'hello');
  assert.equal(mentionedPrompt(`<@${bot}>`, bot), '');
  assert.equal(mentionedPrompt('<@other> hello', bot), undefined);
  assert.equal(mentionedPrompt(`@everyone <@&${bot}>`, bot), undefined);
  assert.equal(mentionedPrompt('ordinary conversation', bot), undefined);
});

test('registered commands offer optional private replies without spoken-voice commands', () => {
  const ask = commands.find(command => command.name === 'ask');
  assert.ok(ask?.options?.some(option => option.name === 'private'));
  assert.ok(!commands.some(command => command.name === 'voice'));
});
