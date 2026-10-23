import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createDashboardServer, readRuntimeStatus } from '../src/dashboard/server.js';

async function fixture(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'rainbot-dashboard-'));
  try { await run(join(dir, 'status.json')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const snapshot = () => ({ at: new Date().toISOString(), pid: process.pid, stopped: false,
  discordReady: true, ai: { phase: 'ready', label: 'private connection detail' },
  rssMiB: 123, cpuPercent: 2.4, eventLoopP95Ms: 20,
  sleep: [{ state: 'active', mode: 'rain', rainStyle: 'soft', voice: 'ready', audio: 'playing', guild_id: 'private-server' }],
  token: 'private-token', account: 'private-account',
});

test('dashboard exposes only permitted runtime fields', async () => fixture(async path => {
  await writeFile(path, JSON.stringify(snapshot()));
  const result = await readRuntimeStatus(path);
  assert.equal(result.state, 'live');
  assert.equal(result.discordReady, true);
  assert.equal(result.aiPhase, 'ready');
  assert.deepEqual(result.metrics, { memoryMiB: 123, cpuPercent: 2.4, eventLoopMs: 20 });
  assert.equal(result.sessions[0]?.mode, 'rain');
  assert.doesNotMatch(JSON.stringify(result), /private-|label|guild_id|token|account/);
}));

test('dashboard rejects stale, stopped, invalid-time, and future snapshots', async () => fixture(async path => {
  for (const patch of [
    { at: new Date(Date.now() - 60000).toISOString() },
    { at: new Date(Date.now() + 60000).toISOString() },
    { at: 'invalid' }, { stopped: true }, { pid: -1 },
  ]) {
    await writeFile(path, JSON.stringify({ ...snapshot(), ...patch }));
    const result = await readRuntimeStatus(path);
    assert.equal(result.state, 'offline');
    assert.equal(result.discordReady, false);
    assert.equal(result.aiPhase, 'offline');
    assert.equal(result.metrics, null);
    assert.deepEqual(result.sessions, []);
  }
}));

test('dashboard tolerates missing and malformed status files', async () => fixture(async path => {
  assert.equal((await readRuntimeStatus(path)).state, 'unavailable');
  for (const body of ['{partial', 'null', '[]']) {
    await writeFile(path, body);
    const result = await readRuntimeStatus(path);
    assert.notEqual(result.state, 'live');
    assert.equal(result.discordReady, false);
  }
}));

test('dashboard bounds and sanitizes session data and metrics', async () => fixture(async path => {
  await writeFile(path, JSON.stringify({ ...snapshot(), cpuPercent: -1, rssMiB: '123', eventLoopP95Ms: null,
    ai: { phase: '<script>' }, sleep: Array.from({ length: 150 }, () => ({ mode: '<script>', rainStyle: 'unknown', audio: 'unsafe', voice: 'unsafe' })) }));
  const result = await readRuntimeStatus(path);
  assert.equal(result.sessions.length, 100);
  assert.equal(result.aiPhase, 'unavailable');
  assert.deepEqual(result.metrics, { memoryMiB: null, cpuPercent: null, eventLoopMs: null });
  assert.doesNotMatch(JSON.stringify(result), /script|unsafe/);
}));

test('HTTP dashboard serves assets and status while protecting local data', async () => fixture(async path => {
  await writeFile(path, JSON.stringify(snapshot()));
  const server = createDashboardServer(path);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const get = (url: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: url, headers, method }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP check timed out')));
    req.end();
  });
  try {
    for (const url of ['/', '/styles.css', '/app.js']) {
      const result = await get(url);
      assert.equal(result.status, 200);
      assert.ok(result.body.length > 100);
      assert.equal(result.headers['x-content-type-options'], 'nosniff');
      assert.match(String(result.headers['content-security-policy']), /frame-ancestors 'none'/);
    }
    const status = await get('/api/status');
    assert.equal(JSON.parse(status.body).discordReady, true);
    assert.doesNotMatch(status.body, /private-/);
    for (const url of ['/.env', '/data/runtime-status.json', '/src/main.ts', '/../.env', '/not-found']) {
      assert.equal((await get(url)).status, 404);
    }
    assert.equal((await get('/api/status', { host: 'attacker.example' })).status, 403);
    assert.equal((await get('/api/status', { origin: 'https://attacker.example' })).status, 403);
    assert.equal((await get('/api/status', { origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await get('/api/status', {}, 'POST')).status, 405);
    assert.equal((await get('/', {}, 'HEAD')).body, '');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}));
