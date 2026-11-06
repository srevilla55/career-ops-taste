#!/usr/bin/env node
/**
 * resume-batch-state.mjs — make a batch queue safe to restart.
 *
 * A worker writes its report, then the runner marks its row `completed`. Kill the run
 * between those two steps — which is exactly what a quota pause or a manual stop does —
 * and the row is left `processing` with a finished report already on disk.
 *
 * The obvious restart ("reset everything non-terminal to pending") then re-evaluates that
 * offer from scratch: a second full evaluation, a second report number, and two report
 * files for one role. That happened once here — reports 008 and 009 were the same WE ARE
 * ARKIA role, same score, ~1M tokens spent to learn nothing.
 *
 * So: before resetting a row, look at the report number it was already given. If a real
 * report exists for that number, the work is done — mark it `completed` and keep it.
 * Only rows with no finished report go back to `pending`.
 *
 * Idempotent, and safe to run whenever a run is stopped.
 *
 *   node local/orchestration/resume-batch-state.mjs [--dry-run]
 */

import { isMainModule } from '../../lib/is-main-module.mjs';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATE = path.join(ROOT, 'batch/batch-state.tsv');
const REPORTS = path.join(ROOT, 'reports');
const WORKER_ARG_MARKER = '.resolved-prompt-';
const WORKER_PATTERN = `[.]${WORKER_ARG_MARKER.slice(1)}`;

/** True only for a batch worker argv, including one orphaned after its runner died. */
export function isBatchWorkerArgv(argv) {
  return argv.includes(WORKER_ARG_MARKER);
}

/** Report numbers that have a real (non-sentinel) report file on disk. */
export function finishedReports(files) {
  const out = new Set();
  for (const f of files) {
    const m = /^(\d{3})-(.+)\.md$/.exec(f);
    if (m && m[2] !== 'RESERVED') out.add(m[1]);
  }
  return out;
}

function reportScore(text) {
  const match = /^\*\*Score:\*\*\s*([\d.]+)\s*\/\s*5/m.exec(text);
  const score = match ? Number(match[1]) : NaN;
  return Number.isFinite(score) && score >= 0 && score <= 5 ? String(score) : '-';
}

/**
 * Decide what each non-terminal row should become.
 *
 * `completed` / `skipped` are never touched — their cost is already spent either way.
 */
export function planResume(rows, done) {
  return rows.map(r => {
    if (r.status === 'completed' || r.status === 'skipped') return { ...r, next: r.status };
    const num = (r.report || '').trim();
    if (num && done.has(num)) return { ...r, next: 'completed', rescued: true };
    return { ...r, next: 'pending' };
  });
}

