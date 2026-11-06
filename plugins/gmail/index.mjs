// @ts-check
// ── Reference seed ── This bundled plugin is a stable, reviewed example. To
// extend it, publish career-ops-plugin-<id> with "supersedesBundled": true and
// your version takes precedence once installed (see docs/PLUGINS.md). Bundled
// seeds take only security/compat fixes — feature work happens in the successor repo.
//
// Gmail ingest plugin — pulls job leads from a Gmail label into your pipeline.
//
// Ported from the email-driven ingestion contributed by @SparshGarg999 in #1203
// (with thanks), reshaped to the plugin contract: OAuth credentials come from
// the scoped ctx.env (not credential files), the label/days_back come from
// ctx.settings (config/plugins.yml), and the hook RETURNS Job[] — the engine
// (plugins.mjs), not this plugin, writes them to pipeline.md canonically. No
// `search://` rows are emitted (they aren't real URLs the pipeline can open).
//
// Enable in config/plugins.yml:
//   gmail: { enabled: true, label: "Job Leads", days_back: 7 }
// Add to .env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.
// Run:  node plugins.mjs run gmail

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { linkedInJobsFromText } from '../../lib/linkedin-import.mjs';
import {
  extractUrls, isCleanUrl, isAuthenticEmail, parseRoleAtCompany,
  getMessageBody, companyFromUrl,
} from './_helpers.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const STATE_FILE = join('data', 'gmail-state.json'); // the plugin's own processed-id cursor

// The cursor is user-layer data, so it lives under the data root (ctx.dataRoot)
// like the pipeline the engine writes these leads to. A ctx that carries no
// dataRoot comes from an engine older than the capability, and keeps the
// working directory that engine's plugins used.
const statePath = (ctx) => join(ctx?.dataRoot || process.cwd(), STATE_FILE);
// Where the cursor was kept before: relative to the working directory, which is
// the data root only when the two happen to coincide.
const legacyStatePath = () => resolve(STATE_FILE);

