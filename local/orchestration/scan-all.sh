#!/usr/bin/env bash
# Daily discovery run. Zero tokens — no model is called anywhere in here.
#
#   career-ops scanner (55+ ATS/board providers)
#   + JobSpy (LinkedIn / Indeed; Glassdoor remains available as an explicit probe)
#   -> filter -> dedupe -> data/pipeline.md
#   The default window starts at the newer full success or explicitly accepted cutoff.
#   JOBSPY_HOURS=N overrides it; --since-last-scan forces the automatic window.
#
# Evaluation is deliberately NOT part of this. Run `/career-ops pipeline` when
# you want to spend tokens on the roles that survived.
#
# Not scheduled automatically. Configure a scheduler after a manual run works.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LAST_SUCCESS=data/scan-all-last-success
HOURS="${JOBSPY_HOURS:-}"
SCAN_ARGS=(--verify)
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--since-last-scan" ]; }; then
  echo "Usage: $0 [--since-last-scan]" >&2
  exit 2
fi
if [ "${1:-}" = "--since-last-scan" ]; then HOURS=""; fi
# Read only this pacing key; dotenv.parse never exports Gmail credentials to scrapers.
LINKEDIN_DELAY="$(node --input-type=module - <<'EOF'
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
const value = process.env.JOBSPY_LINKEDIN_DELAY ??
  (existsSync('.env') ? parse(readFileSync('.env')).JOBSPY_LINKEDIN_DELAY : undefined) ?? '65';
const seconds = Number(value);
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) {
  console.error('JOBSPY_LINKEDIN_DELAY must be greater than 0 and at most 300 seconds');
  process.exit(2);
}
console.log(seconds);
EOF
)" || exit 2
export JOBSPY_LINKEDIN_DELAY="$LINKEDIN_DELAY"
if [ -z "$HOURS" ]; then
  if [ -s "$LAST_SUCCESS" ]; then
    read -r LAST_SCAN < "$LAST_SUCCESS"
  else
    # Bootstrap from the last broad ATS run; ignore later single-board retries.
    LAST_SCAN="$(awk -F '\t' '$2 == "completed" && $3 > 0 && $4 > 0 { time = $1 } END { print time }' data/scan-runs.tsv)"
  fi
  if [ -e data/scan-all-accepted-through.json ]; then
    ACCEPTED_SCAN="$(node --input-type=module - <<'EOF'
import {readFileSync} from 'node:fs';
const record = JSON.parse(readFileSync('data/scan-all-accepted-through.json', 'utf8'));
const stamp = record.accepted_through;
if (record.status !== 'accepted_with_gaps' || typeof stamp !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(stamp) ||
    !Number.isFinite(Date.parse(stamp)) || Date.parse(stamp) > Date.now() ||
    new Date(stamp.slice(0, 19) + 'Z').toISOString().slice(0, 19) !== stamp.slice(0, 19)) {
  throw new Error('Invalid or future accepted scan cutoff');
}
console.log(new Date(stamp).toISOString());
EOF
    )" || exit 1
    if [ -z "$LAST_SCAN" ] || [ "$(date -u -d "$ACCEPTED_SCAN" +%s)" -gt "$(date -u -d "$LAST_SCAN" +%s)" ]; then
      LAST_SCAN="$ACCEPTED_SCAN"
    fi
  fi
  if [ -n "$LAST_SCAN" ]; then
    LAST_EPOCH="$(date -u -d "$LAST_SCAN" +%s)" || exit 1
    NOW_EPOCH="$(date -u +%s)"
    if [ "$LAST_EPOCH" -gt "$NOW_EPOCH" ]; then
      echo "Last completed scan is in the future: $LAST_SCAN" >&2
      exit 1
    fi
    # One hour of overlap covers the bootstrap ATS scan; dedup absorbs repeats.
    HOURS="$(( ( NOW_EPOCH - LAST_EPOCH + 3599 ) / 3600 + 1 ))"
    SCAN_ARGS+=(--posted-after "${LAST_SCAN%%T*}")
  elif [ "${1:-}" = "--since-last-scan" ]; then
    echo "No completed scan found" >&2
    exit 1
  else
    HOURS=96
  fi
fi
if ! [[ "$HOURS" =~ ^[1-9][0-9]*$ ]]; then
  echo "JOBSPY_HOURS must be a positive whole number" >&2
  exit 2
