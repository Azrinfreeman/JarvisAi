import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChannelType, PermissionsBitField } from 'discord.js';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { SessionStore } from '../src/sleep/storage/session-store.js';
import { SessionManager } from '../src/sleep/session/session-manager.js';

test('leave disables a saved session before runtime cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-bot-manager-'));
  const store = new SessionStore(join(dir, 'sessions.sqlite'));
  try {
    store.save({ guildId: 'g1', channelId: 'c1', mode: 'rain', state: 'active' });
    const manager = new SessionManager({}, store, { minReconnectMs: 5000, maxReconnectMs: 300000 });
    assert.match(await manager.leave('g1'), /will not rejoin/);
    assert.equal(store.get('g1').state, 'disabled');
    assert.equal(store.active().length, 0);
    assert.match(await manager.leave('g1'), /already out/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('joining another channel cannot silently move an active session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-bot-manager-'));
  const store = new SessionStore(join(dir, 'sessions.sqlite'));
  try {
    store.save({ guildId: 'g2', channelId: 'c1', mode: 'silent', state: 'active' });
    const manager = new SessionManager({}, store, { minReconnectMs: 5000, maxReconnectMs: 300000 });
    await assert.rejects(manager.join({ id: 'g2' }, { id: 'c2' }, 'rain'), /Already active/);
    assert.equal(store.get('g2').channel_id, 'c1');
    assert.equal(store.get('g2').mode, 'silent');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('switching rain and sunny audio replaces only the player, preserving voice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-bot-audio-switch-'));
  const store = new SessionStore(join(dir, 'sessions.sqlite'));
  const manager = new SessionManager({}, store, {
    sunnyAssetPath: resolve('./assets/sunny-birds-loop.pcm'), rainVolume: 0.5,
    rainScenePaths: Object.fromEntries(['soft', 'forest', 'indoor', 'glass', 'heavy'].map((scene) => [
      scene, resolve(scene === 'forest' ? './assets/rain-loop.pcm' : `./assets/rain-${scene}-loop.pcm`),
    ])),
  });
  let destroyed = 0;
  const connection = { state: { status: VoiceConnectionStatus.Ready }, subscribe: () => ({ unsubscribe() {} }), destroy() { destroyed += 1; } };
  manager.getConnection = () => connection;
  try {
    store.save({ guildId: 'sunny-guild', channelId: 'voice', mode: 'rain', state: 'active', rainStyle: 'mild-thunder' });
    manager.applyAudio('sunny-guild');
    const rainPlayer = manager.getRuntime('sunny-guild').player;
    store.save({ guildId: 'sunny-guild', channelId: 'voice', mode: 'sunny', state: 'active' });
    manager.applyAudio('sunny-guild');
    const sunnyPlayer = manager.getRuntime('sunny-guild').player;
    assert.notEqual(sunnyPlayer, rainPlayer);
    assert.equal(manager.getRuntime('sunny-guild').audioMode, 'sunny');
    assert.match(manager.status('sunny-guild'), /sunny morning birdsong/);
    manager.applyAudio('sunny-guild');
    assert.equal(manager.getRuntime('sunny-guild').player, sunnyPlayer);
    store.save({ guildId: 'sunny-guild', channelId: 'voice', mode: 'rain', state: 'active' });
    manager.applyAudio('sunny-guild');
    assert.equal(manager.getRuntime('sunny-guild').stream.style, 'mild-thunder');
    assert.equal(destroyed, 0, 'changing ambience must not destroy voice');
  } finally {
    manager.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sunny playback requires Speak and saves the mode only after permission validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-bot-sunny-permissions-'));
  const store = new SessionStore(join(dir, 'sessions.sqlite'));
  const flags = PermissionsBitField.Flags;
  const available = new Set([flags.ViewChannel, flags.Connect]);
  const channel = { id: 'voice', guildId: 'guild', type: ChannelType.GuildVoice,
    permissionsFor: () => ({ has: (required) => required.every((flag) => available.has(flag)) }) };
  const guild = { id: 'guild', members: { me: {} }, channels: { fetch: async () => channel } };
  const manager = new SessionManager({ guilds: { fetch: async () => guild } }, store, { sunnyAssetPath: resolve('./assets/sunny-birds-loop.pcm') });
  manager.getConnection = () => ({ state: { status: VoiceConnectionStatus.Ready } });
  manager.applyAudio = () => {};
  try {
    store.save({ guildId: 'guild', channelId: 'voice', mode: 'silent', state: 'active' });
    await assert.rejects(manager.setMode('guild', 'sunny'), /Speak/);
    assert.equal(store.get('guild').mode, 'silent');
    available.add(flags.Speak);
    assert.match(await manager.setMode('guild', 'sunny'), /Sunny morning birdsong is on/);
    assert.equal(store.get('guild').mode, 'sunny');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
