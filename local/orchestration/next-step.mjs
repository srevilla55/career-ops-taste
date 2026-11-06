#!/usr/bin/env node
/**
 * next-step.mjs — what should this session do right now?
 *
 * The pipeline used to be driven by a long-lived background script that slept through
 * quota limits. That was the wrong mechanism: the sleep is computed from the refusal text
 * ("resets 7:10am"), so when the quota actually comes back earlier the script sits idle for
 * hours and needs a manual nudge. Claude Code already resumes the session itself at reset.
 *
 * So the session drives the pipeline, and this tells it where it left off. Every stage is
 * keyed off files on disk (triage-verdicts.tsv, batch-state.tsv, reports/, output/), so a
 * resumed session re-derives its position rather than remembering it.
 *
 * Order is deliberate and matches how the work is meant to feel: finish evaluating what is
 * queued, turn anything that clears the bar into a ready-to-send packet, and only then
 * spend quota discovering more. That keeps a steady trickle of applications to work on
 * instead of one huge batch at the end.
 *
 *   node local/orchestration/next-step.mjs [--brain claude|codex] [--json]
 */

import { walkTree } from '../../lib/walk-tree.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { loadYaml } from '../../lib/yaml-document.mjs';
import { getProfilePath } from '../../path-resolver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const p = f => path.join(ROOT, f);