function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('Usage: node local/orchestration/resume-batch-state.mjs [options]');
    return;
  }

  const dry = argv.includes('--dry-run');
  if (!existsSync(STATE)) { console.log('no batch/batch-state.tsv — nothing to do'); return; }

  // A live worker's row is legitimately `processing`. Rewriting it mid-flight would hand
  // the same offer to a second worker and re-create the duplicate this script exists to
  // prevent, so refuse rather than guess.
  if (!dry && !argv.includes('--force')) {
    const alive = spawnSync('pgrep', ['-f', WORKER_PATTERN]).stdout?.toString().trim();
    if (alive) {
      console.error(`refusing: ${alive.split('\n').length} worker(s) still running. Stop the run first, or pass --force.`);
      process.exit(1);
    }
  }

  const lines = readFileSync(STATE, 'utf-8').split('\n');
  const done = finishedReports(readdirSync(REPORTS));

  const parsed = [];
  const out = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('id\t')) { out.push({ raw: line }); continue; }
    const c = line.split('\t');
    parsed.push({ raw: line, cols: c, id: c[0], status: c[2], report: c[5] });
    out.push({ raw: line, idx: parsed.length - 1 });
  }

  const plan = planResume(parsed, done);
  let rescued = 0, reset = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    if (p.next === p.status) continue;
    if (p.rescued) {
      rescued++;
      const file = readdirSync(REPORTS).find(f => f.startsWith(`${p.report}-`) && f.endsWith('.md') && !f.endsWith('-RESERVED.md'));
      p.cols[6] = reportScore(readFileSync(path.join(REPORTS, file), 'utf-8'));
      p.cols[7] = '-';
      console.log(`  ✓ #${p.id}: report ${p.report} already written — keeping as completed (score ${p.cols[6]})`);
    }
    else { reset++; }
    p.cols[2] = p.next;
    p.raw = p.cols.join('\t');
  }

  if (!dry) {
    const merged = out.map(o => (o.idx === undefined ? o.raw : plan[o.idx].raw));
    writeFileSync(STATE, merged.join('\n'), 'utf-8');
    // A sentinel with no report behind it MAY be a number reserved by a worker we killed —
    // or it may be held by a worker that is still running. Releasing it unconditionally
    // hands the same number to the next worker, and two reports end up numbered alike
    // (reports 039 were King and Client Server, from exactly this).
    //
    // AGENTS.md already GCs sentinels after 4h, so there is nothing to gain by being
    // eager. Only release what is old enough that no live worker could still hold it.
    const STALE_MS = 4 * 60 * 60 * 1000;
    for (const f of readdirSync(REPORTS)) {
      if (!f.endsWith('-RESERVED.md')) continue;
      const num = f.slice(0, 3);
      if (done.has(num)) continue;
      const full = path.join(REPORTS, f);
      const age = Date.now() - statSync(full).mtimeMs;
      if (age < STALE_MS) { console.log(`  · reservation ${num} is ${Math.round(age / 60000)}min old — leaving it (4h GC owns it)`); continue; }
      unlinkSync(full);
      console.log(`  ↺ released reservation ${num} (${Math.round(age / 3600000)}h old)`);
    }
  }
  console.log(`resume: ${rescued} row(s) rescued as completed, ${reset} reset to pending${dry ? ' (dry run)' : ''}`);
}

function demo() {
  assert.equal(reportScore('**Score:** 3.8/5'), '3.8', 'rescue keeps the actual evaluation score');
  assert.equal(reportScore('**Score:** 0/5'), '0');
  assert.equal(reportScore('**Score:** 6/5'), '-');
  assert.equal(reportScore('no score'), '-');
  assert.deepEqual(
    [...finishedReports(['001-acme-2026-01-01.md', '002-RESERVED.md', 'notes.txt'])],
    ['001'], 'sentinels and non-reports are not finished work');

  const rows = [
    { id: '1', status: 'processing', report: '001' },        // report exists -> rescue
    { id: '2', status: 'processing', report: '002' },        // only a sentinel -> redo
    { id: '3', status: 'paused_rate_limit', report: '' },    // never started -> redo
    { id: '4', status: 'completed', report: '003' },         // untouched
    { id: '5', status: 'failed', report: '001' },            // report exists -> rescue
  ];
  const plan = planResume(rows, finishedReports(['001-a.md', '002-RESERVED.md', '003-c.md']));
  assert.deepEqual(plan.map(p => p.next),
    ['completed', 'pending', 'pending', 'completed', 'completed']);
  assert.equal(plan.filter(p => p.rescued).length, 2, 'only rows with real reports are rescued');

  // The bug this exists to prevent: a finished report must never be re-queued.
  assert.notEqual(plan[0].next, 'pending', 'a written report is never re-evaluated');
  assert.ok(isBatchWorkerArgv('claude -p --append-system-prompt-file batch/.resolved-prompt-7.md'));
  assert.ok(!isBatchWorkerArgv('claude -p --append-system-prompt-file batch/.triage-system.md'));
  assert.ok(!isBatchWorkerArgv('claude -p'));
  console.log('resume-batch-state self-check: all assertions passed');
}

// The shared guard handles imports, direct execution and symlinked worker roots.
if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--demo')) demo();
  else main(process.argv.slice(2));
}
