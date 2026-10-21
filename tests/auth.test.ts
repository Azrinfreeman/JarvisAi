import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { callbackClient, tokenFields, validateIdentity, validState } from '../src/auth.js';
import { protect } from '../src/vault.js';

test('callback validates state, consent, issued registration and returning client binding', () => {
  const url = new URL('http://127.0.0.1:1234/auth/callback?state=expected&code=code&client_id=oaiapp_trial');
  assert.equal(callbackClient(url, 'expected'), 'oaiapp_trial');
  assert.equal(validState('short', 'expected'), false);
  assert.equal(validState(null, 'expected'), false);
  assert.throws(() => callbackClient(url, 'wrong'), /state/);
  assert.throws(() => callbackClient(url, 'expected', 'another-client'), /different registration/);
  url.searchParams.set('client_id', 'dynamic_agent_client');
  assert.throws(() => callbackClient(url, 'expected'), /did not issue/);
  url.searchParams.delete('client_id');
  assert.equal(callbackClient(url, 'expected', 'saved-client'), 'saved-client');
  assert.throws(() => callbackClient(url, 'expected'), /did not issue/);
  url.searchParams.set('error', 'access_denied');
  assert.throws(() => callbackClient(url, 'expected', 'saved-client'), /declined/);
});

test('identity-only grants and malformed token responses cannot enable inference', () => {
  assert.throws(() => tokenFields({ access_token: 'x', scope: 'openid email', token_type: 'Bearer', expires_in: 3600 }), /plan usage/);
  assert.throws(() => tokenFields({ scope: 'chatgpt.tokens.use.direct', token_type: 'Bearer', expires_in: 3600 }), /incomplete/);
  assert.throws(() => tokenFields({ access_token: 'x', scope: 'chatgpt.tokens.use.direct', token_type: 'Bearer', expires_in: -1 }), /incomplete/);
  const fields = tokenFields({ access_token: 'new', token_type: 'Bearer', expires_in: 3600 }, ['chatgpt.tokens.use.direct']);
  assert.equal(fields.accessToken, 'new');
});

test('JWT rejects wrong signature, issuer, audience, nonce, expiry, and switched account', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key: JWTVerifyGetKey = async () => publicKey;
  async function token(overrides: { iss?: string; aud?: string; nonce?: string; exp?: number } = {}) {
    return new SignJWT({ nonce: overrides.nonce ?? 'nonce' }).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(overrides.iss ?? 'https://auth.openai.com').setAudience(overrides.aud ?? 'client')
      .setSubject('account').setIssuedAt().setExpirationTime(overrides.exp ?? Math.floor(Date.now() / 1000) + 60).sign(privateKey);
  }
  assert.equal(await validateIdentity(await token(), 'client', 'nonce', undefined, key), 'account');
  for (const overrides of [{ iss: 'wrong' }, { aud: 'wrong' }, { nonce: 'wrong' }, { exp: 1 }]) {
    await assert.rejects(validateIdentity(await token(overrides), 'client', 'nonce', undefined, key));
  }
  await assert.rejects(validateIdentity(await token(), 'client', 'nonce', 'other-account', key));
  const other = await generateKeyPair('RS256');
  await assert.rejects(validateIdentity(await token(), 'client', 'nonce', undefined, async () => other.publicKey));
});

test('Windows credential protection round-trips without plaintext storage', { skip: process.platform !== 'win32' }, () => {
  const input = JSON.stringify({ token: 'synthetic-test-token', unicode: '😀' });
  const encrypted = protect(input);
  assert.ok(!encrypted.includes('synthetic-test-token'));
  assert.equal(protect(encrypted, true), input);
});
