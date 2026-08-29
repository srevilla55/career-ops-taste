#!/usr/bin/env bash
# Daily discovery run. Zero tokens — no model is called anywhere in here.
#
#   career-ops scanner (55+ ATS/board providers)
#   + JobSpy (LinkedIn / Indeed / Glassdoor — the boards career-ops has no provider for)
#   -> filter -> dedupe -> data/pipeline.md
#
# Evaluation is deliberately NOT part of this. Run `/career-ops pipeline` when
# you want to spend tokens on the roles that survived.
#
# Not scheduled anywhere. Add your own scheduler only after a manual run works.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

TMP="$(mktemp -t jobspy-XXXXXX.json)"
trap 'rm -f "$TMP"' EXIT

echo "=== $(date '+%Y-%m-%d %H:%M:%S') — career-ops discovery ==="

echo
echo "--- [1/4] career-ops scanner ---"
# --verify launches Playwright after the API pass to drop postings the ATS still
# serves but has actually closed. Sequential and new-offers-only, so it stays cheap.
node scan.mjs --verify || echo "! scanner exited non-zero — continuing to JobSpy"

echo
echo "--- [2/4] JobSpy (local/search.json) ---"
# One scrape call per site inside the shim, so a blocked or broken site costs
# only its own results instead of taking the whole run down.
if (cd local && uv run --quiet jobspy_fetch.py) > "$TMP"; then
  echo "JobSpy returned $(wc -c < "$TMP") bytes"
else
  echo "! JobSpy returned nothing (all sites blocked or no matches). Skipping ingest."
  echo "=== done $(date '+%H:%M:%S') ==="
  exit 0
fi

echo
echo "--- [3/4] ingest ---"
node local/ingest-jobspy.mjs --file "$TMP"

echo
echo "--- [4/4] repair postings missing JD text or a location ---"
# Both are captured at scrape time, so this normally finds nothing. It exists
# because a mid-run LinkedIn rate-limit leaves stubs behind, and dedup will
# never re-offer those URLs — they can only be repaired by direct fetch.
REPAIR="$(mktemp -t jobspy-repair-XXXXXX.txt)"
DESC="$(mktemp -t jobspy-desc-XXXXXX.json)"
trap 'rm -f "$TMP" "$REPAIR" "$DESC"' EXIT

node - > "$REPAIR" <<'EOF'
import { readFileSync } from 'fs';
import { locationSlot } from './local/apply-descriptions.mjs';
for (const line of readFileSync('data/pipeline.md', 'utf-8').split('\n')) {
  if (!line.startsWith('- [ ] ') || !/\bsrc:/.test(line)) continue;
  const noText = /\blang:unknown\b/.test(line);
  const noLoc = !locationSlot(line).present;
  if (!noText && !noLoc) continue;
  const m = line.match(/\burl:(\S+)\s*$/);
  if (m) console.log(m[1]);
}
EOF

COUNT="$(wc -l < "$REPAIR" | tr -d ' ')"
if [ "${COUNT:-0}" -gt 0 ]; then
  echo "$COUNT posting(s) to repair — fetching"
  if (cd local && uv run --quiet python hydrate-descriptions.py) < "$REPAIR" > "$DESC"; then
    node local/apply-descriptions.mjs --file "$DESC"
  else
    echo "! could not fetch anything — leaving those rows as they are"
  fi
else
  echo "none — every posting has JD text and a location"
fi

echo
echo "=== done $(date '+%H:%M:%S') ==="
echo "Next: ./local/orchestration/today.sh  — then /career-ops pipeline to evaluate."
