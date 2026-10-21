import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../src/sleep/storage/session-store.js';

test('leave is durable and removed from startup restoration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-bot-test-'));
  const path = join(dir, 'sessions.sqlite');
  try {
    let store = new SessionStore(path);
    store.save({ guildId: 'guild-1', channelId: 'voice-1', mode: 'rain', state: 'active' });
    assert.equal(store.active().length, 1);
    store.save({ guildId: 'guild-1', channelId: 'voice-1', mode: 'rain', state: 'disabled' });
    store.close();

    store = new SessionStore(path);
    assert.equal(store.active().length, 0);
    assert.equal(store.get('guild-1').state, 'disabled');
    assert.equal(store.get('guild-1').rain_style, 'variety');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rain style survives session updates and restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-bot-style-'));
  const path = join(dir, 'sessions.sqlite');
  try {
    let store = new SessionStore(path);
    store.save({ guildId: 'guild-3', channelId: 'voice-3', mode: 'rain', state: 'active', rainStyle: 'mild-thunder' });
    store.save({ guildId: 'guild-3', channelId: 'voice-3', mode: 'silent', state: 'active' });
    store.close();
    store = new SessionStore(path);
    assert.equal(store.get('guild-3').rain_style, 'mild-thunder');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('older session databases gain the variety style', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-bot-migrate-'));
  const path = join(dir, 'sessions.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE sessions (guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL)");
    old.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('guild-4', 'voice-4', 'rain', 'active', null, new Date().toISOString());
    old.close();
    const store = new SessionStore(path);
    assert.equal(store.get('guild-4').rain_style, 'variety');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suspended session remains saved without automatic restoration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-bot-test-'));
  try {
    const store = new SessionStore(join(dir, 'sessions.sqlite'));
    store.save({ guildId: 'guild-2', channelId: 'voice-2', mode: 'silent', state: 'suspended', reason: 'Moved by operator' });
    assert.equal(store.active().length, 0);
    assert.equal(store.get('guild-2').reason, 'Moved by operator');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sunny mode upgrades older mode constraints without losing saved sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleep-bot-sunny-migrate-'));
  const path = join(dir, 'sessions.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE sessions (guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('silent','rain')), state TEXT NOT NULL, reason TEXT, rain_style TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const rows = [
      ['active-guild', 'voice-1', 'rain', 'active', null, 'mild-thunder', '2026-10-08T00:00:00.000Z'],
      ['suspended-guild', 'voice-2', 'silent', 'suspended', 'Moved by operator', 'glass', '2026-10-08T00:01:00.000Z'],
      ['disabled-guild', 'voice-3', 'rain', 'disabled', null, 'forest', '2026-10-08T00:02:00.000Z'],
    ];
    for (const row of rows) old.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(...row);
    old.close();
    let store = new SessionStore(path);
    for (const row of rows) {
      const saved = store.get(row[0]);
      assert.deepEqual([saved.guild_id, saved.channel_id, saved.mode, saved.state, saved.reason, saved.rain_style, saved.updated_at], row);
    }
    store.save({ guildId: 'active-guild', channelId: 'voice-1', mode: 'sunny', state: 'active' });
    store.close();
    store = new SessionStore(path);
    assert.equal(store.get('active-guild').mode, 'sunny');
    assert.equal(store.get('active-guild').rain_style, 'mild-thunder');
    assert.equal(store.active().length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
