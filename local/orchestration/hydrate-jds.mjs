#!/usr/bin/env node
/**
 * hydrate-jds.mjs — give every pending pipeline row a local JD file, and index it.
 *
 * Two jobs, one Playwright pass:
 *
 *   1. JD hydration. JobSpy rows already carry their JD on disk (`local:jds/jobspy/*.md`).
 *      The native scanner's rows carry only a URL, so a batch worker would have to
 *      WebFetch each one at evaluation time — expensive, and it fails outright behind a
 *      login wall. browser-extract.mjs reads them once, headlessly, for zero tokens.
 *
 *   2. Liveness. A posting that yields no JD text is closed. That is the same verdict
 *      check-liveness.mjs returns, arrived at by the fetch we were doing anyway, so the
 *      queue never pays for two Playwright sweeps (modes/pipeline.md § Liveness sweep).
 *
 * LinkedIn/Indeed/Glassdoor rows are skipped on purpose: they are login-walled, so their
 * liveness signal is noise, and their JD is already local.
 *
 * Output: jds/scanner/{slug}.md + data/jd-index.tsv (`{pipeline-token}\t{path}`), which
 * modes/_custom.md § JD resolution tells every worker to consult before fetching.
 *
 *   node local/orchestration/hydrate-jds.mjs [--concurrency N] [--unscored-only] [--dry-run] [--demo]
 */

import { isMainModule } from '../../lib/is-main-module.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

import { chromium } from 'playwright';

import { renderJd, jobSlug, jdLanguage } from '../ingest-jobspy.mjs';
import { withPipelineLock } from '../../pipeline-lock.mjs';
import { LIVENESS_CONTEXT_OPTIONS } from '../../liveness-browser.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PIPELINE = path.join(ROOT, 'data/pipeline.md');
const INDEX = path.join(ROOT, 'data/jd-index.tsv');
const JD_DIR = path.join(ROOT, 'jds/scanner');

// browser-extract caps jd text at 12k chars by default. A truncated tail costs a
// requirements list, which is exactly what triage scores on — so pay for the whole page.
const MAX_CHARS = 20_000;
const EXTRACT_TIMEOUT_MS = 45_000;
// Below this, the page rendered but has no posting on it: a careers-page redirect or an
// expired stub. Real JDs are far longer; the shortest in the existing queue is ~900 chars.
const MIN_JD_CHARS = 400;

/**
 * Parse one `- [ ]` pipeline row into the fields the hydrator needs.
 *
 * Columns are positional but variable-width (1, 3, 4 or 5 cells), and labeled segments
 * (`posted:`, `trust:`, `note:`) ride on any shape — so a cell is only a location if it
 * is in slot 3 AND carries no label. Returns null for anything that is not a pending row.
 */
export function parseRow(line) {
  if (!line.startsWith('- [ ] ')) return null;
  const cols = line.slice(6).split('|').map(s => s.trim());
  const labeled = c => /^(posted|trust|note):/.test(c);
  const note = cols.find(c => c.startsWith('note:')) || '';
  const posted = (cols.find(c => c.startsWith('posted:')) || '').replace('posted:', '').trim();
  return {
    line,
    token: cols[0] || '',
    company: cols[1] || 'Unknown',
    title: cols[2] || '',
    location: cols[3] && !labeled(cols[3]) ? cols[3] : '',
    posted,
    // JobSpy rows keep the real posting URL in the note; scanner rows put it in slot 0.
    url: (note.match(/\burl:(\S+)/) || [])[1] || cols[0] || '',
  };
}

/** A `local:` token already points at its JD file; anything else has to be fetched. */
export function indexPathFor(token) {
  return token.startsWith('local:') ? token.slice('local:'.length) : null;
}

// Retain uncertainty outside this run; replace outcomes only for selected tokens.
function mergeUncertainRows(previous, selectedTokens, uncertain) {
  const selected = new Set(selectedTokens);
  const rows = new Map(previous.split(/\r?\n/).filter(Boolean)
    .map(line => [line.split('\t')[0], line]).filter(([token]) => !selected.has(token)));
  for (const row of uncertain) {
    const cells = [row.token, row.company, row.title, row.why]
      .map(value => String(value ?? '').replace(/[\t\r\n]+/g, ' '));
    rows.set(row.token, cells.join('\t'));
  }
  return rows.size ? [...rows.values()].join('\n') + '\n' : '';
}

