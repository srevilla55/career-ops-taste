#!/usr/bin/env bash
set -euo pipefail

# Run exactly one existing batch offer in a disposable copy. node_modules is the
# only shared writable path; this script never runs commands that mutate it.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
OFFER_IDS=()
ARTIFACTS_DIR=""

validate_metrics() {
  node --input-type=module - "$1" "${2:-1}" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
// Expected worker count: one shim invocation per offer. Reported separately so a
// two-offer run keeps worker 1 (cache cold) distinguishable from worker 2 (cache warm)
// -- that split is the cross-worker cache measurement, not a detail.
const expected = Number(process.argv[3] || 1);
const files = fs.readdirSync(dir).filter(name => name.endsWith('.metrics.json')).sort();
if (files.length !== expected) {
  console.error(`ERROR: expected ${expected} shim metrics JSON file(s), found ${files.length}`);
  process.exit(1);
}

let anyFailure = false;
files.forEach((file, index) => {
const metrics = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const tokenTotal = value => {
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((sum, [key, item]) => {
    if (typeof item === 'number') return sum + (/token/i.test(key) ? item : 0);
    return sum + tokenTotal(item);
  }, 0);
};
const failures = [];
if (metrics.exitCode !== 0) failures.push(`exitCode=${metrics.exitCode}`);
if (metrics.errorEnvelopeCount > 0) failures.push(`errorEnvelopeCount=${metrics.errorEnvelopeCount}`);
if (metrics.parseErrors > 0) failures.push(`parseErrors=${metrics.parseErrors}`);
if (!Number.isInteger(metrics.forbiddenAccessCount) || metrics.forbiddenAccessCount < 0) {
  failures.push(`invalid forbiddenAccessCount=${metrics.forbiddenAccessCount}`);
} else if (metrics.forbiddenAccessCount !== 0) {
  failures.push(`forbiddenAccessCount=${metrics.forbiddenAccessCount}`);
}
const tokens = tokenTotal(metrics.usage);
if (!metrics.usage || tokens <= 0) failures.push(`usage token total=${tokens}`);
if (failures.length) {
  console.error(`ERROR: worker ${index + 1} invalid canary metrics (${failures.join(', ')})`);
  anyFailure = true;
  return;
}
const u = metrics.usage || {};
console.error(`worker ${index + 1} valid: tokens=${tokens} creation=${u.cache_creation_input_tokens} `
  + `read=${u.cache_read_input_tokens} turns=${metrics.numTurns} tools=${metrics.toolCount}`);
});
if (anyFailure) process.exit(1);
NODE
}

if [[ "${1:-}" == "--validate-metrics-dir" ]]; then
  [[ $# -eq 2 || $# -eq 3 ]] || { echo "ERROR: --validate-metrics-dir requires a directory and an optional worker count" >&2; exit 2; }
  validate_metrics "$2" "${3:-1}"
  exit
fi

usage() {
  cat <<'EOF'
Usage: run-batch-canary.sh --offer-id ID [--offer-id ID ...] [--artifacts-dir DIR]
                           [-- batch-runner options]

Runs the named rows from live batch/batch-input.tsv in one isolated copy with:
  --parallel 1 --limit <number of offers> --skip-pdf

Repeat --offer-id to process several offers sequentially in ONE sandbox. That is
the only way to measure cross-worker prefix cache reuse: separate sandboxes have
different cwds, so they would report a cache miss caused by the harness itself.

All arguments after -- are passed to batch-runner.sh. Do not pass options that
change parallelism, limit, or PDF behavior.

Artifacts are retained outside the sandbox and may contain profile-derived
content. Review them, then delete that exact artifact directory manually.
EOF
}

RUNNER_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --offer-id) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; OFFER_IDS+=("$2"); shift 2 ;;
    --artifacts-dir) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; ARTIFACTS_DIR="$2"; shift 2 ;;
    --) shift; RUNNER_ARGS=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

