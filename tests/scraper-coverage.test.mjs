import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import workday, { parseWorkdayResponse } from '../providers/workday.mjs';
import greenhouse from '../providers/greenhouse.mjs';
import ashby from '../providers/ashby.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const entry = { name: 'Fixture', careers_url: 'https://fixture.wd5.myworkdayjobs.com/External' };
const page = (total = 40) => ({ total, facets: [], jobPostings: Array.from({ length: 20 }, (_, i) => ({
  title: 'Engineer', externalPath: `/job/Madrid/Engineer_R${i}`, locationsText: 'Madrid, Spain', postedOn: 'Posted Today',
})) });

test('a Workday page cap preserves partial jobs and marks structural coverage', async () => {
  const jobs = await workday.fetch({ ...entry, max_pages: 1 }, { fetchJson: async () => page() });
  assert.equal(jobs.length, 20);
  assert.equal(jobs.workdayTruncated, 'structural');
  const complete = await workday.fetch({ ...entry, max_pages: 1 }, { fetchJson: async () => page(20) });
  assert.equal(complete.length, 20);
  assert.equal(complete.workdayTruncated, undefined, 'a known complete small board is not partial');
});

test('a non-retryable later-page failure preserves jobs and marks transient coverage', async () => {
  let calls = 0;
  const jobs = await workday.fetch(entry, { fetchJson: async () => {
    if (++calls === 1) return page();
    throw Object.assign(new Error('blocked'), { status: 403 });
  } });
  assert.equal(calls, 2);
  assert.equal(jobs.length, 20);
  assert.equal(jobs.workdayTruncated, 'transient');
});

test('repeated Workday pages remain incomplete below the configured page cap', async () => {
  const jobs = await workday.fetch(entry, { fetchJson: async () => page(), sleep: async () => {} });
  assert.equal(jobs.length, 40);
  assert.equal(new Set(jobs.map(job => job.url)).size, 20);
  assert.equal(jobs.workdayTruncated, 'structural');
});

test('Workday keeps Fully Remote through multi-location detail enrichment', async () => {
  const row = { title: 'Engineer', externalPath: '/job/Madrid/Engineer_R1', locationsText: '2 Locations', remoteType: 'Fully Remote', postedOn: 'Posted Today' };
  const jobs = await workday.fetch(entry, { fetchJson: async url => url.endsWith('/jobs')
    ? { total: 1, jobPostings: [row] }
    : { jobPostingInfo: { location: 'Madrid, Spain', additionalLocations: ['Barcelona, Spain'] } } });
  assert.match(jobs[0].location, /Madrid/);
  assert.match(jobs[0].location, /Remote/);
  assert.equal(parseWorkdayResponse({ jobPostings: [{ ...row, locationsText: 'Madrid', remoteType: 'Partially Remote' }] }, entry)[0].location, 'Madrid');
});

test('board slugs belong to exact HTTPS hosts, including legacy EU embeds', () => {
  for (const provider of [greenhouse, ashby]) {
    const host = provider.id === 'greenhouse' ? 'job-boards.greenhouse.io' : 'jobs.ashbyhq.com';
    for (const url of [`https://example.com/?next=https://${host}/othercorp`, `https://example.com/apply/${host}/othercorp`, `https://${host}.evil.example/acme`, `http://${host}/acme`]) {
      assert.equal(provider.detect({ name: 'Fixture', careers_url: url }), null, url);
    }
    assert.ok(provider.detect({ name: 'Fixture', careers_url: `https://${host.toUpperCase()}/acme` }));
  }
  assert.equal(greenhouse.detect({ name: 'EU', careers_url: 'https://boards.eu.greenhouse.io/embed/job_board?for=acme' }).url,
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs');
});

for (const kind of ['structural', 'transient', null]) {
  test(`scan receipt keeps valid jobs and reports ${kind || 'complete'} coverage`, () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'scraper-coverage-'));
    try {
      mkdirSync(join(dataRoot, 'config'));
      writeFileSync(join(dataRoot, 'config/profile.yml'), '{}\n');
      writeFileSync(join(dataRoot, 'portals.yml'), 'title_filter:\n  positive: [Engineer]\nlocation_filter: [Madrid]\ntracked_companies:\n  - name: Complete\n    careers_url: https://complete.wd5.myworkdayjobs.com/External\n  - name: Partial\n    careers_url: https://partial.wd5.myworkdayjobs.com/External\njob_boards: []\n');
      const preload = join(dataRoot, 'provider.mjs');
      writeFileSync(preload, `import provider from ${JSON.stringify(new URL('../providers/workday.mjs', import.meta.url).href)};
provider.fetch = async entry => {
  const jobs = [{ title: 'Engineer', company: entry.name, location: 'Madrid, Spain', postedAt: Date.now(), url: 'https://' + entry.name.toLowerCase() + '.wd5.myworkdayjobs.com/External/job/Madrid/Engineer_R1' }];
  if (entry.name === 'Partial' && process.env.FIXTURE_COVERAGE) jobs.workdayTruncated = process.env.FIXTURE_COVERAGE;
  return jobs;
};\n`);
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(ROOT, 'scan.mjs'), '--json', '--quiet'], {
        cwd: dataRoot, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PROFILE: join(dataRoot, 'config/profile.yml'), CAREER_OPS_PORTALS: join(dataRoot, 'portals.yml'), CAREER_OPS_PIPELINE: join(dataRoot, 'data/pipeline.md'), CAREER_OPS_SCAN_HISTORY: join(dataRoot, 'data/scan-history.tsv'), FIXTURE_COVERAGE: kind || '' },
      });
      assert.equal(result.status, kind ? 2 : 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.found, 2);
      assert.equal(receipt.added, 2);
      assert.deepEqual(receipt.errors, kind ? [{ company: 'Partial', error: `workday: incomplete coverage (${kind})` }] : []);
      const pipeline = readFileSync(join(dataRoot, 'data/pipeline.md'), 'utf8');
      assert.match(pipeline, /complete\.wd5/);
      assert.match(pipeline, /partial\.wd5/);
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  });
}
