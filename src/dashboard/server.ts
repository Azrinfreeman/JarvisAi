import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SettingsStore, isRecord } from '../settings.js';
import { OwnerSessions } from './sessions.js';
import { BotSupervisor } from './supervisor.js';
import { safeError, UserError } from '../errors.js';
import { DashboardService, emptyRequest } from './service.js';
import { stateRoot } from '../app-paths.js';

const root = stateRoot;
const publicRoot = new URL('./public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/transport.js', ['transport.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const member = (value: unknown, allowed: string[], fallback: string) => typeof value === 'string' && allowed.includes(value) ? value : fallback;

/** Only expose operational fields. Never serve the data directory or environment. */
export async function readRuntimeStatus(path = resolve(root, 'data/runtime-status.json'), now = Date.now()) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const timestamp = typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
    const fresh = Number.isFinite(timestamp) && now - timestamp >= -5000 && now - timestamp < 35000;
    let processAlive = false;
    if (Number.isSafeInteger(raw.pid) && raw.pid > 0) {
      try { process.kill(raw.pid, 0); processAlive = true; } catch { /* Exited or inaccessible. */ }
    }
    const live = fresh && processAlive && raw.stopped === false;
    return {
      state: live ? 'live' : 'offline',
      updatedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      discordReady: live && raw.discordReady === true,
      aiPhase: live ? member(raw.ai?.phase, ['starting', 'ready', 'unavailable', 'restarting'], 'unavailable') : 'offline',
      metrics: live ? { memoryMiB: finite(raw.rssMiB), cpuPercent: finite(raw.cpuPercent), eventLoopMs: finite(raw.eventLoopP95Ms) } : null,
      sessions: live && Array.isArray(raw.sleep) ? raw.sleep.slice(0, 100).map((session: Record<string, unknown> | null) => ({
        state: member(session?.state, ['active', 'connecting', 'reconnecting', 'suspended', 'disconnected'], 'unknown'),
        mode: member(session?.mode, ['rain', 'sunny', 'silent'], 'silent'),
        rainStyle: member(session?.rainStyle, ['variety', 'mild-thunder', 'soft', 'forest', 'indoor', 'glass', 'heavy'], 'forest'),
        voice: member(session?.voice, ['ready', 'connecting', 'signalling', 'disconnected', 'destroyed', 'absent'], 'absent'),
        audio: member(session?.audio, ['playing', 'buffering', 'idle', 'paused', 'autopaused', 'off'], 'off'),
      })) : [],
    };
  } catch {
    return { state: 'unavailable', updatedAt: null, discordReady: false, aiPhase: 'offline', metrics: null, sessions: [] };
  }
}

class HttpError extends UserError { constructor(readonly status: number, message: string) { super(message); } }
function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type'] !== 'application/json') throw new HttpError(415,'Use a JSON request.');
  return new Promise((resolve,reject) => {
    let buffer = ''; let bytes = 0;
    const timer = setTimeout(() => reject(new HttpError(408,'The request timed out.')),5000);
    req.on('data',chunk => {
      bytes += chunk.length;
      if (bytes > 16384) { buffer=''; clearTimeout(timer); reject(new HttpError(413,'The request is too large.')); }
      else buffer += chunk.toString('utf8');
    });
    req.on('end',() => { clearTimeout(timer); try { resolve(JSON.parse(buffer)); } catch { reject(new HttpError(400,'Invalid JSON request.')); } });
    req.on('error',() => { clearTimeout(timer); reject(new HttpError(400,'The request was interrupted.')); });
  });
}