(( ${#OFFER_IDS[@]} > 0 )) || { echo "ERROR: at least one --offer-id is required" >&2; exit 2; }
for id in "${OFFER_IDS[@]}"; do
  [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ERROR: --offer-id must be a simple ID: $id" >&2; exit 2; }
done
mapfile -t UNIQUE_IDS < <(printf '%s\n' "${OFFER_IDS[@]}" | sort -u)
(( ${#UNIQUE_IDS[@]} == ${#OFFER_IDS[@]} )) || { echo "ERROR: duplicate --offer-id values" >&2; exit 2; }
for arg in "${RUNNER_ARGS[@]}"; do
  case "$arg" in --parallel|--limit|--skip-pdf) echo "ERROR: $arg is fixed by the canary harness" >&2; exit 2 ;; esac
done

INPUT="$ROOT/batch/batch-input.tsv"
[[ -f "$INPUT" ]] || { echo "ERROR: missing $INPUT" >&2; exit 1; }
OFFER_LINES=()
for id in "${OFFER_IDS[@]}"; do
  line="$(awk -F '\t' -v id="$id" '$1 == id { print; exit }' "$INPUT")"
  [[ -n "$line" ]] || { echo "ERROR: offer ID $id not found in $INPUT" >&2; exit 1; }
  OFFER_LINES+=("$line")
done

REAL_CLAUDE="$(command -v claude || true)"
[[ -n "$REAL_CLAUDE" ]] || { echo "ERROR: claude not found in PATH" >&2; exit 1; }
REAL_CLAUDE="$(readlink -f "$REAL_CLAUDE")"
[[ -x "$REAL_CLAUDE" ]] || { echo "ERROR: resolved Claude is not executable: $REAL_CLAUDE" >&2; exit 1; }
command -v rsync >/dev/null || { echo "ERROR: rsync is required" >&2; exit 1; }

if [[ -z "$ARTIFACTS_DIR" ]]; then
  ARTIFACTS_DIR="$ROOT/local/canary-results/$(date -u +%Y%m%dT%H%M%SZ)-offer-$(IFS=-; echo "${OFFER_IDS[*]}")"
elif [[ "$ARTIFACTS_DIR" != /* ]]; then
  ARTIFACTS_DIR="$PWD/$ARTIFACTS_DIR"
fi
mkdir -p "$ARTIFACTS_DIR/metrics" "$ARTIFACTS_DIR/runtime"
ARTIFACTS_DIR="$(cd "$ARTIFACTS_DIR" && pwd -P)"
chmod 700 "$ARTIFACTS_DIR" "$ARTIFACTS_DIR/metrics" "$ARTIFACTS_DIR/runtime"

CANARY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/career-ops-canary.XXXXXX")"
cleanup() { rm -rf -- "$CANARY_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

SANDBOX_ROOT="$CANARY_DIR/repo"
mkdir -p "$SANDBOX_ROOT"
rsync -a \
  --exclude '/.git/***' \
  --exclude '/graphify-out/***' \
  --exclude '/local/.venv/***' \
  --exclude '/local/canary-results/***' \
  --exclude '/node_modules' \
  --exclude '/reports/***' \
  --exclude '/output/***' \
  --exclude '/batch/batch-input.tsv' \
  --exclude '/batch/batch-state.tsv' \
  --exclude '/batch/logs/***' \
  --exclude '/batch/tracker-additions/***' \
  --exclude '/batch/batch-runner.pid' \
  --exclude '/batch/batch-runner.paused' \
  --exclude '/batch/.batch-state.lock/***' \
  --exclude '/batch/.resolved-prompt-*.md' \
  --exclude '/batch/.triage-system.md' \
  "$ROOT/" "$SANDBOX_ROOT/"

[[ -d "$ROOT/node_modules" ]] || { echo "ERROR: missing live node_modules" >&2; exit 1; }
ln -s "$ROOT/node_modules" "$SANDBOX_ROOT/node_modules"
mkdir -p "$SANDBOX_ROOT/reports" "$SANDBOX_ROOT/output" \
  "$SANDBOX_ROOT/batch/logs" "$SANDBOX_ROOT/batch/tracker-additions" "$CANARY_DIR/tmp" "$CANARY_DIR/bin"
printf 'id\turl\tsource\tnotes\n' > "$SANDBOX_ROOT/batch/batch-input.tsv"
printf '%s\n' "${OFFER_LINES[@]}" >> "$SANDBOX_ROOT/batch/batch-input.tsv"

ln -s "$SANDBOX_ROOT/local/orchestration/claude-canary-shim.mjs" "$CANARY_DIR/bin/claude"
# Workers run from the sandbox itself; batch-runner.sh passes --safe-mode, so there is
# no shadow root to build and nothing for the shim to add.
RUN_ROOT="$SANDBOX_ROOT"
CANARY_SAFE_MODE_MARKER=0

set +e
(
  cd "$RUN_ROOT"
  PATH="$CANARY_DIR/bin:$PATH" \
  TMPDIR="$CANARY_DIR/tmp" \
  CANARY_REAL_CLAUDE="$REAL_CLAUDE" \
  CANARY_METRICS_DIR="$ARTIFACTS_DIR/metrics" \
  CANARY_SAFE_MODE="$CANARY_SAFE_MODE_MARKER" \
    ./batch/batch-runner.sh --parallel 1 --limit "${#OFFER_IDS[@]}" --skip-pdf "${RUNNER_ARGS[@]}"
) >"$ARTIFACTS_DIR/runner.log" 2>&1
RUN_EXIT=$?
set -e

EFFECTIVE_EXIT="$RUN_EXIT"
if ! validate_metrics "$ARTIFACTS_DIR/metrics" "${#OFFER_IDS[@]}"; then
  EFFECTIVE_EXIT=1
fi

for relative in reports output batch/logs batch/tracker-additions; do
  mkdir -p "$ARTIFACTS_DIR/runtime/$relative"
  rsync -a "$SANDBOX_ROOT/$relative/" "$ARTIFACTS_DIR/runtime/$relative/"
done
for relative in batch/batch-state.tsv batch/batch-input.tsv; do
  [[ -f "$SANDBOX_ROOT/$relative" ]] || continue
  mkdir -p "$ARTIFACTS_DIR/runtime/$(dirname "$relative")"
  cp "$SANDBOX_ROOT/$relative" "$ARTIFACTS_DIR/runtime/$relative"
done
printf '%s\n' "$EFFECTIVE_EXIT" > "$ARTIFACTS_DIR/exit-code"
printf 'canary artifacts retained: %s\n' "$ARTIFACTS_DIR"
printf 'review them, then delete that exact directory manually when no longer needed\n'
exit "$EFFECTIVE_EXIT"
