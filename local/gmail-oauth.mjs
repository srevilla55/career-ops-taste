#!/usr/bin/env node
// Google's installed-app flow: https://developers.google.com/identity/protocols/oauth2/native-app
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function desktopClient(json) {
  const client = json?.installed;
  if (!client || typeof client.client_id !== 'string' || !client.client_id.endsWith('.apps.googleusercontent.com') ||
      typeof client.client_secret !== 'string' || !client.client_secret.trim()) {
    throw new Error('Use the downloaded Google OAuth JSON for a Desktop app client.');
  }
  return { client_id: client.client_id, client_secret: client.client_secret };
}

export function authorizationUrl(clientId, redirectUri, verifier, state) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: GMAIL_SCOPE, access_type: 'offline', prompt: 'consent', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  return url.href;
}

export function callbackCode(url, expectedState) {
  const supplied = Buffer.from(url.searchParams.get('state') || '');
  const expected = Buffer.from(expectedState);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('OAuth state did not match; nothing was saved.');
  if (url.searchParams.has('error')) throw new Error('Google authorization was declined; nothing was saved.');
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) throw new Error('Google returned no valid authorization code; nothing was saved.');
  return code;
}

export function saveCredentials(path, client, refreshToken) {
  path = resolve(path);
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Refusing to replace a symlinked environment file.');
  const values = { GMAIL_CLIENT_ID: client.client_id, GMAIL_CLIENT_SECRET: client.client_secret, GMAIL_REFRESH_TOKEN: refreshToken };
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new Error('Google returned an invalid credential; nothing was saved.');
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm');
    if (pattern.test(text)) text = text.replace(pattern, () => line);
    else text += `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomBytes(12).toString('hex')}`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally { try { unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
}

export async function authorize(client, { onAuthorizationUrl = console.log, fetchImpl = fetch, timeoutMs = 300_000 } = {}) {
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  let callback;
  let fail;
  const received = new Promise((resolve, reject) => { callback = resolve; fail = reject; });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/oauth2/callback') { res.writeHead(404); res.end('Not found'); return; }
    try {
      const code = callbackCode(url, state);
      res.end('Google authorization received. Return to the terminal to finish.');
      callback(code);
    } catch (err) { res.writeHead(400); res.end('Authorization could not be verified. Return to the terminal.'); fail(err); }
  });
  const timer = setTimeout(() => fail(new Error('Google authorization timed out; nothing was saved.')), timeoutMs);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2/callback`;
    onAuthorizationUrl(authorizationUrl(client.client_id, redirectUri, verifier, state));
    const code = await received;
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...client, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }),
    });
    if (!response.ok) throw new Error(`Google token exchange failed (HTTP ${response.status}); nothing was saved.`);
    const token = await response.json();
    if (typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string' || !token.refresh_token ||
        token.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 ||
        token.scope?.trim() !== GMAIL_SCOPE) throw new Error('Google did not grant exactly Gmail read-only offline access; nothing was saved.');
    return token.refresh_token;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const usage = 'Connect Gmail read-only locally:\n  node local/gmail-oauth.mjs --client /absolute/path/client_secret.json\n\nDownload a Desktop OAuth client JSON after enabling Gmail API. Credentials are saved in the ignored local .env, never printed.';
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  const { values } = parseArgs({ args, options: { client: { type: 'string' }, env: { type: 'string' } } });
  if (!values.client) { console.log(usage); process.exitCode = 2; return; }
  const client = desktopClient(JSON.parse(readFileSync(resolve(values.client), 'utf8')));
  console.log('Open this Google URL in your browser and authorize read-only Gmail access:');
  const refreshToken = await authorize(client);
  const envPath = values.env ? resolve(values.env) : join(getCareerOpsRoot(), '.env');
  saveCredentials(envPath, client, refreshToken);
  console.log(`Gmail credentials saved locally with owner-only permissions: ${envPath}`);
  console.log('Next: follow docs/LINKEDIN_JOBS.md to configure the LinkedIn Jobs label and preview the import. No mail was read by this setup command.');
}

if (isMainModule(import.meta.url)) main().catch(err => { console.error(err instanceof SyntaxError ? 'The client JSON is invalid; nothing was saved.' : err.message); process.exitCode = 1; });
