import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync, copyFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import gmail, { linkedInEmailOffers } from '../plugins/gmail/index.mjs';
import { admitPluginJobs } from '../plugins.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const url = id => `https://www.linkedin.com/jobs/view/${id}`;
const payload = text => ({ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') }, headers: [
  { name: 'From', value: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>' },
  { name: 'Subject', value: 'A subject that must not become every title' },
  { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=linkedin.com' },
] });

test('each plaintext job keeps its own metadata; an HTML-only link remains unresolved', () => {
  const body = payload(`Junior Backend Engineer\nAcme\nMadrid, Spain\n${url('1000000001')}\n\nIntern Engineer\nOther Co\nRemote, Europe\n${url('1000000002')}`);
  const jobs = linkedInEmailOffers(body);
  assert.deepEqual(jobs.map(({ title, company, location }) => ({ title, company, location })), [
    { title: 'Junior Backend Engineer', company: 'Acme', location: 'Madrid, Spain' },
    { title: 'Intern Engineer', company: 'Other Co', location: 'Remote, Europe' },
  ]);
  const [unknown] = linkedInEmailOffers({ mimeType: 'text/html', body: { data: Buffer.from(`<a href="https://www.linkedin.com/comm/jobs/view/1000000003?trk=x">View job</a>`).toString('base64url') } });
  assert.equal(unknown.url, url('1000000003'));
  assert.equal(unknown.title, 'Job alert');
  assert.equal(unknown.company, '');
  assert.equal(unknown.location, '');
  assert.match(unknown.note, /metadata incomplete.*JD unavailable.*unconfirmed/);
});

test('authenticated unknown alert fields stay Pending candidates; known rejected fields still fail native filters', () => {
  const found = [
    { url: url('1000000001'), title: 'Job alert', company: '', location: '' },
    { url: url('1000000002'), title: 'Senior Engineer', company: 'Acme', location: 'Madrid, Spain' },
    { url: url('1000000003'), title: 'Junior Engineer', company: 'Acme', location: 'United States' },
    { url: url('1000000004'), title: 'Junior Engineer', company: 'Acme', location: 'Madrid, Spain' },
  ];
  const opts = { id: 'gmail', jobPostings: true, unresolvedLinkedInAlerts: true,
    config: { title_filter: { positive: ['engineer'], negative: ['senior'] }, location_filter: { allow: ['Spain'], block_hard: ['United States'], strict: true } },
    gateOptions: { blacklist: new Map(), seen: new Set() } };
  const result = admitPluginJobs(found, opts);
  assert.deepEqual(result.jobs.map(job => job.url), [url('1000000001'), url('1000000004')]);
  assert.equal(result.counts.title, 1);
  assert.equal(result.counts.location, 1);
  assert.throws(() => admitPluginJobs([{ ...found[0], url: 'https://evil.example/jobs/1' }], opts), /canonical LinkedIn/);
  assert.equal(admitPluginJobs([found[0]], { ...opts, unresolvedLinkedInAlerts: false }).jobs.length, 0);
});

test('cursor acknowledgment is deferred; failed messages replay and preview cannot acknowledge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gmail-deferred-'));
  const cursor = join(root, 'data', 'gmail-state.json');
  try {
    const calls = [];
    const ctx = { dataRoot: root, dryRun: false, log() {}, settings: { linkedin_alerts: true },
      env: { GMAIL_CLIENT_ID: 'fixture', GMAIL_CLIENT_SECRET: 'fixture', GMAIL_REFRESH_TOKEN: 'fixture' },
      fetch: async request => {
        calls.push(request);
        if (request.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'fixture' }) };
        if (request.includes('messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'good' }, { id: 'retry' }] }) };
        if (request.includes('/retry?')) throw new Error('fixture transport failure');
        return { ok: true, json: async () => ({ payload: payload(url('1000000001')) }) };
      } };
    const jobs = await gmail.ingest(ctx);
    assert.equal(jobs.length, 1);
    assert.equal(jobs.incomplete, true);
    assert.equal(existsSync(cursor), false);
    assert.equal(Object.keys(jobs).includes('commit'), false);
    jobs.commit();
    assert.deepEqual(JSON.parse(readFileSync(cursor)).processed_message_ids, ['good']);
    calls.length = 0;
    const preview = await gmail.ingest({ ...ctx, dryRun: true });
    preview.commit();
    assert.ok(calls.some(value => value.includes('/retry?')));
    assert.ok(!calls.some(value => value.includes('/good?')));
    assert.deepEqual(JSON.parse(readFileSync(cursor)).processed_message_ids, ['good']);
    assert.match(decodeURIComponent(calls.find(value => value.includes('messages?'))), /LinkedIn Jobs.*from:jobalerts-noreply/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a spoofed LinkedIn sender cannot enable unresolved-field admission', async () => {
  const body = payload(url('1000000001'));
  body.headers[0].value = 'Attacker <attacker@example.test>';
  const jobs = await gmail.ingest({ settings: { linkedin_alerts: true }, dryRun: true, log() {},
    env: { GMAIL_CLIENT_ID: 'x', GMAIL_CLIENT_SECRET: 'x', GMAIL_REFRESH_TOKEN: 'x' },
    fetch: async request => ({ ok: true, json: async () => request.includes('oauth2') ? { access_token: 'fixture' } : request.includes('messages?') ? { messages: [{ id: 'spoof' }] } : { payload: body } }) });
  assert.equal(jobs.length, 0);
});

