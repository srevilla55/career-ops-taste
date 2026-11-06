import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkNodeModules } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'codex-model-policy-'));
try {
  for (const [tier, override, failure, reported = '', noise = ''] of [
    ['economy', '', ''], ['standard', '', ''], ['premium', '', ''],
    ['standard', 'user-chosen-model', ''],
    ['standard', '', "The 'gpt-6.1-sol' model is not supported for this account"],
    ['standard', '', JSON.stringify({type: 'error', message: "The 'gpt-6.1-sol' model is not supported for this account"})],
    ['standard', '', 'Sensitive-data-egress guard rejected this request'],
    ['standard', '', 'Sensitive-data-egress guard rejected this request', 'yes'],
    ['standard', '', "You've hit your usage limit"],
    ['standard', '', "You've hit your usage limit", '', JSON.stringify({type: 'item.completed', item: {type: 'command_execution', command: 'model evaluation; python: command not found'}})],
  ]) {
    const fixture = mkdtempSync(join(work, 'run-'));
    for (const dir of ['batch', 'config', 'data', 'jds', 'bin', 'lib', 'templates', 'local/orchestration']) mkdirSync(join(fixture, dir), { recursive: true });
    copyFileSync(join(root, 'templates/states.yml'), join(fixture, 'templates/states.yml'));
    for (const file of ['batch/codex-runner.sh', 'reserve-report-num.mjs', 'tracker-utils.mjs', 'tracker-parse.mjs', 'tracker-aliases.json', 'pipeline-lock.mjs', 'path-resolver.mjs', 'lib/is-main-module.mjs', 'lib/cli-flags.mjs', 'check-jd-archive.mjs', 'jd-capture.mjs', 'analyze-patterns.mjs', 'funnel-stages.mjs', 'ats-vendor.mjs', 'url-key.mjs', 'lib/local-today.mjs', 'local/orchestration/fix-report-urls.mjs', 'validate-batch-artifacts.mjs']) {
      copyFileSync(join(root, file), join(fixture, file));
    }
    cpSync(join(root, 'lib'), join(fixture, 'lib'), { recursive: true });
    assert.equal(linkNodeModules(fixture, root), null);
    for (const file of ['merge-tracker.mjs', 'reconcile-pipeline.mjs', 'verify-pipeline.mjs']) writeFileSync(join(fixture, file), '');
    writeFileSync(join(fixture, 'config/profile.yml'), `spend_tier: ${tier}\n`);
    writeFileSync(join(fixture, 'batch/batch-prompt.md'), 'Synthetic evaluation check.');
    writeFileSync(join(fixture, 'jds/check.md'), 'Synthetic junior backend role.');
    writeFileSync(join(fixture, 'batch/batch-input.tsv'), 'id\turl\tsource\tnotes\n1\tlocal:jds/check.md\ttest\tfirst\n2\tlocal:jds/check.md\ttest\tsecond\n');
    writeFileSync(join(fixture, 'bin/codex'), `#!/usr/bin/env node
import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), prompt=readFileSync(0,'utf8');
appendFileSync('invocations.jsonl',JSON.stringify({args,prompt})+'\\n');
if(process.env.CHECK_NOISE)console.log(process.env.CHECK_NOISE);
if(process.env.CHECK_FAILURE&&!process.env.CHECK_REPORTED){console.error(process.env.CHECK_FAILURE);process.exitCode=1;}
else {
const num=prompt.match(/Report number: (\\d+)/)[1];
if(!process.env.CHECK_REPORTED){
const body=['A','B','C','D','E','F','G'].map(b=>'## '+b+') Synthetic evaluation\\nFictional evidence: this role expects junior Python backend engineering and basic API testing.').join('\\n\\n');
writeFileSync('reports/'+num+'-synthetic-2026-10-10.md','# Evaluation: Synthetic — Backend\\n\\n**Score:** 4.1/5\\n**URL:** local:jds/check.md\\n\\n## Job Description (archived verbatim)\\nSynthetic junior backend role to build and test public APIs with Python.\\n\\n## Machine Summary\\n\`\`\`yaml\\ncompany: Synthetic\\nrole: Backend\\nscore: 4.1\\n\`\`\`\\n\\n'+body+'\\n\\n## Risk Summary\\nFictional fixture only: no candidate claims, no application materials and no model request.');
writeFileSync('batch/tracker-additions/'+prompt.match(/Batch ID: (\\d+)/)[1]+'.tsv','num\\tdate\\tcompany\\trole\\tstatus\\tscore\\tpdf\\treport\\tnotes\\turl\\n'+num+'\\t2026-10-10\\tSynthetic\\tBackend\\tEvaluated\\t4.1/5\\t❌\\t['+num+'](reports/'+num+'-synthetic-2026-10-10.md)\\tSynthetic check\\tlocal:jds/check.md\\n');
}
writeFileSync(args[args.indexOf('--output-last-message')+1],'\`\`\`json\\n'+JSON.stringify({status:process.env.CHECK_REPORTED?'failed':'completed',score:4.1,error:process.env.CHECK_REPORTED?process.env.CHECK_FAILURE:null,pdf:null})+'\\n\`\`\`');
}
`, { mode: 0o700 });
    execFileSync('bash', [join(fixture, 'batch/codex-runner.sh'), '--skip-pdf', '--rate-limit-sleep', '0',
      ...(override ? ['--model', override] : [])], {
      cwd: fixture, timeout: 30000,
      env: { ...process.env, CAREER_OPS_ROOT: fixture, CAREER_OPS_TRACKER: '', PATH: `${join(fixture, 'bin')}:${process.env.PATH}`, CHECK_FAILURE: failure, CHECK_REPORTED: reported, CHECK_NOISE: noise },
      stdio: 'pipe',
    });
    const calls = readFileSync(join(fixture, 'invocations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, failure ? 1 : 2, 'rejections stop scheduling the second offer');
    for (const { args, prompt } of calls) {
      assert.equal(args[args.indexOf('--model') + 1], override || 'gpt-6.1-sol');
      assert.ok(args.includes('model_reasoning_effort="high"'));
      assert.ok(args.includes('--ephemeral') && args.includes('--ignore-user-config'));
      assert.ok(prompt.includes('Do not generate PDF'));
    }
    const states = readFileSync(join(fixture, 'batch/batch-state.tsv'), 'utf8').trim().split('\n').slice(1).map(l => l.split('\t'));
    assert.equal(states[0][2], failure.includes('usage limit') ? 'paused_rate_limit' : failure ? 'failed' : 'completed', states[0][7]);
    if (!failure) assert.ok(states.every(s => s[6] === '4.1'), 'real scores survive an empty error field');
  }
  const triage = readFileSync(join(root, 'local/orchestration/triage-all.mjs'), 'utf8');
  assert.ok(triage.includes('model_reasoning_effort="medium"'));
  const hintRoot = mkdtempSync(join(work, 'hint-'));
  for (const dir of ['config', 'data', 'batch', 'reports', 'output', 'local/orchestration']) mkdirSync(join(hintRoot, dir), { recursive: true });
  cpSync(join(root, 'lib'), join(hintRoot, 'lib'), { recursive: true });
  copyFileSync(join(root, 'path-resolver.mjs'), join(hintRoot, 'path-resolver.mjs'));
  copyFileSync(join(root, 'local/orchestration/next-step.mjs'), join(hintRoot, 'local/orchestration/next-step.mjs'));
  assert.equal(linkNodeModules(hintRoot, root), null);
  writeFileSync(join(hintRoot, 'config/profile.yml'), 'pipeline:\n  packet_min_score: 3.7\n');
  writeFileSync(join(hintRoot, 'data/pipeline.md'), '# Fictional empty pipeline\n');
  writeFileSync(join(hintRoot, 'batch/batch-state.tsv'), 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n1\thttps://example.invalid/job\tcompleted\tstart\tend\t001\t4.1\t-\t0\n');
  writeFileSync(join(hintRoot, 'reports/001-fictional-2026-10-10.md'), '# Fictional evaluation\n');
  const next = execFileSync(process.execPath, [join(hintRoot, 'local/orchestration/next-step.mjs'), '--brain', 'codex', '--json'], { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: hintRoot, CAREER_OPS_PROFILE: '', CAREER_OPS_DATA_DIR: '' } });
  const hint = JSON.parse(next);
  assert.equal(hint.action, 'PACKET');
  assert.ok(hint.detail.includes('gpt-6.1-sol at xhigh reasoning'));
  console.log('Codex model policy: tier defaults, override, high reasoning, PDF suppression and rejection stops passed.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
