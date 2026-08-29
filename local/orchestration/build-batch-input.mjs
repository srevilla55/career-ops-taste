#!/usr/bin/env node
/**
 * build-batch-input.mjs — promote triage survivors into batch/batch-input.tsv.
 *
 * Selection is threshold-first, with a cap as a budget guard behind it.
 *
 * The threshold does the cutting because it cuts on quality: measured over the first 226
 * triaged roles, a 3.5 bar passes 25% (~139 of 553), and 31 of those 57 passes bunch in
 * the 3.6-3.9 band right above the bar. A "top 100" cap on that distribution lands at
 * ~3.7 and removes almost nothing — it looks like a control while barely being one.
 * Raising the bar to 4.0 is what actually halves the work.
 *
 * The cap still exists, because a good scan day should not be able to turn into an
 * unbounded bill. Nothing capped is discarded: every role keeps its score in
 * data/triage-verdicts.tsv, so lowering --min-score on a later run picks up exactly the
 * roles this run deferred, with no re-triage.
 *
 * The url column is deliberately the **pipeline's own token** (`local:jds/...` for JobSpy
 * rows, the real URL for scanner rows) — that is the string reconcile-pipeline.mjs matches
 * on when it moves processed offers out of the inbox. Workers resolve it to a JD file
 * through data/jd-index.tsv (modes/_custom.md § JD resolution).
 *
 * Idempotent: existing ids are preserved, new survivors are appended. Re-run after every
 * triage pass.
 *
 *   node local/orchestration/build-batch-input.mjs [--min-score N] [--include-marginal]
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERDICTS = path.join(ROOT, 'data/triage-verdicts.tsv');
const INPUT = path.join(ROOT, 'batch/batch-input.tsv');
const EVAL_WAVE = path.join(ROOT, 'batch/.eval-wave');
const HEADER = 'id\turl\tsource\tnotes';

/**
 * Collapse the same opening posted twice.
 *
 * Liferay reached the queue as both "Liferay" and "LIFERAY, INC." for one Associate
 * Software Engineer role, so ingest deduped neither, and both got a full evaluation —
 * roughly a million tokens to score the same job twice (3.2 and 3.7). Normalising away
 * corporate suffixes and punctuation catches that class before it costs anything.
 *
 * Deliberately conservative: it keys on company AND title, so two genuinely different
 * openings at one company survive, and it keeps the higher-scoring row (already sorted
 * first) so the better read of an ambiguous pair is the one that gets evaluated.
 */