fi
# The configured four-day cutoff must not discard jobs from this window.
export SCAN_MAX_POSTING_AGE_DAYS="$(( ( HOURS + 23 ) / 24 + 1 ))"
SITES="${JOBSPY_SITES:-indeed,linkedin}"   # Glassdoor/Google quarantined: see local/README.md
TMP="$(mktemp -t jobspy-XXXXXX.json)"
SCAN_RECEIPT="$(mktemp -t ats-receipt-XXXXXX.json)"
HEALTH_RECEIPT="$(mktemp -t jobspy-health-XXXXXX.json)"
GMAIL_RECEIPT="$(mktemp -t gmail-health-XXXXXX.txt)"
trap 'rm -f "$TMP" "$SCAN_RECEIPT" "$HEALTH_RECEIPT" "$GMAIL_RECEIPT"' EXIT

echo "=== $(date '+%Y-%m-%d %H:%M:%S') — career-ops discovery ==="

echo
echo "--- [1/4] career-ops scanner ---"
# --verify launches Playwright after the API pass to drop postings the ATS still
# serves but has actually closed. Sequential and new-offers-only, so it stays cheap.
SCAN_OK=1
# JSON mode retains human logs on stderr and reports provider failures through
# both the receipt and exit status; plain scan mode can exit 0 on partial data.
node scan.mjs "${SCAN_ARGS[@]}" --json > "$SCAN_RECEIPT" || { echo "! scanner incomplete — continuing to JobSpy"; SCAN_OK=0; }
node --input-type=module - "$SCAN_RECEIPT" <<'EOF' || SCAN_OK=0
import { readFileSync } from 'node:fs';
const receipt = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (receipt.version !== 'careerops.scan.receipt@1' || receipt.dry_run !== false ||
    !Array.isArray(receipt.errors) || !Array.isArray(receipt.unverified_zero)) {
  throw new Error('Missing or invalid ATS receipt');
}
console.log(`ATS receipt: ${receipt.found} found, ${receipt.added} added, ${receipt.errors.length} errors, ${receipt.unverified_zero.length} unverified empty boards`);
process.exitCode = receipt.errors.length || receipt.unverified_zero.length ? 1 : 0;
EOF

echo
echo "--- [2/4] JobSpy (${SITES}, last ${HOURS}h) ---"
# One scrape call per site inside the shim, so a blocked or broken site costs
# only its own results instead of taking the whole run down.
JOBSPY_OK=1
JOBSPY_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if (cd local && uv run --quiet --locked jobspy_fetch.py --hours "$HOURS" --sites "$SITES" --health-file "$HEALTH_RECEIPT" --linkedin-state ../data/linkedin-discovery.json) > "$TMP"; then
  echo "JobSpy returned $(wc -c < "$TMP") bytes"
  echo
  echo "--- [3/4] ingest ---"
  node local/ingest-jobspy.mjs --file "$TMP" || exit 1
else
  echo "! JobSpy failed — skipping ingest, continuing to repair"
  JOBSPY_OK=0
fi

echo
echo "--- [4/4] repair postings missing JD text or a location ---"
# Existing incomplete rows need repair: dedup will not re-offer their URLs.
# LinkedIn repairs reuse captured JD text only; no guest detail-page retries.
REPAIR="$(mktemp -t jobspy-repair-XXXXXX.txt)"
DESC="$(mktemp -t jobspy-desc-XXXXXX.json)"
trap 'rm -f "$TMP" "$SCAN_RECEIPT" "$HEALTH_RECEIPT" "$GMAIL_RECEIPT" "$REPAIR" "$DESC"' EXIT

node - "$HEALTH_RECEIPT" "$SITES" "$JOBSPY_STARTED_AT" > "$REPAIR" <<'EOF' || exit 1
import { readFileSync } from 'fs';
import { locationSlot } from './local/apply-descriptions.mjs';
let health = {};
try { health = JSON.parse(readFileSync(process.argv[2], 'utf8')); } catch { /* fail closed for LinkedIn */ }
const linkedin = health.linkedin;
const allowLinkedIn = process.argv[3].split(',').map(site => site.trim()).includes('linkedin') &&
  Date.parse(health._checked_at) >= Date.parse(process.argv[4]) &&
  linkedin && linkedin.requests_failed === 0 && linkedin.queries_failed === 0;
let linkedinSkipped = 0;
for (const line of readFileSync('data/pipeline.md', 'utf-8').split('\n')) {
  if (!line.startsWith('- [ ] ') || !/\bsrc:/.test(line)) continue;
  const noText = /\blang:unknown\b/.test(line);
  const noLoc = !locationSlot(line).present;
  if (!noText && !noLoc) continue;
  const m = line.match(/\burl:(\S+)\s*$/);
  if (!m) continue;
  if (!allowLinkedIn && /^https?:\/\/(?:[^/]+\.)?linkedin\.com\//i.test(m[1])) {
    linkedinSkipped++;
    continue;
  }
  console.log(m[1]);
}
if (linkedinSkipped) console.error(`${linkedinSkipped} LinkedIn repair(s) deferred — source failed or was not selected`);
EOF