/** Exchange the long-lived refresh token for a short-lived access token. */
async function getAccessToken({ clientId, clientSecret, refreshToken }, fetchFn = globalThis.fetch) {
  let res;
  try { res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  }); } catch (err) {
    throw new Error(/invalid_grant/.test(String(err?.message))
      ? 'Gmail authorization expired or was revoked. Run node local/gmail-oauth.mjs --client <client.json> again.'
      : 'Gmail token refresh failed; no messages were read.');
  }
  if (!res.ok) {
    let code;
    try { code = (await res.json()).error; } catch { /* status is sufficient */ }
    throw new Error(code === 'invalid_grant'
      ? 'Gmail authorization expired or was revoked. Run node local/gmail-oauth.mjs --client <client.json> again.'
      : `Gmail token refresh failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Gmail token refresh returned no access_token');
  return data.access_token;
}

function loadProcessedIds(ctx) {
  let path = statePath(ctx);
  if (!existsSync(path)) {
    // No cursor under the data root yet. Read the one an earlier version left
    // in the working directory, so the first run after the move does not
    // re-ingest every message it had already processed. The next save writes
    // the data-root file, and from then on this branch is never taken. The old
    // file is left where it is.
    const legacy = legacyStatePath();
    if (!existsSync(legacy)) return new Set();
    ctx.log(`gmail: using the processed-id cursor at ${legacy}; the next save writes it to ${path}`);
    path = legacy;
  }
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8'));
    return new Set(state.processed_message_ids || []);
  } catch {
    return new Set();
  }
}

function saveProcessedIds(ids, ctx) {
  const path = statePath(ctx);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify({ processed_message_ids: [...ids] }, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
}

const LINKEDIN_SENDERS = new Set(['jobalerts-noreply@linkedin.com', 'jobs-noreply@linkedin.com']);

function isLinkedInSender(headers) {
  const from = headers.filter(h => h.name?.toLowerCase() === 'from');
  if (from.length !== 1) return false;
  const value = String(from[0].value || '').trim();
  const enclosed = value.match(/^[^<>\r\n]*<([^<>\r\n]+)>$/);
  return LINKEDIN_SENDERS.has((enclosed ? enclosed[1] : value).toLowerCase());
}

/** Read explicit per-job plaintext blocks; HTML-only or ambiguous metadata stays unknown. */
export function linkedInEmailOffers(payload) {
  const jobs = linkedInJobsFromText(getMessageBody(payload));
  const lines = [];
  function plain(part) {
    if (part?.mimeType === 'text/plain') lines.push(...getMessageBody({ ...part, parts: [] }).split(/\r?\n/));
    for (const child of part?.parts || []) plain(child);
  }
  plain(payload);
  const above = new Map();
  for (let i = 0; i < lines.length; i++) {
    for (const job of linkedInJobsFromText(lines[i])) {
      if (above.has(job.id)) continue;
      const block = [];
      for (let p = i - 1; p >= 0 && block.length < 4; p--) {
        const line = lines[p].trim();
        if (!line || /https?:\/\/|<[^>]+>|^(?:from|subject|date|to):/i.test(line)) break;
        if (/^(?:view job|see job|easy apply|apply now)$/i.test(line)) continue;
        block.unshift(line);
      }
      above.set(job.id, block);
    }
  }
  return jobs.map(job => {
    const block = above.get(job.id) || [];
    // LinkedIn's plaintext card is title, company, then optional location.
    // Longer paragraphs and missing blocks cannot prove either employer or title.
    const explicit = (block.length === 2 || block.length === 3) && block.every(line => line.length <= 120);
    return {
      url: job.url,
      title: explicit ? block[0] : 'Job alert',
      company: explicit ? block[1] : '',
      location: explicit && block.length === 3 ? block[2] : '',
      note: `src:gmail linkedin-alert; ${explicit && block.length === 3 ? '' : 'metadata incomplete; '}JD unavailable; employer/liveness unconfirmed`,
    };
  });
}

/** @type {{ ingest: (ctx: any) => Promise<object[]> }} */
export default {
  async ingest(ctx) {
    const clientId = ctx?.env?.GMAIL_CLIENT_ID;
    const clientSecret = ctx?.env?.GMAIL_CLIENT_SECRET;
    const refreshToken = ctx?.env?.GMAIL_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('gmail: missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN in .env');
    }

    const linkedinAlerts = ctx?.settings?.linkedin_alerts === true;
    const label = ctx?.settings?.label || (linkedinAlerts ? 'LinkedIn Jobs' : 'Job Leads');
    if (typeof label !== 'string' || !label.trim() || /["\r\n]/.test(label)) throw new Error('gmail: label must be a nonempty label name without quotes or line breaks');
    const daysBack = Number(ctx?.settings?.days_back ?? 7);
    if (!Number.isInteger(daysBack) || daysBack <= 0) {
      throw new Error(`gmail: invalid days_back "${ctx?.settings?.days_back}" (must be a positive integer)`);
    }

    // Return partial progress before the host's 120s hook limit; no request survives this budget.
    const deadline = Date.now() + 100_000;
    const signal = AbortSignal.timeout(100_000);
    const expired = () => signal.aborted || Date.now() >= deadline;
    const request = (url, options = {}) => {
      if (expired()) throw new DOMException('Gmail read budget exhausted', 'TimeoutError');
      return ctx.fetch(url, { ...options, signal, timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now())) });
    };
    const failures = [];
    const token = await getAccessToken({ clientId, clientSecret, refreshToken }, request);
    const auth = { Authorization: `Bearer ${token}` };
    const query = `label:"${label}" newer_than:${daysBack}d${linkedinAlerts ? ' (from:jobalerts-noreply@linkedin.com OR from:jobs-noreply@linkedin.com)' : ''}`;
    ctx.log(`gmail: querying ${query}`);

    // A failed page or exhausted budget preserves already listed messages as partial progress.
    const messages = [];
    const pageTokens = new Set();
    let pageToken = null;
    do {
      if (expired()) { failures.push('read budget exhausted'); break; }
      let url = `${GMAIL_API}/messages?q=${encodeURIComponent(query)}`;
      if (pageToken) url += `&pageToken=${pageToken}`;
      let data;
      try { data = await (await request(url, { headers: auth })).json(); }
      catch {
        failures.push('message listing incomplete');
        ctx.log('gmail: message listing incomplete; unread messages retained for retry');
        break;
      }
      if (data.messages) messages.push(...data.messages);
      pageToken = data.nextPageToken;
      if (pageToken && pageTokens.has(pageToken)) throw new Error('gmail: repeated pagination token; no messages acknowledged');
      if (pageToken) pageTokens.add(pageToken);
    } while (pageToken);

    const processedIds = loadProcessedIds(ctx);
    const seenUrls = new Set();
    const jobs = [];

    for (const m of messages) {
      if (processedIds.has(m.id)) continue;
      if (expired()) { failures.push('read budget exhausted'); break; }
      // Per-message resilience: a single bad detail fetch is skipped, not fatal.
      let msg;
      try {
        msg = await (await request(`${GMAIL_API}/messages/${m.id}?format=full`, { headers: auth })).json();
      } catch (err) {
        failures.push('message fetch failed');
        ctx.log('gmail: a message could not be read; retained for retry');
        continue;
      }
      const headers = msg.payload?.headers || [];
      const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';

      // Fail-closed on spoofed mail (DMARC).
      if (!isAuthenticEmail(headers, linkedinAlerts ? 'linkedin.com' : null) || (linkedinAlerts && !isLinkedInSender(headers))) {
        console.warn(`gmail: skipping spoofed/unauthenticated email "${subject}"`);
        processedIds.add(m.id);
        continue;
      }

      if (linkedinAlerts) {
        for (const job of linkedInEmailOffers(msg.payload)) {
          if (!seenUrls.has(job.url)) { seenUrls.add(job.url); jobs.push(job); }
        }
        processedIds.add(m.id);
        continue;
      }

      const seed = parseRoleAtCompany(subject);
      const cleanUrls = extractUrls(getMessageBody(msg.payload)).filter(isCleanUrl);
      for (const url of cleanUrls) {
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        jobs.push({
          title: seed?.role || 'Job lead (email)',
          url,
          company: companyFromUrl(url) || seed?.company || '',
          location: '',
        });
      }
      processedIds.add(m.id);
    }

    // The host calls commit only after both canonical writes succeed. Saving
    // here used to lose messages when appending the pipeline failed afterwards.
    Object.defineProperties(jobs, {
      commit: { value: () => { if (!ctx?.dryRun) saveProcessedIds(processedIds, ctx); } },
      incomplete: { value: failures.length > 0 },
      linkedinAlerts: { value: linkedinAlerts },
    });
    return jobs;
  },
};
