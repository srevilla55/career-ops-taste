import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBatchArtifacts } from '../validate-batch-artifacts.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'batch-artifacts-'));
  for (const dir of ['reports', 'jds', 'batch/tracker-additions']) mkdirSync(join(root, dir), { recursive: true });
  const report = join(root, 'reports/042-fictional-2026-10-10.md');
  const tracker = join(root, 'batch/tracker-additions/1.tsv');
  const jdFile = join(root, 'source.md');
  const url = 'https://jobs.example.invalid/backend/42';
  const jd = 'Fictional backend opening requires Python APIs, automated testing and collaboration. This fixture contains no real candidate or company facts.';
  const sections = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(block => '\n## '+block+') Evaluation\nThe fictional posting requests Python API development and automated testing; this is synthetic evidence for a completion check.').join('');
  writeFileSync(jdFile, jd);
  writeFileSync(report, '# Fictional evaluation\n\n**Score:** 4.2/5\n**URL:** '+url+'\n\n## Job Description (archived verbatim)\n'+jd+'\n\n## Machine Summary\n```yaml\ncompany: Fictional Company\nrole: Backend Engineer\nscore: 4.2\n```\n'+sections+'\n\n## Risk Summary\nThis fictional evaluation contains no private evidence and makes no claims about a real employer or candidate.\n');
  writeFileSync(tracker, 'num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl\n042\t2026-10-10\tFictional Company\tBackend Engineer\tEvaluated\t4.2/5\t❌\t[042](reports/042-fictional-2026-10-10.md)\tFictional fixture\t'+url+'\n');
  const replace = (path, from, to) => writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  const validate = (queueUrl = url, score = '4.2') => validateBatchArtifacts(root, '042', '1', queueUrl, score, jdFile);
  return { root, report, tracker, jdFile, url, jd, replace, validate };
}

function check(name, fn) {
  test(name, () => {
    const f = fixture();
    try { fn(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

check('a substantive canonical evaluation and headed tracker row complete', f => f.validate());
check('HTTP tracking parameters use the canonical posting identity', f => f.validate(f.url+'?utm_source=fixture#top'));
check('summary and section headings in an archived JD cannot complete an incomplete report', f => {
  const content = readFileSync(f.report, 'utf8');
  const spoof = content.slice(content.indexOf('## Machine Summary'));
  f.replace(f.report, f.jd, f.jd+'\n\nSpoof ### machine summary'+spoof.slice('## Machine Summary'.length));
  // Remove only the real G section; the archived spoof still contains one.
  const altered = readFileSync(f.report, 'utf8');
  const lastG = altered.lastIndexOf('## G) Evaluation');
  writeFileSync(f.report, altered.slice(0, lastG)+altered.slice(lastG).replace('## G) Evaluation', '## Missing evaluation'));
  assert.throws(() => f.validate(), /exactly one canonical Machine Summary/);
});
for (const [name, mutate, message] of [
  ['noncanonical filename', f => renameSync(f.report, join(f.root, 'reports/042-fictional.md')), /filename/],
  ['missing JD archive', f => f.replace(f.report, '## Job Description (archived verbatim)', '## Lost source'), /JD archive/],
  ['missing G section', f => f.replace(f.report, '## G) Evaluation', '## Missing evaluation'), /section G/],
  ['empty company identity', f => f.replace(f.report, 'company: Fictional Company', 'company: ""'), /must be nonempty/],
  ['zero Machine Summary score', f => f.replace(f.report, 'score: 4.2', 'score: 0'), /invalid Machine Summary score/],
  ['mismatched Machine Summary score', f => f.replace(f.report, 'score: 4.2', 'score: 3.9'), /scores disagree/],
  ['different posting URL', f => f.replace(f.report, f.url, 'https://jobs.example.invalid/other'), /posting URL disagree/],
  ['empty posting URL', f => f.replace(f.report, '**URL:** '+f.url, '**URL:**'), /posting URL disagree/],
  ['incorrect tracker report number', f => f.replace(f.tracker, '\n042\t', '\n043\t'), /reservation/],
]) check(name+' fails closed', f => { mutate(f); assert.throws(() => f.validate(), message); });

for (const metadata of ['**Original URL:** ', '**URL:** ', 'original_url: "']) {
  check('local discovery resolves original posting from '+metadata, f => {
    writeFileSync(f.jdFile, metadata+f.url+(metadata.endsWith('"') ? '"' : '')+'\n'+f.jd);
    f.validate('local:jds/fixture.md');
  });
}
check('a local posting without an HTTP source must match its exact local URL', f => {
  f.replace(f.report, f.url, 'local:jds/fixture.md');
  f.replace(f.tracker, f.url, 'local:jds/fixture.md');
  f.validate('local:jds/fixture.md');
  f.replace(f.report, 'local:jds/fixture.md', 'local:jds/other.md');
  assert.throws(() => f.validate('local:jds/fixture.md'), /posting URL disagree/);
});
