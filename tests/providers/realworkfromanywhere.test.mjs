// tests/providers/realworkfromanywhere.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — realworkfromanywhere');

try {
  const {
    default: rwfa,
    parseRwfaFeed,
  } = await import(pathToFileURL(join(ROOT, 'providers/realworkfromanywhere.mjs')).href);

  if (rwfa.id === 'realworkfromanywhere') {
    pass('realworkfromanywhere.id is "realworkfromanywhere"');
  } else {
    fail(`realworkfromanywhere.id is "${rwfa.id}"`);
  }

  if (
    rwfa.detect({ provider: 'realworkfromanywhere' })?.url ===
      'https://www.realworkfromanywhere.com/remote-backend-jobs/rss.xml'
  ) {
    pass('realworkfromanywhere.detect() claims explicit provider config');
  } else {
    fail('realworkfromanywhere.detect() failed');
  }

  if (rwfa.detect({ provider: 'other' }) === null) {
    pass('realworkfromanywhere.detect() ignores other provider ids');
  } else {
    fail('realworkfromanywhere.detect() should ignore other providers');
  }

  const xml = `
<rss>
  <channel>
    <item>
      <title><![CDATA[Senior Software Engineer, Backend at Acme]]></title>
      <link>https://www.realworkfromanywhere.com/jobs/acme-senior-backend-1</link>
      <pubDate>Thu, 20 Aug 2026 14:13:59 GMT</pubDate>
      <category><![CDATA[Backend]]></category>
      <author><![CDATA[Acme]]></author>
    </item>

    <item>
      <title>Platform Engineer</title>
      <link>https://www.realworkfromanywhere.com/jobs/example-platform-2</link>
      <pubDate>not-a-date</pubDate>
      <category>Backend</category>
    </item>

    <item>
      <title>Bad Host Job</title>
      <link>https://evil.com/job</link>
      <author>Evil Inc</author>
    </item>

    <item>
      <title></title>
      <link>https://www.realworkfromanywhere.com/jobs/skip-empty-title</link>
      <author>Nobody</author>
    </item>
  </channel>
</rss>
`;

  const jobs = parseRwfaFeed(xml);

  if (jobs.length === 2) {
    pass('parseRwfaFeed keeps valid items and drops malformed ones');
  } else {
    fail(`expected 2 jobs, got ${jobs.length}`);
  }

  if (
    jobs[0]?.title === 'Senior Software Engineer, Backend at Acme' &&
    jobs[0]?.company === 'Acme' &&
    jobs[0]?.location === '' &&
    jobs[0]?.url === 'https://www.realworkfromanywhere.com/jobs/acme-senior-backend-1' &&
    typeof jobs[0]?.postedAt === 'number'
  ) {
    pass('parseRwfaFeed maps title, company (from <author>), location, url and postedAt');
  } else {
    fail(`unexpected first parsed job: ${JSON.stringify(jobs[0])}`);
  }

  if (
    jobs[1]?.title === 'Platform Engineer' &&
    jobs[1]?.company === 'Real Work From Anywhere' &&
    !('postedAt' in jobs[1])
  ) {
    pass('parseRwfaFeed falls back company when <author> is absent and is NaN-safe for invalid dates');
  } else {
    fail(`unexpected second parsed job: ${JSON.stringify(jobs[1])}`);
  }

  if (parseRwfaFeed('').length === 0 && parseRwfaFeed('not xml at all').length === 0) {
    pass('parseRwfaFeed returns [] for empty/malformed input');
  } else {
    fail('parseRwfaFeed should return [] for empty/malformed input');
  }

  const requestedUrls = [];

  const fetched = await rwfa.fetch({}, {
    async fetchText(url, opts) {
      requestedUrls.push(url);

      if (opts?.redirect !== 'error') {
        throw new Error('unexpected fetch arguments');
      }

      return xml;
    },
  });

  const expectedUrls = [
    'https://www.realworkfromanywhere.com/remote-backend-jobs/rss.xml',
    'https://www.realworkfromanywhere.com/remote-software-developer-jobs/rss.xml',
  ];

  if (JSON.stringify(requestedUrls) === JSON.stringify(expectedUrls)) {
    pass('realworkfromanywhere.fetch() requests both Backend and Software Development feeds');
  } else {
    fail(`realworkfromanywhere.fetch() requested unexpected URLs: ${JSON.stringify(requestedUrls)}`);
  }

  if (fetched.length === 4) {
    pass('realworkfromanywhere.fetch() concatenates jobs from both feeds');
  } else {
    fail(`expected 4 concatenated jobs (2 feeds x 2 valid items), got ${fetched.length}`);
  }

} catch (e) {
  fail(`realworkfromanywhere provider tests crashed: ${e.message}`);
}