/** Evaluated roles that clear the packet bar but have no finished packet yet. */
export function packetsDue(evals, packetBar, hasPacket, limit = Infinity) {
  return evals.filter(e => e.score >= packetBar && !hasPacket(e)).sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Evaluations are released in quarters so packets start flowing before the whole batch is
 * done — a quarter of the queue, minimum one, so a small remainder still moves.
 */
export function quarter(pending, divisor = 4) {
  return pending <= 0 ? 0 : Math.max(1, Math.ceil(pending / divisor));
}

export function quarterPlan(total, divisor = 4) {
  const base = Math.floor(total / divisor);
  const extra = total % divisor;
  return Array.from({ length: divisor }, (_, i) => base + Number(i < extra));
}

export function remainingInQuarter(total, completed, divisor = 4) {
  let boundary = 0;
  for (const size of quarterPlan(total, divisor)) {
    boundary += size;
    if (completed < boundary) return boundary - completed;
  }
  return 0;
}

export function pendingCount(queued, terminal) {
  return [...queued].filter(token => !terminal.has(token)).length;
}

export function normalizePacketMax(value) {
  const n = Number(value ?? 20);
  if (n === 0) return Infinity;
  return Number.isFinite(n) ? Math.max(0, n) : 20;
}

/** Historical flat outreach files and current application-bundle outreach both count. */
export function hasPacketArtifact(files, report, slug) {
  const key = String(slug || '').toLowerCase();
  return files.some(file => {
    const rel = file.replaceAll(path.sep, '/').toLowerCase();
    const base = path.posix.basename(rel);
    return rel.startsWith(`outreach/${key}`)
      || (rel.startsWith(`${report}-`) && rel.includes('/outreach/'))
      || (base.startsWith(`${key}-`) && base.includes('outreach'));
  });
}

export function nextAction({ pendingEval, due, missingJds, unscored }) {
  if (due.length) return 'PACKET';
  if (pendingEval > 0) return 'EVAL';
  if (missingJds > 0) return 'HYDRATE';
  if (unscored > 0) return 'TRIAGE';
  return 'DONE';
}

export function walkOutputFiles(dir) {
  return walkTree(dir, { onError: 'throw' }).map(file => path.relative(dir, file));
}

function loadState() {
  const cfg = loadYaml(readFileSync(getProfilePath(), 'utf-8')) || {};
  const packetBar = Number(cfg?.pipeline?.packet_min_score ?? 3.7);
  const packetMax = normalizePacketMax(cfg?.pipeline?.packet_max);

  const scored = new Set();
  if (existsSync(p('data/triage-verdicts.tsv'))) {
    for (const l of readFileSync(p('data/triage-verdicts.tsv'), 'utf-8').split('\n')) {
      const t = l.split('\t')[0];
      if (t && t !== 'token') scored.add(t);
    }
  }
  const indexed = new Map(existsSync(p('data/jd-index.tsv'))
    ? readFileSync(p('data/jd-index.tsv'), 'utf-8').split('\n').filter(Boolean).map(l => l.split('\t'))
    : []);
  const uncertain = new Set(existsSync(p('data/jd-uncertain.tsv'))
    ? readFileSync(p('data/jd-uncertain.tsv'), 'utf-8').split('\n').filter(Boolean).map(l => l.split('\t')[0])
    : []);
  let unscored = 0, missingJds = 0;
  for (const l of readFileSync(p('data/pipeline.md'), 'utf-8').split('\n')) {
    if (!l.startsWith('- [ ] ')) continue;
    const token = l.slice(6).split('|')[0].trim();
    if (scored.has(token)) continue;
    unscored++;
    const rel = token.startsWith('local:') ? token.slice(6) : indexed.get(token);
    if ((!rel || !existsSync(p(rel))) && !uncertain.has(token)) missingJds++;
  }

  // Only rows still present in batch-input are real work. Raising the eval bar prunes
  // rows out of batch-input but leaves their state row behind, and counting those as
  // pending sends the session to run a batch that has nothing to do.
  const queued = new Set();
  if (existsSync(p('batch/batch-input.tsv'))) {
    for (const l of readFileSync(p('batch/batch-input.tsv'), 'utf-8').split('\n')) {
      const c = l.split('\t');
      if (c[1] && c[0] !== 'id') queued.add(c[1]);
    }
  }

  const evals = [];
  const terminalEval = new Set();
  if (existsSync(p('batch/batch-state.tsv'))) {
    for (const l of readFileSync(p('batch/batch-state.tsv'), 'utf-8').split('\n')) {
      const c = l.split('\t');
      if (!c[0] || c[0] === 'id') continue;
      if (c[2] === 'completed') {
        terminalEval.add(c[1]);
        const score = parseFloat(c[6]);
        if (Number.isFinite(score)) evals.push({ report: c[5], score });
      } else if (c[2] === 'skipped') {
        terminalEval.add(c[1]);
      }
    }
  }
  const pendingEval = pendingCount(queued, terminalEval);

  // A packet is finished when its outreach file exists — that is the last artifact written,
  // so its presence implies the CV and cover letter cleared their gates first.
  const outputFiles = existsSync(p('output')) ? walkOutputFiles(p('output')) : [];
  const reportFiles = existsSync(p('reports')) ? readdirSync(p('reports')) : [];
  const slugFor = num => {
    const m = reportFiles.find(f => f.startsWith(num + '-') && !f.includes('RESERVED'));
    return m ? m.replace(/^\d{3}-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '') : null;
  };
  const hasPacket = e => {
    const slug = slugFor(e.report);
    return Boolean(slug && hasPacketArtifact(outputFiles, e.report, slug));
  };

  const waveFile = p('batch/.eval-wave');
  const wave = existsSync(waveFile)
    ? readFileSync(waveFile, 'utf-8').split('\n').filter(token => token && queued.has(token))
    : [];
  const waveCompleted = wave.filter(token => terminalEval.has(token)).length;
  const wavePending = wave.length - waveCompleted;
  const evalQuarter = wavePending > 0 ? remainingInQuarter(wave.length, waveCompleted) : quarter(pendingEval);

  return { packetBar, packetMax, unscored, missingJds, pendingEval, evalQuarter, evals, hasPacket, slugFor };
}

function main(argv) {
  const arg = (flag, fallback) => { const i = argv.indexOf(flag); return i === -1 ? fallback : argv[i + 1]; };
  const brain = String(arg('--brain', process.env.CAREER_OPS_BRAIN || 'claude')).toLowerCase();
  if (!['claude', 'codex'].includes(brain)) throw new Error('--brain must be claude or codex');
  const s = loadState();
  const packeted = s.evals.filter(s.hasPacket).length;
  const capacity = Number.isFinite(s.packetMax) ? Math.max(0, s.packetMax - packeted) : Infinity;
  const due = packetsDue(s.evals, s.packetBar, s.hasPacket, capacity);
  const runner = brain === 'codex' ? './batch/codex-runner.sh' : './batch/batch-runner.sh';

  const action = nextAction({ pendingEval: s.pendingEval, due, missingJds: s.missingJds, unscored: s.unscored });
  let detail;
  if (action === 'PACKET') {
    detail = `${due.length} evaluated role(s) at or above ${s.packetBar} with no packet (use ${brain === 'codex' ? 'gpt-6.1-sol at xhigh reasoning' : 'the premium model'}): ` +
      due.map(d => `${d.report}(${d.score})`).join(' ');
  } else if (action === 'EVAL') {
    detail = `${s.pendingEval} offer(s) queued — release a quarter (${Math.min(s.evalQuarter, s.pendingEval)}) with ${runner} --skip-pdf`;
  } else if (action === 'HYDRATE') {
    detail = `${s.missingJds} unscored role(s) have no local JD — node local/orchestration/hydrate-jds.mjs --unscored-only --concurrency 5`;
  } else if (action === 'TRIAGE') {
    detail = `${s.unscored} role(s) unscored — next batch: node local/orchestration/triage-all.mjs --brain ${brain} --limit ${Math.min(100, s.unscored)}`;
  } else {
    detail = 'queue fully triaged, evaluated and packeted';
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ action, detail, brain, unscored: s.unscored, missingJds: s.missingJds,
      pendingEval: s.pendingEval, evalQuarter: s.evalQuarter, packetsDue: due.map(d => d.report), packetBar: s.packetBar,
      packetMax: Number.isFinite(s.packetMax) ? s.packetMax : 'all', packeted }, null, 2));
    return;
  }
  console.log(`NEXT: ${action}\n  ${detail}\n`);
  console.log(`  brain ${brain} · unscored ${s.unscored} · missing JDs ${s.missingJds} · queued evals ${s.pendingEval} · packets ${packeted}/${Number.isFinite(s.packetMax) ? s.packetMax : 'all'} · due ${due.length} · bar ${s.packetBar}`);
}