async function extract(url) {
  const { stdout } = await execFileAsync(
    'node',
    [path.join(ROOT, 'browser-extract.mjs'), url, '--mode', 'jd',
      '--max-chars', String(MAX_CHARS), '--timeout', String(EXTRACT_TIMEOUT_MS)],
    { cwd: ROOT, timeout: EXTRACT_TIMEOUT_MS + 20_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const out = JSON.parse(stdout);
  if (out.error) throw new Error(out.error);
  return out;
}

/**
 * Second rung: read the page's whole body text in one shared browser.
 *
 * browser-extract prefers `main, [role=main], article` over `<body>`, which is right
 * almost everywhere and wrong on sites that ship a decoy container. welcometothejungle
 * serves a 66-character <article> teaser while the real 14,243-character posting sits in
 * the body — measured, not guessed. Preferring the smaller container there throws the JD
 * away and, if absence of text is read as absence of posting, marks a live role expired.
 *
 * So: when rung 1 comes back short, re-read the body directly. Same page, no selector
 * opinion. One browser for the whole batch, because launching chromium per URL is what
 * makes rung 1 slow.
 */
async function readBodies(rows, log) {
  const results = new Map();
  if (!rows.length) return results;
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
    for (const [i, row] of rows.entries()) {
      const page = await ctx.newPage();
      try {
        await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: EXTRACT_TIMEOUT_MS });
        await page.waitForTimeout(2500);
        // page.evaluate runs in the browser: Node's constants are not in scope there.
        const got = await page.evaluate((cap) => {
          const body = document.body?.cloneNode(true);
          if (!body) return { title: '', text: '' };
          body.querySelectorAll('script,style,nav,header,footer,noscript').forEach(e => e.remove());
          return {
            title: (document.querySelector('h1')?.innerText || document.title || '').trim(),
            text: (body.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, cap),
          };
        }, MAX_CHARS);
        results.set(row.token, got);
        log(`  [rung2 ${i + 1}/${rows.length}] ${got.text.length >= MIN_JD_CHARS ? '✓' : '·'} ${row.company} — ${got.text.length} chars`);
      } catch (err) {
        results.set(row.token, { title: '', text: '', error: String(err.message).slice(0, 90) });
        log(`  [rung2 ${i + 1}/${rows.length}] ✗ ${row.company} — ${String(err.message).slice(0, 70)}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return results;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function pooled(items, limit, worker) {
  const queue = [...items.entries()];
  const results = new Array(items.length);
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [i, item] = next;
      results[i] = await worker(item, i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('Usage: node local/orchestration/hydrate-jds.mjs [options]');
    return;
  }

  const arg = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i === -1 ? dflt : argv[i + 1];
  };
  const concurrency = Number(arg('--concurrency', 4));
  const dryRun = argv.includes('--dry-run');
  const unscoredOnly = argv.includes('--unscored-only');

  const text = readFileSync(PIPELINE, 'utf-8');
  const pendingRows = text.split('\n').map(parseRow).filter(Boolean);
  const scored = new Set(existsSync(path.join(ROOT, 'data/triage-verdicts.tsv'))
    ? readFileSync(path.join(ROOT, 'data/triage-verdicts.tsv'), 'utf-8').split('\n').map(line => line.split('\t')[0]).filter(Boolean)
    : []);
  const uncertainTokens = new Set(existsSync(path.join(ROOT, 'data/jd-uncertain.tsv'))
    ? readFileSync(path.join(ROOT, 'data/jd-uncertain.tsv'), 'utf-8').split('\n').map(line => line.split('\t')[0]).filter(Boolean)
    : []);
  const rows = unscoredOnly
    ? pendingRows.filter(row => !scored.has(row.token) && !uncertainTokens.has(row.token))
    : pendingRows;

  const priorIndex = new Map(existsSync(INDEX)
    ? readFileSync(INDEX, 'utf-8').split('\n').filter(Boolean).map(line => line.split('\t'))
    : []);
  // A scoped run must retain mappings for roles outside its selection.
  const index = new Map(unscoredOnly ? priorIndex : []);
  const needFetch = [];
  for (const row of rows) {
    const local = indexPathFor(row.token) || priorIndex.get(row.token);
    if (local && existsSync(path.join(ROOT, local))) {
      index.set(row.token, local);
      // The real URL resolves to the same file, so a worker handed either one finds it.
      if (row.url && row.url !== row.token) index.set(row.url, local);
    } else {
      needFetch.push(row);
    }
  }

  console.log(`pending ${pendingRows.length} · selected ${rows.length}${unscoredOnly ? ' unscored' : ''} · already local ${rows.length - needFetch.length} · to fetch ${needFetch.length}`);
  if (dryRun) { console.log('--dry-run: stopping before any fetch or write.'); return; }

  mkdirSync(JD_DIR, { recursive: true });

  const writeJd = (row, description) => {
    const offer = {
      url: row.url,
      title: row.title || 'Unknown role',
      company: row.company,
      location: row.location,
      salary: undefined,
      postedAt: row.posted ? Date.parse(row.posted) : undefined,
      description,
      source: 'career-ops:scanner',
      jobType: '',
      jobLevel: '',
      emails: [],
    };
    const file = path.join('jds/scanner', `${jobSlug(offer)}.md`);
    writeFileSync(path.join(ROOT, file), renderJd(offer, jdLanguage(description)), 'utf-8');
    index.set(row.token, file);
    index.set(row.url, file);
    return file;
  };

  // jobSlug is deterministic in url+company+title, so a JD written by an earlier run is
  // findable without re-fetching. Makes a re-run after an interruption nearly free.
  const cachedFile = (row) => {
    const file = path.join('jds/scanner', `${jobSlug({ url: row.url, company: row.company, title: row.title || 'Unknown role' })}.md`);
    return existsSync(path.join(ROOT, file)) ? file : null;
  };

  // ── Rung 1: browser-extract (compact, selector-driven) ────────────────────
  let live = 0;
  let cached = 0;
  const short = [];
  await pooled(needFetch, concurrency, async (row, i) => {
    const hit = cachedFile(row);
    if (hit) {
      cached++;
      index.set(row.token, hit);
      index.set(row.url, hit);
      return;
    }
    let out;
    try {
      out = await extract(row.url);
    } catch (err) {
      short.push({ ...row, rung1: '', rung1Title: '', rung1Error: String(err.message).slice(0, 120) });
      console.log(`  [${i + 1}/${needFetch.length}] · ${row.company} — rung1 error, deferring`);
      return;
    }
    const description = (out.text || '').trim();
    if (description.length < MIN_JD_CHARS) {
      short.push({ ...row, rung1: description, rung1Title: (out.title || '').trim(), rung1Error: '' });
      console.log(`  [${i + 1}/${needFetch.length}] · ${row.company} — ${description.length} chars, deferring to rung 2`);
      return;
    }
    live++;
    console.log(`  [${i + 1}/${needFetch.length}] ✓ ${row.company} — ${description.length} chars → ${writeJd(row, description)}`);
  });

  // ── Rung 2: whole-body read for everything rung 1 came back short on ──────
  if (short.length) console.log(`\nrung 2: re-reading ${short.length} page(s) whose main container came back short`);
  const bodies = await readBodies(short, m => console.log(m));

  // ── Classify. Absence of text is NOT absence of posting. ──────────────────
  // Expiry needs a positive signal: the page produced no body text AND no title, i.e. it
  // did not render a posting at all. A page that still serves a real <h1>/<title> is live
  // but unreadable by these two rungs — modes/pipeline.md § Liveness sweep says leave
  // `uncertain` in place and confirm during normal extraction, never drop it.
  const expired = [];
  const uncertain = [];
  for (const row of short) {
    const got = bodies.get(row.token) || { title: '', text: '' };
    const description = (got.text || '').trim();
    if (description.length >= MIN_JD_CHARS) {
      live++;
      console.log(`  ✓ ${row.company} — recovered ${description.length} chars → ${writeJd(row, description)}`);
      continue;
    }
    const title = (got.title || row.rung1Title || '').trim();
    const failedToLoad = Boolean(got.error);
    if (title) {
      uncertain.push({ ...row, why: `page renders (title: "${title.slice(0, 60)}") but no readable JD body` });
    } else if (failedToLoad) {
      // A navigation error or timeout means we never got to look. That is the transient
      // case modes/pipeline.md § Liveness sweep explicitly says to leave in place — a
      // 45s timeout on a slow Workday tenant is not evidence the role was filled.
      uncertain.push({ ...row, why: `could not load: ${got.error}` });
    } else {
      expired.push({ ...row, why: 'page loaded, rendered no title and no body text — served no posting' });
    }
  }

  const lines = [...index.entries()].map(([k, v]) => `${k}\t${v}`).sort();
  writeFileSync(INDEX, lines.join('\n') + '\n', 'utf-8');

  // Only rows with a positive expiry signal reach here; uncertain rows stay pending.
  if (expired.length) {
    await withPipelineLock(PIPELINE, async () => {
      let current = readFileSync(PIPELINE, 'utf-8');
      const closed = [];
      for (const row of expired) {
        if (!current.includes(row.line)) continue;
        current = current.replace(`${row.line}\n`, '');
        closed.push(`- [x] ~~${row.token} | ${row.company} | ${row.title}~~ — posting expired (liveness sweep: ${row.why})`);
      }
      if (closed.length) {
        current = current.replace(/(^## Processed\s*\n)/m, `$1\n${closed.join('\n')}\n`);
        writeFileSync(PIPELINE, current, 'utf-8');
      }
      console.log(`\nmoved ${closed.length} expired posting(s) to Processed`);
    });
  }

  const uncertainFile = path.join(ROOT, 'data/jd-uncertain.tsv');
  if (uncertain.length || existsSync(uncertainFile)) {
    const previous = existsSync(uncertainFile) ? readFileSync(uncertainFile, 'utf-8') : '';
    const merged = mergeUncertainRows(previous, rows.map(row => row.token), uncertain);
    if (merged !== previous) writeFileSync(uncertainFile, merged, 'utf-8');
  }
  if (uncertain.length) {
    console.log(`${uncertain.length} posting(s) left pending as uncertain → data/jd-uncertain.tsv (live, but unreadable headlessly)`);
  }
  console.log(`\nhydrated ${live} (${cached} reused from a previous run) · uncertain ${uncertain.length} · expired ${expired.length} · index ${index.size} entries → data/jd-index.tsv`);
}

function demo() {
  const row = parseRow('- [ ] https://x.com/j/1 | Acme | Backend Engineer | Madrid, Spain | posted: 2026-08-14 | note: prio 0.9 src:linkedin url:https://real/1');
  assert.equal(row.token, 'https://x.com/j/1');
  assert.equal(row.company, 'Acme');
  assert.equal(row.location, 'Madrid, Spain');
  assert.equal(row.posted, '2026-08-14');
  assert.equal(row.url, 'https://real/1', 'note url: wins over slot 0');

  // 3-column row: slot 3 is absent, so there is no location to invent.
  assert.equal(parseRow('- [ ] https://x.com/j/2 | Acme | Dev').location, '');
  // A labeled segment sitting in slot 3 is not a location (the 4-column trap).
  assert.equal(parseRow('- [ ] https://x.com/j/3 | Acme | Dev | posted: 2026-08-01').location, '');
  // Bare URL, the rawest hand-pasted shape.
  assert.equal(parseRow('- [ ] https://x.com/j/4').url, 'https://x.com/j/4');
  assert.equal(parseRow('- [x] #1 | done'), null);
  assert.equal(parseRow('## Pending'), null);

  assert.equal(indexPathFor('local:jds/jobspy/a.md'), 'jds/jobspy/a.md');
  assert.equal(indexPathFor('https://x.com/j/1'), null);

  const prior = 'old\tAcme\tDev\tTLS unresolved\n';
  const unreadable = { token: 'new', company: 'Other', title: 'Dev', why: 'login\nwall' };
  assert.equal(mergeUncertainRows(prior, ['new'], [unreadable]),
    prior + 'new\tOther\tDev\tlogin wall\n', 'a scoped hydration retains earlier uncertainty');
  assert.equal(mergeUncertainRows(prior, ['new'], []), prior, 'a successful scoped hydration retains untouched uncertainty');
  assert.equal(mergeUncertainRows(prior, ['old'], []), '', 'an explicitly retried resolved token leaves uncertainty');
  assert.equal(mergeUncertainRows(prior, ['old'], [{ ...unreadable, token: 'old' }]),
    'old\tOther\tDev\tlogin wall\n', 'a retried uncertain token is updated once');

  console.log('hydrate-jds self-check: all assertions passed');
}

// Entry check first: triage-all.mjs imports parseRow from here, and a bare argv check
// would fire this module's demo during that import.
// The shared guard handles imports, direct execution and symlinked worker roots.
if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--demo')) demo();
  else main(process.argv.slice(2));
}
