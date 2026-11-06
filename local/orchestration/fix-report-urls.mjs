#!/usr/bin/env node
/**
 * fix-report-urls.mjs — put the real posting URL back into report headers.
 *
 * Reports for JobSpy rows are evaluated from a local JD file, so the batch worker is
 * handed `local:jds/jobspy/foo.md` as its `{{URL}}` and faithfully writes that into the
 * report's `**URL:**` header. Correct from the worker's point of view, useless from a
 * human's: that header is the link you click to actually apply.
 *
 * The real URL is already in the JD file's own front matter (`- **Original URL:** ...`),
 * written by ingest-jobspy's renderJd. This copies it back. Idempotent.
 *
 *   node local/orchestration/fix-report-urls.mjs [--dry-run] [--demo]
 */

import { isMainModule } from '../../lib/is-main-module.mjs';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORTS = path.join(ROOT, 'reports');

import { originalUrlFrom } from '../../jd-capture.mjs';
export { originalUrlFrom } from '../../jd-capture.mjs';

/** Rewrite a report's `**URL:**` header when it points at a local JD path. */
export function rewriteHeader(report, realUrl) {
  return report.replace(/^(\*\*URL:\*\*\s*)local:\S+\s*$/m, `$1${realUrl}`);
}

function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('Usage: node local/orchestration/fix-report-urls.mjs [options]');
    return;
  }

  const dryRun = argv.includes('--dry-run');
  let fixed = 0, skipped = 0;

  for (const file of readdirSync(REPORTS).filter(f => f.endsWith('.md') && !f.includes('RESERVED'))) {
    const full = path.join(REPORTS, file);
    const text = readFileSync(full, 'utf-8');
    const m = text.match(/^\*\*URL:\*\*\s*local:(\S+)\s*$/m);
    if (!m) continue;

    const jdPath = path.join(ROOT, m[1]);
    if (!existsSync(jdPath)) { console.log(`  ? ${file} — JD file missing: ${m[1]}`); skipped++; continue; }
    const real = originalUrlFrom(readFileSync(jdPath, 'utf-8'));
    if (!real) { console.log(`  ? ${file} — JD records no Original URL`); skipped++; continue; }

    if (!dryRun) writeFileSync(full, rewriteHeader(text, real), 'utf-8');
    console.log(`  ✓ ${file} → ${real}`);
    fixed++;
  }
  console.log(`report URLs: ${fixed} fixed${skipped ? `, ${skipped} skipped` : ''}${dryRun ? ' (dry run)' : ''}`);
}

function demo() {
  const jd = [
    '# Backend Engineer', '',
    '- **Company:** Acme',
    '- **Original URL:** https://www.linkedin.com/jobs/view/4453941065',
    '- **Posted:** 2026-08-14',
  ].join('\n');
  assert.equal(originalUrlFrom(jd), 'https://www.linkedin.com/jobs/view/4453941065');
  assert.equal(originalUrlFrom('# Role\n\n- **Company:** Acme\n'), null, 'absent stays null, never guessed');
  assert.equal(originalUrlFrom('**URL:** https://example.invalid/job/1'), 'https://example.invalid/job/1');
  assert.equal(originalUrlFrom('original_url: "https://example.invalid/job/2"'), 'https://example.invalid/job/2');

  const report = ['# Evaluation: Acme — Backend', '', '**Score:** 4.0/5',
    '**URL:** local:jds/jobspy/acme-backend-abc.md', '**PDF:** not generated'].join('\n');
  const out = rewriteHeader(report, 'https://real/1');
  assert.ok(out.includes('**URL:** https://real/1'));
  assert.ok(!out.includes('local:jds'), 'the local path is gone');
  assert.ok(out.includes('**Score:** 4.0/5') && out.includes('**PDF:** not generated'), 'nothing else touched');

  // Already-real URLs are left alone, so re-running is safe.
  const clean = '**URL:** https://already/real';
  assert.equal(rewriteHeader(clean, 'https://other'), clean);
  console.log('fix-report-urls self-check: all assertions passed');
}

// The shared guard handles imports, direct execution and symlinked worker roots.
if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--demo')) demo();
  else main(process.argv.slice(2));
}
