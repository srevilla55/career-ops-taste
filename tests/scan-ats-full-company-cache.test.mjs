import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCompanyList, SOURCES } from '../scan-ats-full.mjs';
import { pass, fail } from './helpers.mjs';

const cacheDir = mkdtempSync(join(tmpdir(), 'career-ops-company-cache-'));
const url = SOURCES.greenhouse.dataset;
const cache = join(cacheDir, 'greenhouse.json');
try {
  const seen = [];
  const fetch = async source => {
    seen.push(source);
    if (source === url) throw new Error('HTTP 429 from raw host');
    return ['acme'];
  };
  assert.deepEqual(await loadCompanyList('greenhouse', url, { cacheDir, fetch }), { list: ['acme'], status: 'ok' });
  assert.deepEqual(seen, [url, 'https://cdn.jsdelivr.net/gh/Feashliaa/job-board-aggregator@main/data/greenhouse_companies.json']);
  assert.deepEqual(JSON.parse(readFileSync(cache, 'utf8')), ['acme']);
  assert.deepEqual(readdirSync(cacheDir), ['greenhouse.json']);
  await loadCompanyList('greenhouse', url, { cacheDir, fetch });
  assert.equal(seen.length, 2);
  pass('ATS dataset mirror recovers blocked raw host, atomically caches, then reuses the fresh array');

  for (const [name, source] of Object.entries(SOURCES).filter(([, source]) => source.dataset)) {
    const calls = [];
    await loadCompanyList(`production-${name}`, source.dataset, {
      cacheDir, fetch: async request => {
        calls.push(request);
        if (request === source.dataset) throw new Error('HTTP 429');
        return ['fictional-board'];
      },
    });
    const mirrorable = /^https:\/\/raw\.githubusercontent\.com\/Feashliaa\/job-board-aggregator\/main\/data\/[a-z]+_companies(?:_clean)?\.json$/.test(source.dataset);
    assert.deepEqual(calls, mirrorable ? [source.dataset,
      `https://cdn.jsdelivr.net/gh/Feashliaa/job-board-aggregator@main/data/${source.dataset.split('/').at(-1)}`] : [source.dataset]);
  }
  pass('configured production JSON datasets get their matching mirror; JOIN sitemap gets none');

  const down = async () => { throw new Error('offline'); };
  utimesSync(cache, new Date(0), new Date(0));
  assert.deepEqual(await loadCompanyList('greenhouse', url, { cacheDir, fetch: down }), { list: ['acme'], status: 'stale' });
  writeFileSync(cache, '{"unexpected":true}');
  assert.deepEqual(await loadCompanyList('greenhouse', url, { cacheDir, fetch: down }), { list: [], status: 'empty' });
  const untrusted = [];
  await loadCompanyList('greenhouse', 'https://example.com/greenhouse.json', {
    cacheDir, fetch: async source => { untrusted.push(source); return {}; },
  });
  assert.deepEqual(untrusted, ['https://example.com/greenhouse.json']);
  const unknownDataset = url.replace('greenhouse_companies.json', 'not-configured.json');
  const unknownCalls = [];
  await loadCompanyList('unknown', unknownDataset, {
    cacheDir, fetch: async source => { unknownCalls.push(source); throw new Error('offline'); },
  });
  assert.deepEqual(unknownCalls, [unknownDataset]);
  pass('ATS cache keeps valid stale arrays, rejects malformed caches/responses, and never mirrors arbitrary URLs');
} catch (err) {
  fail(`ATS company cache: ${err.stack}`);
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}
