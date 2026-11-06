// @ts-check
import { decodeEntities } from './_html-entities.mjs';
/** @typedef {import('./_types.js').Provider} Provider */

// Real Work From Anywhere provider - board-wide RSS feeds, Backend +
// Software Development categories (the two closest to this pipeline's
// target roles; the board also has Frontend/Design/Sales/etc. feeds that
// are skipped to avoid noise). Every listing on this board is genuinely
// location-independent, not merely "remote" with hidden country
// restrictions. Feeds are public, no-auth, and XML, so they are parsed
// in-process with the same tiny tag extractor approach as
// providers/nodesk.mjs rather than adding an XML dependency.
//
// Wire in via a `job_boards:` entry with `provider: realworkfromanywhere`.

const FEED_URLS = [
  'https://www.realworkfromanywhere.com/remote-backend-jobs/rss.xml',
  'https://www.realworkfromanywhere.com/remote-software-developer-jobs/rss.xml',
];
const TRUSTED_HOST = 'realworkfromanywhere.com';

/** @param {string} url */
function assertRwfaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`realworkfromanywhere: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`realworkfromanywhere: URL must use HTTPS: ${url}`);
  const host = parsed.hostname.toLowerCase();
  const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
  if (!trusted) {
    throw new Error(`realworkfromanywhere: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

// NaN-safe Date.parse - `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function fallbackCompany(entry) {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Real Work From Anywhere';
}

/** @type {Provider} */
export default {
  id: 'realworkfromanywhere',

  detect(entry) {
    return entry?.provider === 'realworkfromanywhere' ? { url: FEED_URLS[0] } : null;
  },

  async fetch(entry, ctx) {
    const fallback = fallbackCompany(entry);
    const jobs = [];
    for (const url of FEED_URLS) {
      const feedUrl = assertRwfaUrl(url);
      // redirect:'error' prevents SSRF via server-side redirects; combined with
      // assertRwfaUrl above it keeps the request pinned to realworkfromanywhere.com.
      const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
      jobs.push(...parseRwfaFeed(text, fallback));
    }
    return jobs;
  },
};

// Resolve a tag's inner text: unwrap a CDATA section, else decode entities.
function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

// Extract the text of the first <tag>...</tag> in a block. Returns '' when absent.
function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

// Keep only absolute HTTPS links hosted on the trusted board domain.
function cleanUrl(value) {
  if (!value) return '';
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * Parse a Real Work From Anywhere public RSS jobs feed. Exported for unit tests.
 *
 * Shape: `<rss><channel><item>...</item>...</channel></rss>`. Each item
 * exposes `<title>`, `<link>`, `<pubDate>`, `<category>`, and `<author>` --
 * unlike weworkremotely/nodesk, the company is its own tag rather than
 * encoded inside the title, so no title-splitting is needed. There is no
 * dedicated location tag; location stays empty and the board-wide
 * location_filter / titleSignalsRemote fallback in scan.mjs applies.
 *
 * @param {string} xml - raw RSS feed body
 * @param {string} [defaultCompany] - fallback company when <author> is absent/empty
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseRwfaFeed(xml, defaultCompany = 'Real Work From Anywhere') {
  if (typeof xml !== 'string') return [];
  const fallback = typeof defaultCompany === 'string' && defaultCompany.trim() ? defaultCompany.trim() : 'Real Work From Anywhere';
  const jobs = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url) continue;

    const title = tagText(item, 'title');
    if (!title) continue;

    const company = tagText(item, 'author') || fallback;
    const postedAt = toEpochMs(tagText(item, 'pubDate'));
    const job = {
      title,
      company,
      location: '',
      url,
    };
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }

  return jobs;
}