export function createDashboardServer(statusPath?: string, options: { settings?: SettingsStore; sessions?: OwnerSessions; supervisor?: BotSupervisor; request?: typeof fetch } = {}) {
  const settings = options.settings ?? new SettingsStore();
  const sessions = options.sessions ?? new OwnerSessions();
  const supervisor = options.supervisor ?? new BotSupervisor(settings);
  const request = options.request ?? fetch;
  const service = new DashboardService(settings,supervisor,request);
  const testing = new Set<string>();
  const lastTest = new Map<string,number>();
  const mutationRates = new Map<string,{at:number;count:number}>();
  const server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => { res.setHeader('Content-Type','application/json; charset=utf-8'); res.writeHead(status).end(req.method === 'HEAD' ? undefined : JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    // Limit local browser access and reject DNS rebinding and cross-origin reads.
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
      json(403,{error:'The request must come from this local workspace.'}); return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (path === '/api/status' && read) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const body = JSON.stringify(await readRuntimeStatus(statusPath));
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : body); return;
    }
    if (path.startsWith('/api/') && path !== '/api/status') {
      try {
        if (path === '/api/session' && read) { const session = sessions.get(req); json(200,{authorized:!!session,...(session ? {csrf:session.csrf} : {})}); return; }
        if (!read && req.headers.origin !== `http://${req.headers.host}`) throw new HttpError(403,'The request must come from this workspace.');
        if (path === '/api/session' && req.method === 'POST') {
          const body = await jsonBody(req);
          if (!isRecord(body) || Object.keys(body).some(key => key !== 'code')) throw new HttpError(400,'Invalid connection request.');
          const result = sessions.exchange(body.code);
          res.setHeader('Set-Cookie',result.cookie); json(200,{authorized:true,csrf:result.csrf}); return;
        }
        if (!sessions.get(req)) throw new HttpError(401,'Connect this browser using the local access code from the dashboard terminal.');
        const session = sessions.require(req);
        if (!read) {
          if (req.headers['x-csrf-token'] !== session.csrf) throw new HttpError(403,'The workspace session changed. Reload and try again.');
          sessions.require(req,true);
          const rate=mutationRates.get(session.csrf);
          if (!rate || Date.now()-rate.at > 60000) mutationRates.set(session.csrf,{at:Date.now(),count:1});
          else if (++rate.count > 30) throw new HttpError(429,'Too many changes. Wait a minute before trying again.');
        }
        if (path === '/api/settings' && read) { json(200,settings.view()); return; }
        if (path === '/api/voice-summary/local' && read) { json(200,await service.localSpeechStatus()); return; }
        if (['/api/voice-summary/local/setup','/api/voice-summary/local/cancel'].includes(path) && req.method === 'POST') {
          emptyRequest(await jsonBody(req));
          json(path.endsWith('/setup') ? 202 : 200,await (path.endsWith('/setup') ? service.localSpeechSetup() : service.localSpeechCancel())); return;
        }
        if (path === '/api/voice-summary' && read) { json(200,await service.voiceSummaryStatus()); return; }
        if (path === '/api/management' && read) { json(200,await supervisor.status(url.searchParams.get('fresh') === '1')); return; }
        if (path.startsWith('/api/operations/') && read) {
          const operation = supervisor.getOperation(path.slice('/api/operations/'.length));
          json(operation ? 200 : 404,operation ?? {error:'Operation not found.'}); return;
        }
        if (path === '/api/settings' && req.method === 'PUT') {
          const body = await jsonBody(req);
          json(200,await service.save(body)); return;
        }
        if (path === '/api/bot/clear-stale-locks' && req.method === 'POST') {
          emptyRequest(await jsonBody(req));
          json(200,await supervisor.clearStaleLocks()); return;
        }
        if ((path === '/api/bot/start' || path === '/api/bot/stop') && req.method === 'POST') {
          const body = await jsonBody(req);
          if (!isRecord(body) || Object.keys(body).length) throw new HttpError(400,'Bot controls do not accept process IDs or commands.');
          json(202,supervisor.begin(path.endsWith('start') ? 'start' : 'stop')); return;
        }
        if (['/api/settings/test-discord','/api/settings/test-ai','/api/settings/test-ai-response'].includes(path) && req.method === 'POST') {
          const body = await jsonBody(req);
          if (!isRecord(body) || Object.keys(body).length) throw new HttpError(400,'Connection tests use saved settings only.');
          if (testing.has(session.csrf) || Date.now()-(lastTest.get(session.csrf) ?? 0) < 5000) throw new HttpError(429,'Wait a few seconds before another connection test.');
          testing.add(session.csrf); lastTest.set(session.csrf,Date.now());
          try {
            json(200,await service.test(path.slice('/api/settings/test-'.length)));
          } finally { testing.delete(session.csrf); }
          return;
        }
        json(404,{error:'Endpoint not found.'}); return;
      } catch(error) { json(error instanceof HttpError ? error.status : error instanceof UserError ? 400 : 500,{error:safeError(error)}); return; }
    }
    if (!read) { res.writeHead(405,{Allow:'GET, HEAD'}).end(); return; }
    const asset = assets.get(path);
    if (!asset) { res.writeHead(404).end('Not found'); return; }
    try {
      const body = await readFile(new URL(asset[0]!, publicRoot));
      res.setHeader('Content-Type', asset[1]!);
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500).end('Unable to load dashboard.'); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DASHBOARD_PORT ?? 3210);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DASHBOARD_PORT must be between 1024 and 65535.');
  const sessions = new OwnerSessions();
  const server = createDashboardServer(undefined,{sessions});
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Choose another DASHBOARD_PORT.` : 'Unable to start the dashboard.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`RainBot dashboard: http://127.0.0.1:${port}`);
    console.log(`Local access code (single use, valid 10 minutes): ${sessions.accessCode()}`);
    console.log('Open the dashboard and choose Connect workspace. Keep this code private.');
  });
}
