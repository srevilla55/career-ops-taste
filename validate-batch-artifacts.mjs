#!/usr/bin/env node
// Completion gate for newly written batch evaluations; old reports are never changed.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkJdArchive, parseReportFilename } from './check-jd-archive.mjs';
import { parseMachineSummary } from './analyze-patterns.mjs';
import { normalizeUrl } from './url-key.mjs';
import { originalUrlFrom } from './jd-capture.mjs';
import { resolveTsvColumns, SCORE_CELL_RE, normalizeTextKey } from './tracker-parse.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
export function validateBatchArtifacts(root, num, id, queueUrl, score, jdFile) {
  const files = readdirSync(join(root, 'reports')).filter(f => f.startsWith(num + '-') && f.endsWith('.md') && !f.endsWith('-RESERVED.md'));
  if (files.length !== 1) throw Error('expected exactly one completed report for this reservation');
  const reportIdentity = parseReportFilename(files[0]);
  if (!reportIdentity || reportIdentity.reportNum !== Number(num)) throw Error('report filename must carry its reserved number, company slug and date');
  const archives = checkJdArchive(join(root, 'reports'), join(root, 'jds'));
  if (archives.findings.some(f => f.file === files[0])) throw Error('new report is missing a substantive JD archive');
  const lines = readFileSync(join(root, 'batch/tracker-additions', id + '.tsv'), 'utf8').trim().split(/\r?\n/);
  if (lines.length !== 2) throw Error('expected a tracker header and exactly one data row');
  const labels = lines[0].split('\t'), row = lines[1].split('\t');
  const { map, missing, duplicates, unknown } = resolveTsvColumns(labels);
  if (missing.length || duplicates.length || unknown.length || map.url == null || map.notes == null || row.length !== labels.length) throw Error('invalid tracker addition header or row');
  if (Number(row[map.num]) !== Number(num) || !row[map.report].includes('reports/' + files[0]) || !SCORE_CELL_RE.test(row[map.score])) throw Error('tracker addition disagrees with this report reservation');
  const content = readFileSync(join(root, 'reports', files[0]), 'utf8');
  // A JD is untrusted verbatim text. A second canonical summary marker can
  // make the shared first-match parser validate the posting instead of the report.
  // Match exactly the fence grammar used by parseMachineSummary, including
  // its case-insensitive, unanchored markers, and slice from the unique match.
  const summaries = [...content.matchAll(/##\s*Machine Summary\s*\n+```(?:yaml|yml|json)?\s*\n([\s\S]*?)\n```/gi)];
  if (summaries.length !== 1) throw Error('expected exactly one canonical Machine Summary section');
  const summary = parseMachineSummary(summaries[0][0]);
  if (!summary || !Number.isFinite(summary.score) || summary.score < 1 || summary.score > 5) throw Error('missing or invalid Machine Summary score');
  const evaluation = content.slice(summaries[0].index);
  const sections = evaluation.split(/^##\s+/m).slice(1);
  for (const block of ['A)', 'B)', 'C)', 'D)', 'E)', 'F)', 'G)', 'Risk Summary']) {
    const section = sections.find(s => s.startsWith(block));
    if (!section || section.slice(section.indexOf('\n') + 1).replace(/<!--[^]*?-->/g, '').trim().length < 40) throw Error('missing substantive evaluation section ' + block);
  }
  if (!normalizeTextKey(summary.company) || !normalizeTextKey(summary.role)) throw Error('Machine Summary company and role must be nonempty');
  if (normalizeTextKey(summary.company) !== normalizeTextKey(row[map.company]) || normalizeTextKey(summary.role) !== normalizeTextKey(row[map.role])) throw Error('Machine Summary identity disagrees with tracker addition');
  const reportScore = Number(content.match(/^\*\*Score:\*\*\s*([\d.]+)\s*\/\s*5/m)?.[1]);
  if (summary.score !== Number(score) || summary.score !== Number(row[map.score].split('/')[0]) || summary.score !== reportScore) throw Error('worker, report, Machine Summary and tracker scores disagree');
  const expectedUrl = queueUrl.startsWith('local:') ? (originalUrlFrom(readFileSync(jdFile, 'utf8')) || queueUrl) : queueUrl;
  const reportUrl = content.match(/^\*\*URL:\*\*\s*(\S+)/m)?.[1];
  const expectedKey = normalizeUrl(expectedUrl);
  const matchesExpected = value => expectedKey ? normalizeUrl(value) === expectedKey : value === expectedUrl;
  if (!matchesExpected(row[map.url]) || !matchesExpected(reportUrl)) throw Error('report and tracker posting URL disagree with queued JD');

}

if (isMainModule(import.meta.url)) {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    console.log('Usage: node validate-batch-artifacts.mjs ROOT NUMBER ID URL SCORE JD_FILE');
    process.exit(0);
  }
  try { validateBatchArtifacts(...process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