COUNT="$(wc -l < "$REPAIR" | tr -d ' ')"
REPAIR_OK=1
if [ "${COUNT:-0}" -gt 0 ]; then
  echo "$COUNT posting(s) to repair — fetching"
  if (cd local && uv run --quiet --locked python hydrate-descriptions.py) < "$REPAIR" > "$DESC"; then
    node local/apply-descriptions.mjs --file "$DESC" || REPAIR_OK=0
  else
    REPAIR_RC=$?
    REPAIR_OK=0
    if [ "$REPAIR_RC" -eq 2 ]; then
      node local/apply-descriptions.mjs --file "$DESC" || exit 1
      echo "! repair incomplete after HTTP/network failure or LinkedIn limit — completed repairs saved"
    else
      echo "! could not fetch anything — leaving those rows as they are"
    fi
  fi
else
  echo "none eligible for repair in this run"
fi

GMAIL_OK=1
GMAIL_DAILY=0
if [ -e config/plugins.yml ]; then
  GMAIL_DAILY="$(node --input-type=module - <<'EOF'
import { readFileSync } from 'node:fs';
import { loadYaml } from './lib/yaml-document.mjs';
const gmail = loadYaml(readFileSync('config/plugins.yml', 'utf8'))?.plugins?.gmail;
console.log(gmail?.enabled === true && gmail.linkedin_alerts === true &&
  gmail.daily_verified === true ? '1' : '0');
EOF
  )" || exit 1
fi
if [ "$GMAIL_DAILY" = 1 ]; then
  echo
  echo "--- [optional] verified Gmail LinkedIn alerts ---"
  GMAIL_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node plugins.mjs run gmail > "$GMAIL_RECEIPT" || GMAIL_OK=0
  cat "$GMAIL_RECEIPT"
  node --input-type=module - "$GMAIL_RECEIPT" "$GMAIL_STARTED_AT" <<'EOF' || GMAIL_OK=0
import { readFileSync } from 'node:fs';
const line = readFileSync(process.argv[2], 'utf8').split('\n').findLast(line => line.startsWith('Gmail receipt: '));
const receipt = line ? JSON.parse(line.slice('Gmail receipt: '.length)) : null;
if (receipt?.version !== 'careerops.gmail.receipt@1' || receipt.dry_run !== false ||
    receipt.coverage_complete !== true || !Number.isFinite(Date.parse(receipt.checked_at)) ||
    Date.parse(receipt.checked_at) < Date.parse(process.argv[3])) process.exitCode = 1;
EOF
fi

if [ "$SCAN_OK" -ne 1 ] || [ "$JOBSPY_OK" -ne 1 ] || [ "$REPAIR_OK" -ne 1 ] || [ "$GMAIL_OK" -ne 1 ]; then
  echo "! scanner, JobSpy, repair or selected Gmail import incomplete — leaving $LAST_SUCCESS unchanged"
  exit 1
fi
if ! node --input-type=module - "$SITES" "$HEALTH_RECEIPT" "$JOBSPY_STARTED_AT" <<'EOF'
import { readFileSync } from 'node:fs';
const health = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const checked = Date.parse(health._checked_at);
if (!Number.isFinite(checked) || checked < Date.parse(process.argv[4])) {
  throw new Error('Missing or stale JobSpy health receipt');
}
process.exit(process.argv[2].split(',').some(site =>
  health[site.trim()]?.coverage_complete !== true ||
  health[site.trim()]?.status !== 'healthy' ||
  health[site.trim()]?.queries_failed !== 0 ||
  ![0, null].includes(health[site.trim()]?.requests_failed)) ? 1 : 0);
EOF
then
  echo "! provider coverage incomplete — leaving $LAST_SUCCESS unchanged"
  exit 1
fi
STAMP_TMP="$(mktemp data/.scan-all-last-success.XXXXXX)" || exit 1
printf '%s\n' "$RUN_STARTED_AT" > "$STAMP_TMP" || exit 1
mv "$STAMP_TMP" "$LAST_SUCCESS" || exit 1

echo
echo "=== done $(date '+%H:%M:%S') ==="
echo "Next: ./local/orchestration/today.sh  — then /career-ops pipeline to evaluate."
