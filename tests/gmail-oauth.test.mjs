import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopClient, authorizationUrl, callbackCode, authorize, saveCredentials, GMAIL_SCOPE } from '../local/gmail-oauth.mjs';

const client = { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'fixture-secret' };

test('OAuth accepts Desktop clients, validates state, and requests only read-only Gmail with PKCE', () => {
  assert.deepEqual(desktopClient({ installed: client }), client);
  assert.throws(() => desktopClient({ web: client }), /Desktop/);
  const url = new URL(authorizationUrl(client.client_id, 'http://127.0.0.1:1234/oauth2/callback', 'verifier', 'expected'));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), GMAIL_SCOPE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(callbackCode(new URL('http://127.0.0.1/?state=expected&code=fixture'), 'expected'), 'fixture');
  assert.throws(() => callbackCode(new URL('http://127.0.0.1/?state=wrong&code=fixture'), 'expected'), /state/);
  assert.throws(() => callbackCode(new URL('http://127.0.0.1/?state=expected&error=denied'), 'expected'), /declined/);
});

test('loopback OAuth exchanges a verified callback without exposing token values', async () => {
  let request;
  const token = await authorize(client, {
    timeoutMs: 2000,
    onAuthorizationUrl: raw => {
      const auth = new URL(raw);
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fixture-code' });
      get(callback, res => res.resume());
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, scope: GMAIL_SCOPE }) };
    },
  });
  assert.equal(token, 'fixture-refresh');
  assert.equal(request.url, 'https://oauth2.googleapis.com/token');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.body.get('code'), 'fixture-code');
  assert.ok(request.options.body.get('code_verifier').length >= 43);
});

test('credential storage preserves unrelated settings, uses owner-only permissions, and refuses symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'gmail-oauth-'));
  try {
    const path = join(root, '.env');
    writeFileSync(path, '# keep\nOTHER_KEY=unchanged\nGMAIL_CLIENT_ID=old\n');
    saveCredentials(path, client, 'new-refresh');
    const text = readFileSync(path, 'utf8');
    assert.match(text, /# keep\nOTHER_KEY=unchanged/);
    assert.match(text, /GMAIL_REFRESH_TOKEN="new-refresh"/);
    assert.equal(text.match(/GMAIL_CLIENT_ID=/g).length, 1);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(root, 'linked.env');
    symlinkSync(path, link);
    assert.throws(() => saveCredentials(link, client, 'other'), /symlink/);
    assert.throws(() => saveCredentials(path, client, 'bad\nvalue'), /invalid credential/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OAuth refuses broader grants and times out without consent', async () => {
  await assert.rejects(() => authorize(client, {
    timeoutMs: 2000,
    onAuthorizationUrl: raw => {
      const auth = new URL(raw);
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fixture-code' });
      get(callback, res => res.resume());
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: `${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.modify` }) }),
  }), /exactly Gmail read-only/);
  await assert.rejects(() => authorize(client, { timeoutMs: 50, onAuthorizationUrl() {} }), /timed out/);
});
