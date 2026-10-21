import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { readCredential, saveCredential, clearCredential, hostId, type Credential } from './vault.js';
import { UserError, providerError } from './errors.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const planScope = 'chatgpt.tokens.use.direct';

export function validState(actual: string | null, expected: string): boolean {
  const left = Buffer.from(actual ?? '');
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function callbackClient(url: URL, state: string, previousClient?: string): string {
  if (!validState(url.searchParams.get('state'), state)) throw new UserError('Sign-in callback state was invalid.');
  if (url.searchParams.has('error')) throw new UserError('ChatGPT sign-in was declined or could not be completed.');
  if (!url.searchParams.get('code')) throw new UserError('Sign-in callback did not contain a code.');
  const returned = url.searchParams.get('client_id');
  if (previousClient && returned && previousClient !== returned) throw new UserError('Sign-in returned a different registration.');
  const client = returned || previousClient;
  if (!client || client === 'dynamic_agent_client') throw new UserError('ChatGPT did not issue a client registration. Check integration eligibility.');
  return client;
}

export async function validateIdentity(idToken: string, clientId: string, nonce: string, previousSubject?: string,
  key: JWTVerifyGetKey = jwks): Promise<string> {
  const { payload } = await jwtVerify(idToken, key, { issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'nonce'] });
  if (payload.nonce !== nonce || !payload.sub || (previousSubject && payload.sub !== previousSubject)) {
    throw new UserError('ChatGPT identity validation failed. The existing connection was not replaced.');
  }
  return payload.sub;
}

type TokenResponse = { access_token?: string; refresh_token?: string; id_token?: string; token_type?: string; scope?: string; expires_in?: number };
async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  if (!response.ok) throw providerError(response.status);
  return await response.json() as TokenResponse;
}

export function tokenFields(token: TokenResponse, previousScopes: string[] = []) {
  const scopes = token.scope === undefined ? previousScopes : token.scope.split(/\s+/).filter(Boolean);
  if (!scopes.includes(planScope)) throw new UserError('Sign-in did not grant ChatGPT plan usage. No inference request was made. Check eligibility and consent.');
  if (!token.access_token || token.token_type?.toLowerCase() !== 'bearer'
    || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new UserError('ChatGPT returned an incomplete token response. Reconnect before trying again.');
  }
  return { accessToken: token.access_token, scopes, expiresAt: Date.now() + token.expires_in * 1000 };
}

export async function login() {
  const previous = readCredential();
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let settle: ((url: URL) => void) | undefined;
  const callback = new Promise<URL>(resolve => { settle = resolve; });
  let consumed = false;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    let url: URL;
    try { url = new URL(req.url || '/', 'http://127.0.0.1'); }
    catch { res.writeHead(400).end('Invalid callback URL.'); return; }
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
    if (!validState(url.searchParams.get('state'), state) || consumed) {
      res.writeHead(400).end('Invalid or already-used callback. Return to the terminal.'); return;
    }
    consumed = true;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Sign-in callback received. Return to your terminal to check whether the connection succeeded. You may close this tab.');
    settle!(url);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new UserError('Could not open the local sign-in callback.');
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const url = new URL(`${issuer}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: previous?.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: hostId(), response_type: 'code', redirect_uri: redirectUri,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource, state, nonce, code_challenge_method: 'S256', code_challenge: challenge,
      ...(previous ? {} : { agent_name_hint: 'Personal AI Discord Bot' }),
    }).toString();
    console.log('Continue with ChatGPT in your browser. Eligible requests use your existing plan allowance.');
    console.log('You can manage app access and usage in ChatGPT Settings. This trial is only for your own Discord user.');
    console.log(`If no browser opens, open this URL locally:\n${url.href}`);
    if (process.platform === 'win32') {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url.href], { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => {}); child.unref();
    }
    const timeout = AbortSignal.timeout(5 * 60 * 1000);
    const returned = await new Promise<URL>((resolve, reject) => {
      const abort = () => reject(new UserError('Sign-in timed out. Run login again.'));
      timeout.addEventListener('abort', abort, { once: true });
      callback.then(value => { timeout.removeEventListener('abort', abort); resolve(value); });
    });
    const clientId = callbackClient(returned, state, previous?.clientId);
    const token = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId,
      code: returned.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirectUri, resource });
    if (!token.id_token) throw new UserError('ChatGPT did not return an identity token.');
    const subject = await validateIdentity(token.id_token, clientId, nonce, previous?.subject);
    const fields = tokenFields(token);
    saveCredential({ clientId, subject, idToken: token.id_token, refreshToken: token.refresh_token, ...fields });
    console.log('ChatGPT plan permission validated and connection protected with Windows DPAPI. No model request has been made yet.');
  } finally { server.close(); server.closeAllConnections(); }
}

let refreshing: Promise<Credential> | undefined;
async function refresh(): Promise<Credential> {
  const saved = readCredential();
  if (!saved) throw new UserError('ChatGPT is not connected. Stop the bot and run npm run auth -- login.');
  if (!saved.scopes.includes(planScope)) throw new UserError('This connection does not have ChatGPT plan permission.');
  if (saved.expiresAt > Date.now() + 60000) return saved;
  if (!saved.refreshToken) throw new UserError('ChatGPT sign-in expired. Stop the bot and sign in again.');
  const token = await tokenRequest({ grant_type: 'refresh_token', client_id: saved.clientId,
    refresh_token: saved.refreshToken, resource });
  const renewed = { ...saved, ...tokenFields(token, saved.scopes), refreshToken: token.refresh_token ?? saved.refreshToken };
  saveCredential(renewed);
  return renewed;
}

export async function accessToken(): Promise<string> {
  if (!refreshing) refreshing = refresh().finally(() => { refreshing = undefined; });
  return (await refreshing).accessToken;
}

export async function logout() {
  const saved = readCredential();
  let revoked = !saved;
  try {
    if (saved?.refreshToken) {
      const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!discovery.ok) throw new Error('discovery');
      const config = await discovery.json() as { issuer: string; revocation_endpoint?: string };
      const endpoint = new URL(config.revocation_endpoint ?? '');
      if (config.issuer !== issuer || endpoint.origin !== issuer) throw new Error('discovery');
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: saved.refreshToken, token_type_hint: 'refresh_token', client_id: saved.clientId }) });
      revoked = response.status === 200;
    }
  } catch { revoked = false; }
  finally { clearCredential(); }
  console.log(revoked ? 'Disconnected and renewable session revoked.'
    : 'Local credentials deleted. Remote revocation was not confirmed: disconnect this app in ChatGPT Settings > Security and login > Sign in with ChatGPT.');
}