test('an invalid refresh grant gives a reconnect instruction without leaking the server response', async () => {
  await assert.rejects(() => gmail.ingest({ settings: {}, env: { GMAIL_CLIENT_ID: 'x', GMAIL_CLIENT_SECRET: 'x', GMAIL_REFRESH_TOKEN: 'x' },
    fetch: async () => { throw new Error('HTTP400 invalid_grant secret-response'); } }), err => {
    assert.match(err.message, /expired or was revoked.*gmail-oauth/);
    assert.doesNotMatch(err.message, /secret-response/);
    return true;
  });
});

test('real Gmail CLI previews do not acknowledge, committed imports deduplicate, and write failures retain messages', () => {
  const root = mkdtempSync(join(tmpdir(), 'gmail-cli-'));
  try {
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'config/plugins.yml'), 'plugins:\n  gmail:\n    enabled: true\n    label: LinkedIn Jobs\n    linkedin_alerts: true\n');
    writeFileSync(join(root, 'portals.yml'), 'title_filter:\n  positive: [engineer]\nlocation_filter:\n  strict: true\n  allow: [Spain]\n');
    writeFileSync(join(root, 'data/pipeline.md'), '# Pipeline\n\n## Pending\n\n## Processed\n');
    const stub = join(root, 'fetch-stub.mjs');
    writeFileSync(stub, `import dns from 'node:dns/promises'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; dns.lookup=async()=>[{address:'93.184.216.34',family:4}]; const append=fs.appendFileSync; fs.appendFileSync=(path,...args)=>{if(process.env.FAIL_HISTORY==='1'&&String(path).endsWith('scan-history.tsv'))throw new Error('fixture history failure');return append(path,...args);}; syncBuiltinESMExports();\nglobalThis.fetch=async raw=>{const u=String(raw);if(process.env.SLOW_MESSAGES==='1'&&!u.includes('oauth2')&&!u.includes('messages?'))await new Promise(resolve=>setTimeout(resolve,6000));let data;if(u.includes('oauth2'))data={access_token:'fixture'};else if(u.includes('messages?'))data={messages:process.env.SLOW_MESSAGES==='1'?[{id:'message1'},{id:'message2'},{id:'message3'}]:[{id:'message1'}]};else data={payload:${JSON.stringify(payload(url('1000000001')))}};return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});};\n`);
    // The engine writes its trust lock beside code, independently of DATA_ROOT.
    // Copy this CLI and Gmail seed so every such write remains in the fixture.
    const codeRoot = join(root, 'code');
    mkdirSync(join(codeRoot, 'plugins'), { recursive: true });
    for (const entry of readdirSync(ROOT)) {
      if (entry === 'plugins' || entry === '.git' || entry === 'plugins.lock') continue;
      if (entry === 'plugins.mjs') copyFileSync(join(ROOT, entry), join(codeRoot, entry));
      else symlinkSync(join(ROOT, entry), join(codeRoot, entry));
    }
    for (const entry of readdirSync(join(ROOT, 'plugins'))) {
      if (entry === 'gmail') cpSync(join(ROOT, 'plugins/gmail'), join(codeRoot, 'plugins/gmail'), { recursive: true });
      else symlinkSync(join(ROOT, 'plugins', entry), join(codeRoot, 'plugins', entry));
    }
    let failHistory = false;
    let slowMessages = false;
    const run = (...args) => spawnSync(process.execPath, ['--import', stub, join(codeRoot, 'plugins.mjs'), 'run', 'gmail', ...args], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, SLOW_MESSAGES: slowMessages ? '1' : '', FAIL_HISTORY: failHistory ? '1' : '', CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PIPELINE: '', CAREER_OPS_TRACKER: '', CAREER_OPS_SCAN_HISTORY: '', GMAIL_CLIENT_ID: 'fixture', GMAIL_CLIENT_SECRET: 'fixture', GMAIL_REFRESH_TOKEN: 'fixture' },
    });
    const cursor = join(root, 'data/gmail-state.json');
    const preview = run('--dry-run');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /"dry_run":true/);
    assert.equal(existsSync(cursor), false);
    slowMessages = true;
    const slowPreview = run('--dry-run');
    assert.equal(slowPreview.status, 0, slowPreview.stderr);
    assert.match(slowPreview.stdout, /"coverage_complete":true/);
    assert.equal(existsSync(cursor), false, 'a legitimate Gmail preview longer than 15s must complete without acknowledging');
    slowMessages = false;
    failHistory = true;
    assert.notEqual(run().status, 0);
    assert.equal(existsSync(cursor), false, 'failed history append must leave the email unacknowledged');
    assert.match(readFileSync(join(root, 'data/pipeline.md'), 'utf8'), /1000000001/);
    failHistory = false;
    const imported = run();
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stdout, /"coverage_complete":true/);
    const pipeline = readFileSync(join(root, 'data/pipeline.md'), 'utf8');
    assert.match(pipeline, /Job alert.*metadata incomplete.*JD unavailable.*unconfirmed/);
    assert.match(readFileSync(join(root, 'data/scan-history.tsv'), 'utf8'), /1000000001/, 'retry repairs history before acknowledging the email');
    assert.equal(run().status, 0);
    assert.equal(readFileSync(join(root, 'data/pipeline.md'), 'utf8'), pipeline);
    rmSync(cursor);
    rmSync(join(root, 'data/pipeline.md'));
    mkdirSync(join(root, 'data/pipeline.md'));
    assert.notEqual(run().status, 0);
    assert.equal(existsSync(cursor), false, 'failed canonical write must never acknowledge Gmail messages');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('Gmail budget returns completed messages and leaves the rest unacknowledged', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gmail-budget-'));
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  try {
    const jobs = await gmail.ingest({ dataRoot: root, settings: { linkedin_alerts: true }, log() {},
      env: { GMAIL_CLIENT_ID: 'fixture', GMAIL_CLIENT_SECRET: 'fixture', GMAIL_REFRESH_TOKEN: 'fixture' },
      fetch: async (request, opts) => {
        calls.push(request);
        assert.ok(opts.signal instanceof AbortSignal);
        assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= 10_000);
        if (request.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'fixture' }) };
        if (request.includes('messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'done' }, { id: 'unread' }] }) };
        now = 100_001;
        return { ok: true, json: async () => ({ payload: payload(url('1000000001')) }) };
      } });
    assert.equal(jobs.length, 1);
    assert.equal(jobs.incomplete, true);
    assert.ok(!calls.some(request => request.includes('/unread?')));
    jobs.commit();
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'data/gmail-state.json'))).processed_message_ids, ['done']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gmail aborts an in-flight message at its deadline and starts no later reads', async (t) => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', () => timeout(25));
  const calls = [];
  const jobs = await gmail.ingest({ settings: { linkedin_alerts: true }, dryRun: true, log() {},
    env: { GMAIL_CLIENT_ID: 'fixture', GMAIL_CLIENT_SECRET: 'fixture', GMAIL_REFRESH_TOKEN: 'fixture' },
    fetch: async (request, opts) => {
      calls.push(request);
      if (request.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'fixture' }) };
      if (request.includes('messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'done' }, { id: 'slow' }, { id: 'later' }] }) };
      if (request.includes('/slow?')) return { ok: true, json: () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ payload: payload(url('1000000002')) }), 1000);
        opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(opts.signal.reason); }, { once: true });
      }) };
      return { ok: true, json: async () => ({ payload: payload(url('1000000001')) }) };
    } });
  assert.equal(jobs.length, 1);
  assert.equal(jobs.incomplete, true);
  assert.ok(!calls.some(request => request.includes('/later?')));
});

test('Gmail preserves listed messages when a later listing page fails', async () => {
  const jobs = await gmail.ingest({ settings: { linkedin_alerts: true }, dryRun: true, log() {},
    env: { GMAIL_CLIENT_ID: 'fixture', GMAIL_CLIENT_SECRET: 'fixture', GMAIL_REFRESH_TOKEN: 'fixture' },
    fetch: async request => {
      if (request.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'fixture' }) };
      if (request.includes('pageToken=')) throw new Error('fixture listing failure');
      if (request.includes('messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'done' }], nextPageToken: 'next' }) };
      return { ok: true, json: async () => ({ payload: payload(url('1000000001')) }) };
    } });
  assert.equal(jobs.length, 1);
  assert.equal(jobs.incomplete, true);
});
