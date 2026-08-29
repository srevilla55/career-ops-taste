#!/usr/bin/env bash
# What is waiting for you, best first. Read-only, zero tokens.
#
#   ./local/orchestration/today.sh        # top 25 pending
#   ./local/orchestration/today.sh 50     # top 50

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

LIMIT="${1:-25}"

node - "$LIMIT" <<'EOF'
import { readFileSync, existsSync } from 'fs';
import { priorityScore, loadPriorityConfig } from './local/ingest-jobspy.mjs';
import { locationHintFromUrl } from './scan.mjs';

let priority;
try { priority = loadPriorityConfig(undefined, { required: true }); }
catch (err) { console.error(`today: ${err.message}`); process.exit(1); }

// Workday reports a multi-city posting as "8 Locations" and puts only the
// PRIMARY city in the URL path (/job/Milano/...). 40% of some boards look like
// this, and a bare "3 Locations" scores the 0.2 geo fallback — which is how a
// a target-city role ends up at the bottom of the queue.
//
// Partial fix on purpose: the URL names one city, not all of them, so a role
// that spans two cities still ranks as the URL's city. Recovering the full list
// needs a per-job detail fetch, which is not worth it for sort order. Strictly
// better than 0.2 either way.
const MULTI_LOCATION = /^\d+\s+locations?$/i;
function rankableLocation(location, url) {
  if (!MULTI_LOCATION.test(location.trim())) return location;
  const hint = locationHintFromUrl(url);
  return hint || location;
}

const limit = Number(process.argv[2]) || 25;
if (!existsSync('data/pipeline.md')) { console.log('No data/pipeline.md yet — run scan-all.sh first.'); process.exit(0); }

const text = readFileSync('data/pipeline.md', 'utf-8');
const pending = text.split(/^## /m).find(s => /^Pending/i.test(s)) || '';

const rows = [];
for (const line of pending.split('\n')) {
  if (!line.startsWith('- [ ] ')) continue;
  const cols = line.slice(6).split('|').map(s => s.trim());
  const note = cols.find(c => c.startsWith('note:')) || '';
  const prio = Number((note.match(/prio ([0-9.]+)/) || [])[1] ?? -1);
  const src = (note.match(/src:(\S+)/) || [])[1] || 'career-ops';
  const lang = (note.match(/lang:(\S+)/) || [])[1] || '—';
  const posted = (cols.find(c => c.startsWith('posted:')) || '').replace('posted:', '').trim();
  const company = cols[1] || '—';
  const title = cols[2] || '—';
  const location = (cols[3] && !cols[3].startsWith('posted:') && !cols[3].startsWith('note:')) ? cols[3] : '';
  // Scanner rows carry the real URL in column 0; JobSpy rows carry `local:…`
  // there and their URL in the note, but they never say "N Locations" anyway.
  const url = cols[0] || '';
  rows.push({
    src, lang, posted, company, title,
    location: location || '—',
    // The ingest stores prio for JobSpy rows. The native scanner writes none, and
    // those are most of the queue — so compute it here for anything unscored.
    // Same pure function either way, so the whole queue sorts on one scale.
    prio: prio >= 0 ? prio
      : priorityScore(
        { title, location: rankableLocation(location, url), postedAt: posted ? Date.parse(posted) : undefined },
        Date.now(),
        priority,
      ),
  });
}

if (!rows.length) { console.log('Pending queue is empty.'); process.exit(0); }


rows.sort((a, b) => b.prio - a.prio);

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s).padEnd(n);
const bySrc = rows.reduce((m, r) => (m[r.src] = (m[r.src] || 0) + 1, m), {});

console.log(`\nPENDING: ${rows.length}   ${Object.entries(bySrc).map(([k, v]) => `${k}:${v}`).join('  ')}\n`);
console.log(`  ${'PRIO'.padEnd(5)} ${trunc('COMPANY', 24)} ${trunc('ROLE', 42)} ${trunc('LOCATION', 26)} ${'LANG'.padEnd(5)} POSTED`);
console.log('  ' + '─'.repeat(112));
for (const r of rows.slice(0, limit)) {
  const p = r.prio.toFixed(2);
  console.log(`  ${p.padEnd(5)} ${trunc(r.company, 24)} ${trunc(r.title, 42)} ${trunc(r.location, 26)} ${r.lang.padEnd(5)} ${r.posted || '—'}`);
}
if (rows.length > limit) console.log(`\n  … ${rows.length - limit} more. Pass a number to see more.`);
console.log('\nEvaluate with: /career-ops pipeline\n');
EOF
