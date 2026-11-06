import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkNodeModules } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(join(tmpdir(), 'career-upgrade-integration-'));
try {
  for (const dir of ['batch/tracker-additions', 'data', 'jds', 'reports', 'output', 'config', 'local/orchestration', 'bin']) mkdirSync(join(fixture, dir), { recursive: true });
  // Public system source only; this fixture never copies the candidate files.
  for (const name of readdirSync(root).filter(n => !n.startsWith('.') && n.endsWith('.mjs'))) copyFileSync(join(root, name), join(fixture, name));
  for (const dir of ['lib', 'providers', 'plugins']) cpSync(join(root, dir), join(fixture, dir), { recursive: true });
  mkdirSync(join(fixture, 'templates'));
  copyFileSync(join(root, 'templates/states.yml'), join(fixture, 'templates/states.yml'));
  copyFileSync(join(root, 'tracker-aliases.json'), join(fixture, 'tracker-aliases.json'));
  copyFileSync(join(root, 'local/ingest-jobspy.mjs'), join(fixture, 'local/ingest-jobspy.mjs'));
  copyFileSync(join(root, 'local/orchestration/fix-report-urls.mjs'), join(fixture, 'local/orchestration/fix-report-urls.mjs'));
  for (const name of ['codex-runner.sh', 'batch-runner.sh', 'batch-prompt.md']) copyFileSync(join(root, 'batch', name), join(fixture, 'batch', name));
  assert.equal(linkNodeModules(fixture, root), null);
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  writeFileSync(join(fixture, 'config/profile.yml'), 'spend_tier: standard\npipeline:\n  auto_pdf_score_threshold: 4.2\n');
  writeFileSync(join(fixture, 'portals.yml'), 'title_filter:\n  positive: [Backend]\n');
  writeFileSync(join(fixture, 'data/applications.md'), '# Fictional tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
  const legacyReport = '007-legacy-2026-10-10.md';
  const jd = 'Fictional junior backend opening. Build Python APIs, write tests and work with a team in Madrid. No real employer or candidate data.';
  writeFileSync(join(fixture, 'reports', legacyReport), '# Legacy fictional evaluation\n\n## Job Description (archived verbatim)\n'+jd+'\n');
  writeFileSync(join(fixture, 'batch/tracker-additions/legacy.tsv'), '7\t2026-10-10\tLegacy Fixture\tBackend\tEvaluated\t4.0/5\t❌\t[007](reports/'+legacyReport+')\tLegacy headerless compatibility\n');
  const rows = ['Acme Fixture', 'Beta Fixture'].map((company, i) => ({ site: 'indeed', title: 'Junior Backend Engineer', company, location: 'Madrid, Spain', job_url: 'https://example.invalid/jobs/'+i, description: jd, date_posted: new Date().toISOString().slice(0, 10) }));
  const env = { ...process.env, CAREER_OPS_ROOT: fixture, CAREER_OPS_TRACKER: join(fixture, 'data/applications.md'), PATH: join(fixture, 'bin')+':'+process.env.PATH };
  const runNode = (script, input) => execFileSync(process.execPath, [join(fixture, script)], { cwd: fixture, env, input, encoding: 'utf8', timeout: 30000 });
  runNode('local/ingest-jobspy.mjs', JSON.stringify(rows));
  const firstPipeline = readFileSync(join(fixture, 'data/pipeline.md'), 'utf8');
  runNode('local/ingest-jobspy.mjs', JSON.stringify(rows));
  assert.equal(readFileSync(join(fixture, 'data/pipeline.md'), 'utf8'), firstPipeline, 'repeat discovery does not duplicate queue rows');
  const urls = [...firstPipeline.matchAll(/local:jds\/jobspy\/[^\s|]+\.md/g)].map(m => m[0]);
  assert.equal(urls.length, 2);
  writeFileSync(join(fixture, 'batch/batch-input.tsv'), 'id\turl\tsource\tnotes\n'+urls.map((url,i) => (i+1)+'\t'+url+'\ttest\tfictional').join('\n')+'\n');
  writeFileSync(join(fixture, 'bin/codex'), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2), prompt=readFileSync(0,'utf8');
const num=prompt.match(/Report number: (\\d+)/)[1], id=prompt.match(/Batch ID: (\\d+)/)[1], queueUrl=prompt.match(/URL: (\\S+)/)[1], jdFile=prompt.match(/JD file: (\\S+)/)[1];
const jd=readFileSync(jdFile,'utf8'), url=jd.match(/Original URL:\\*\\*\\s*(\\S+)/)?.[1]||queueUrl;
appendFileSync('calls.jsonl',JSON.stringify({args,prompt})+'\\n');
if(process.env.MOCK_MODE!=='noop') {
  const report=num+'-fixture-'+id+'-2026-10-10.md', company=id==='1'?'Acme Fixture':'Beta Fixture';
  const sections=['A','B','C','D','E','F','G'].map(b=>'\\n## '+b+') Fictional evaluation\\nFictional evidence: this opening expects junior Python backend engineering and API testing.').join('')+'\\n\\n## Risk Summary\\nFictional fixture only: no real employer or candidate facts and no external model calls.';
  writeFileSync('reports/'+report,'# Evaluation: '+company+' — Junior Backend Engineer\\n\\n**Score:** 4.1/5\\n**URL:** '+url+'\\n\\n## Job Description (archived verbatim)\\n'+readFileSync(jdFile,'utf8')+'\\n\\n## Machine Summary\\n\`\`\`yaml\\ncompany: "'+company+'"\\nrole: "Junior Backend Engineer"\\nscore: 4.1\\nreports_to: null\\nrequirement_importance: []\\nrisk_summary: {}\\n\`\`\`\\n'+sections);
  if(process.env.MOCK_MODE==='no-archive') writeFileSync('reports/'+report,readFileSync('reports/'+report,'utf8').replace('## Job Description (archived verbatim)','## Lost JD'));
  if(process.env.MOCK_MODE==='incomplete') writeFileSync('reports/'+report,readFileSync('reports/'+report,'utf8').replace('## G) Fictional evaluation','## Missing evaluation'));
  if(process.env.MOCK_MODE==='bad-score') writeFileSync('reports/'+report,readFileSync('reports/'+report,'utf8').replace('score: 4.1','score: 3.9'));
  if(process.env.MOCK_MODE!=='no-tsv') writeFileSync('batch/tracker-additions/'+id+'.tsv','num\\tdate\\tcompany\\trole\\tstatus\\tscore\\tpdf\\treport\\tnotes\\turl\\n'+num+'\\t2026-10-10\\t'+company+'\\tJunior Backend Engineer\\tEvaluated\\t4.1/5\\t❌\\t['+num+'](reports/'+report+')\\tFictional fixture\\t'+url+'\\n');
}
writeFileSync(args[args.indexOf('--output-last-message')+1],'\`\`\`json\\n'+JSON.stringify({status:'completed',score:4.1,pdf:null})+'\\n\`\`\`');
`, { mode: 0o700 });
  const runBatch = (mode, extra = []) => execFileSync('bash', [join(fixture, 'batch/codex-runner.sh'), '--skip-pdf', '--limit', '1', '--max-retries', '8', '--rate-limit-sleep', '0', ...extra], { cwd: fixture, env: { ...env, MOCK_MODE: mode }, timeout: 30000, encoding: 'utf8' });
  runBatch('noop');
  assert.match(readFileSync(join(fixture, 'batch/batch-state.tsv'), 'utf8'), /\tfailed\t/, 'a claimed success without a report fails closed');
  for (const mode of ['no-tsv', 'no-archive', 'incomplete', 'bad-score']) {
    runBatch(mode, ['--retry-failed']);
    assert.match(readFileSync(join(fixture, 'batch/batch-state.tsv'), 'utf8'), /\tfailed\t/, mode+' must fail closed');
  }
  const resumed = runBatch('complete', ['--retry-failed']);
  assert.match(readFileSync(join(fixture, 'batch/batch-state.tsv'), 'utf8'), /\tcompleted\t/, resumed);
  runBatch('complete');
  const callsBefore = readFileSync(join(fixture, 'calls.jsonl'), 'utf8');
  runBatch('complete');
  assert.equal(readFileSync(join(fixture, 'calls.jsonl'), 'utf8'), callsBefore, 'completed rows are not rerun');
  const states = readFileSync(join(fixture, 'batch/batch-state.tsv'), 'utf8').trim().split('\n').slice(1);
  assert.equal(states.length, 2);
  assert.ok(states.every(line => line.split('\t')[2] === 'completed'));
  const tracker = readFileSync(join(fixture, 'data/applications.md'), 'utf8');
  for (const company of ['Legacy Fixture', 'Acme Fixture', 'Beta Fixture']) assert.ok(tracker.includes(company), 'canonical merge keeps legacy and new additions');
  const processed = readFileSync(join(fixture, 'data/pipeline.md'), 'utf8');
  assert.match(processed, /## Processed/);
  assert.equal([...processed.matchAll(/^- \[x\]/gm)].length, 2);
  assert.ok(!readdirSync(join(fixture, 'reports')).some(n => n.endsWith('-RESERVED.md')));
  assert.equal(readdirSync(join(fixture, 'output')).length, 0, 'evaluation only creates no package artifacts');
  for (const { prompt } of callsBefore.trim().split('\n').map(JSON.parse)) assert.ok(prompt.includes('Block H application answers'));
  runNode('verify-pipeline.mjs');
  console.log('Upgrade integration: synthetic JobSpy discovery, dedup, no-op/missing-artifact rejection, retry/resume, legacy/new tracker merge and evaluation-only boundaries passed.');
} finally { rmSync(fixture, { recursive: true, force: true }); }
