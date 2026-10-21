import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations } from '../src/storage.js';
import { runtimeLock } from '../src/vault.js';

test('duplicate Discord deliveries are claimed once across independent database connections and restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-dedup-'));
  const path = join(directory, 'history.sqlite');
  let first: Conversations | undefined = new Conversations(path);
  const second = new Conversations(path);
  let reopened: Conversations | undefined;
  try {
    let generations = 0;
    const handle = async (store: Conversations) => {
      if (!store.claimEvent('message:jarvis:123')) return;
      generations++;
      await new Promise(resolve => setImmediate(resolve));
    };
    await Promise.all([handle(first), handle(second), handle(second)]);
    assert.equal(generations, 1);
    first.reset('member-public');
    first.close(); first = undefined;
    reopened = new Conversations(path);
    assert.equal(reopened.claimEvent('message:jarvis:123'), false);
    assert.equal(reopened.claimEvent('message:jarvis:124'), true);
    assert.equal(reopened.claimEvent('message:another-bot:123'), true);
    assert.equal(reopened.claimEvent('interaction:jarvis:123'), true);
    assert.equal(second.claimEvent('interaction:jarvis:123'), false);
  } finally { first?.close(); second.close(); reopened?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a failed attempt stays claimed so event replay cannot cause extra error replies or generations', async () => {
  const store = new Conversations(':memory:');
  try {
    assert.equal(store.claimEvent('message:jarvis:failed'), true);
    assert.equal(store.claimEvent('message:jarvis:failed'), false);
    assert.equal(store.claimEvent('message:jarvis:new-retry'), true);
  } finally { store.close(); }
});

test('runtime lock prevents duplicate startup and an older owner cannot remove a replacement lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-lock-'));
  const path = join(directory, 'runtime.lock');
  try {
    const release = runtimeLock(directory);
    assert.throws(() => runtimeLock(directory), /runtime lock/);
    writeFileSync(path, '987654321');
    release(); release();
    assert.equal(readFileSync(path, 'utf8'), '987654321');
    rmSync(path);
    const ownRelease = runtimeLock(directory);
    ownRelease();
    assert.equal(existsSync(path), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