function demo() {
  const evals = [{ report: '001', score: 4.5 }, { report: '002', score: 3.2 }, { report: '003', score: 3.8 }];
  const done = new Set(['001']);
  const due = packetsDue(evals, 3.7, e => done.has(e.report));
  assert.deepEqual(due.map(d => d.report), ['003'], 'below-bar and already-packeted roles are excluded');
  assert.deepEqual(packetsDue(evals, 3.0, () => false, 2).map(d => d.report), ['001', '003'],
    'packet_max caps work to the highest-scoring roles');

  // Releasing in quarters is what keeps applications trickling out instead of arriving in
  // one lump at the very end.
  assert.equal(quarter(24), 6);
  assert.equal(quarter(3), 1, 'a small remainder still moves');
  assert.equal(quarter(0), 0, 'nothing pending, nothing released');
  assert.equal(quarter(25), 7, 'rounds up so the last quarter is never orphaned');
  assert.deepEqual(quarterPlan(9), [3, 2, 2, 2], 'uneven waves still have four quarters');
  assert.equal(remainingInQuarter(9, 3), 2, 'after quarter one, release exactly quarter two');
  assert.equal(remainingInQuarter(9, 4), 1, 'a partial quarter resumes only its remainder');
  assert.equal(pendingCount(new Set(['a', 'b']), new Set(['a'])), 1,
    'new queue rows count as pending before a runner creates their state rows');
  assert.equal(normalizePacketMax(0), Infinity, 'packet_max 0 means every gate-passing role');
  assert.equal(hasPacketArtifact(['047-affirm-role/outreach/recruiter-email.md'], '047', 'affirm'), true,
    'application-bundle outreach marks the packet complete');
  assert.equal(hasPacketArtifact(['liferay-outreach-draft.md'], '049', 'liferay'), true,
    'flat outreach drafts remain compatible');
  assert.equal(nextAction({ pendingEval: 15, due: [{ report: '004' }], missingJds: 0, unscored: 10 }), 'PACKET',
    'packages interrupt the evaluation wave before its next quarter');
  console.log('next-step self-check: all assertions passed');
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node local/orchestration/next-step.mjs [--brain claude|codex] [--json] [--demo]');
  } else if (process.argv.includes('--demo')) demo();
  else main(process.argv.slice(2));
}