const normKey = (company, role) => {
  const norm = s => (s || '')
    .toLowerCase()
    .replace(/\b(inc|s\.?l\.?u?|s\.?a\.?|gmbh|ltd|llc|bv|nv|ag|corp|corporation|group|iberia)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${norm(company)}|${norm(role)}`;
};

export function dedupeRoles(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const k = normKey(r.company, r.role);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Rows worth a full evaluation, best first. */
export function selectSurvivors(tsv, { minScore, includeMarginal }) {
  const [head, ...lines] = tsv.split('\n').filter(Boolean);
  const cols = head.split('\t');
  const idx = name => cols.indexOf(name);
  return dedupeRoles(lines
    .map(l => {
      const c = l.split('\t');
      return {
        token: c[idx('token')], verdict: c[idx('verdict')], score: Number(c[idx('score')]),
        company: c[idx('company')], role: c[idx('role')], prio: Number(c[idx('prio')]),
        jd: c[idx('jd')],
      };
    })
    .filter(r => (r.verdict === 'PASS' || (includeMarginal && r.verdict === 'MARGINAL'))
      && r.score >= minScore)
    .sort((a, b) => b.score - a.score || b.prio - a.prio));
}

function main(argv) {
  const arg = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };
  const cfg = yaml.load(readFileSync(path.join(ROOT, 'config/profile.yml'), 'utf-8')) || {};
  const minScore = Number(arg('--min-score', cfg?.pipeline?.eval_min_score ?? 4.0));
  const max = Number(arg('--max', cfg?.pipeline?.eval_max ?? 100));
  const includeMarginal = argv.includes('--include-marginal');
  // Raising the bar has to apply to what is already queued, or the change silently only
  // affects future rows. --prune drops still-pending offers that no longer qualify;
  // anything a worker already finished is kept, because its cost is already spent.
  const prune = argv.includes('--prune');

  if (!existsSync(VERDICTS)) { console.error('No data/triage-verdicts.tsv — run triage-all.mjs first.'); process.exit(1); }
  const all = selectSurvivors(readFileSync(VERDICTS, 'utf-8'), { minScore, includeMarginal });
  const survivors = max > 0 ? all.slice(0, max) : all;
  const deferred = all.length - survivors.length;

  const terminal = new Set();
  const STATE = path.join(ROOT, 'batch/batch-state.tsv');
  if (existsSync(STATE)) {
    for (const line of readFileSync(STATE, 'utf-8').split('\n')) {
      if (!line.trim() || line.startsWith('id\t')) continue;
      const c = line.split('\t');
      if (c[2] === 'completed' || c[2] === 'skipped') terminal.add(c[1]);
    }
  }

  const keep = new Set(survivors.map(s => s.token));
  const existing = new Map();
  let maxId = 0;
  let pruned = 0;
  if (existsSync(INPUT)) {
    for (const line of readFileSync(INPUT, 'utf-8').split('\n')) {
      if (!line.trim() || line.startsWith('id\t')) continue;
      const c = line.split('\t');
      maxId = Math.max(maxId, Number(c[0]) || 0);
      if (prune && !keep.has(c[1]) && !terminal.has(c[1])) { pruned++; continue; }
      existing.set(c[1], line);
    }
  }

  const out = [...existing.values()];
  const wave = [];
  let added = 0;
  for (const s of survivors) {
    if (existing.has(s.token)) continue;
    out.push([++maxId, s.token, 'triage', `${s.verdict} ${s.score}/5 — ${s.company} — jd:${s.jd}`].join('\t'));
    wave.push(s.token);
    added++;
  }
  writeFileSync(INPUT, [HEADER, ...out].join('\n') + '\n', 'utf-8');
  if (added > 0) {
    writeFileSync(EVAL_WAVE, wave.join('\n') + '\n', 'utf-8');
    console.log(`  evaluation wave: ${added} new offer(s), released in four quarters`);
  }
  if (pruned) console.log(`  pruned ${pruned} queued offer(s) that no longer clear the bar (completed work kept)`);
  console.log(`batch-input: ${out.length} offer(s) total (${added} new) · score ≥ ${minScore}${includeMarginal ? ' incl. MARGINAL' : ''} · cap ${max || 'none'}`);
  if (deferred > 0) {
    const lowest = survivors[survivors.length - 1];
    console.log(`  ${deferred} qualifying role(s) deferred by the cap (all scored below ${lowest.score}). Not lost — re-run with a higher --max to pick them up.`);
  }
}

function demo() {
  const tsv = [
    'token\tverdict\tscore\tcompany\trole\tprio\tjd\treason',
    'local:a.md\tPASS\t4.3\tAcme\tBackend\t0.90\tjds/a.md\tgood',
    'https://b\tFAIL\t2.0\tGlobex\tStaff\t0.80\tjds/b.md\tdq',
    'local:c.md\tMARGINAL\t3.4\tInitech\tFS\t0.85\tjds/c.md\tmeh',
    'local:d.md\tPASS\t4.9\tDatadog\tSWE\t0.70\tjds/d.md\tgreat',
  ].join('\n');

  const pass = selectSurvivors(tsv, { minScore: 3.5, includeMarginal: false });
  assert.deepEqual(pass.map(r => r.token), ['local:d.md', 'local:a.md'], 'PASS only, best first');

  const withMarginal = selectSurvivors(tsv, { minScore: 3.0, includeMarginal: true });
  assert.equal(withMarginal.length, 3, 'MARGINAL joins when asked and it clears minScore');

  // A PASS verdict below the bar is still excluded — the score is the gate, not the label.
  assert.equal(selectSurvivors(tsv, { minScore: 4.5, includeMarginal: false }).length, 1);

  // The cap takes from the top, so a capped run is the best N and never an arbitrary N.
  assert.deepEqual(pass.slice(0, 1).map(r => r.company), ['Datadog']);
  // The real Liferay case: one opening, two postings, two full evaluations.
  const dupTsv = [
    'token\tverdict\tscore\tcompany\trole\tprio\tjd\treason',
    'local:x.md\tPASS\t4.1\tLiferay\tAssociate Software Engineer\t0.8\tjds/x.md\tok',
    'local:y.md\tPASS\t4.1\tLIFERAY, INC.\tAssociate Software Engineer\t0.8\tjds/y.md\tok',
    'local:z.md\tPASS\t4.2\tLiferay\tSenior Data Engineer\t0.8\tjds/z.md\tok',
  ].join('\n');
  const dd = selectSurvivors(dupTsv, { minScore: 4.0, includeMarginal: false });
  assert.equal(dd.length, 2, 'the duplicated posting collapses, the distinct role survives');
  assert.ok(dd.some(r => /Senior Data/.test(r.role)), 'a different title at the same company is kept');

  console.log('build-batch-input self-check: all assertions passed');
}

// Compare REAL paths: node resolves symlinks for import.meta.url but not for
// process.argv[1], so under the symlinked worker root the naive form never matches
// and the script silently exits 0 without running. That made triage a no-op.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--demo')) demo();
  else main(process.argv.slice(2));
}
