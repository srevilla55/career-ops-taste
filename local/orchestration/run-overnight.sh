#!/usr/bin/env bash
# run-overnight.sh — the unattended stretch of the pipeline, start to finish.
#
#   hydrate JDs + liveness  ->  triage (gate)  ->  build batch input  ->  full A-G eval
#   ->  merge  ->  reconcile  ->  verify
#
# Every stage is resumable and idempotent, so the only cost of a quota pause is waiting.
# The batch runner parks its work as `paused_rate_limit` and drops a pause file; this
# script sleeps and comes back for it, which is what makes the run survive a plan limit
# without a human awake to restart it.
#
#   CAREER_OPS_BRAIN=codex ./local/orchestration/run-overnight.sh [--skip-hydrate] [--parallel N]

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

PARALLEL=2
SKIP_HYDRATE=false
SLEEP_SECONDS="${OVERNIGHT_SLEEP:-1200}"
MAX_CYCLES="${OVERNIGHT_MAX_CYCLES:-60}"
BRAIN="${CAREER_OPS_BRAIN:-claude}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-hydrate) SKIP_HYDRATE=true; shift ;;
    --brain) [[ $# -ge 2 ]] || { echo "--brain requires claude or codex" >&2; exit 2; }; BRAIN="$2"; shift 2 ;;
    --parallel) [[ $# -ge 2 ]] || { echo "--parallel requires a positive integer" >&2; exit 2; }; PARALLEL="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

case "$BRAIN" in
  claude) RUNNER="./batch/batch-runner.sh"; PAUSE_FILE="batch/batch-runner.paused" ;;
  codex) RUNNER="./batch/codex-runner.sh"; PAUSE_FILE="batch/codex-runner.paused" ;;
  *) echo "--brain must be claude or codex" >&2; exit 2 ;;
esac
[[ "$PARALLEL" =~ ^[1-9][0-9]*$ ]] || { echo "--parallel must be a positive integer" >&2; exit 2; }

say() { echo; echo "=== $(date '+%H:%M:%S') — $* ==="; }

# Claude workers run from the real repository with --safe-mode (set inside batch-runner.sh
# and triage-all.mjs). career-ops/CLAUDE.md is a one-line `@AGENTS.md` import and Claude Code
# auto-discovers it from the worker's cwd: measured at **15,815 tokens on every request**
# (52,240 vs 37,639). The six SessionStart plugin hooks added another 21,264 bytes
# (~5,300 tokens) per request on top.
#
# This used to be solved with a symlink shadow root that simply lacked CLAUDE.md, because
# --bare forces ANTHROPIC_API_KEY auth and this is an OAuth plan. --safe-mode suppresses
# CLAUDE.md discovery AND every plugin hook while auth, built-in tools and permissions keep
# working -- strictly better, since the shadow root symlinked .claude and could never stop
# the hooks. Canary on offer 7: cache creation 111,816 -> 66,535, $1.46 -> $1.04, same 3.1/5.

# Offers in batch-input that batch-state has not finished with yet.
remaining_work() {
  node - <<'EOF'
import { readFileSync, existsSync } from 'fs';
const ids = new Set();
for (const l of readFileSync('batch/batch-input.tsv', 'utf-8').split('\n')) {
  if (!l.trim() || l.startsWith('id\t')) continue;
  ids.add(l.split('\t')[0]);
}
if (existsSync('batch/batch-state.tsv')) {
  for (const l of readFileSync('batch/batch-state.tsv', 'utf-8').split('\n')) {
    if (!l.trim() || l.startsWith('id\t')) continue;
    const c = l.split('\t');
    if (c[2] === 'completed' || c[2] === 'skipped') ids.delete(c[0]);
  }
}
console.log(ids.size);
EOF
}

if [[ "$SKIP_HYDRATE" == "false" ]]; then
  say "hydrate JDs + liveness sweep (zero tokens)"
  node local/orchestration/hydrate-jds.mjs --concurrency 5
fi

run_evaluation() {
  local cycle=0
  cycle=0
  while (( cycle < MAX_CYCLES )); do
    cycle=$((cycle + 1))

    # A worker that finished its report and THEN hit the session limit leaves its row
    # non-terminal with a report already on disk. --resume-paused re-runs that row and
    # hands it a fresh report number, so the same offer gets evaluated twice — one full
    # evaluation of pure waste per quota pause, plus an orphan report. That is exactly how
    # reports 041 and 043 both became Invox Medical.
    #
    # So reconcile disk against state BEFORE resuming. No workers are alive at this point
    # in the cycle, which is the condition the guard itself checks for.
    node local/orchestration/resume-batch-state.mjs || true

    # Unstick anything a previous cycle parked on a quota limit. No-op when there is none.
    "$RUNNER" --parallel "$PARALLEL" --skip-pdf --resume-paused || true
    # Then take a normal pass at whatever is still pending.
    "$RUNNER" --parallel "$PARALLEL" --skip-pdf || true

    left="$(remaining_work)"
    if [[ "$left" == "0" ]]; then
      echo "--- all offers terminal after cycle $cycle"
      break
    fi
    if [[ -f "$PAUSE_FILE" ]]; then
      echo "--- cycle $cycle: quota limit, $left offer(s) left."
      echo "    sleeping ${SLEEP_SECONDS}s"
      sleep "$SLEEP_SECONDS"
    else
      echo "--- cycle $cycle: $left offer(s) left (failed/retrying). Sleeping ${SLEEP_SECONDS}s."
      sleep "$SLEEP_SECONDS"
    fi
  done
}

# Order matters, and it is not the obvious one.
#
# Triage is cheap per role but there are hundreds of them; evaluation is expensive per
# role but there are dozens. Running the whole gate first means a constrained quota gets
# spent entirely on *deciding what to do* and runs out before doing any of it — which is
# exactly what happened on the 12:00 run: 20 roles triaged, zero applications produced.
#
# So: evaluate what already qualifies, THEN spend what is left triaging the rest. Value
# lands first, and the queue is still fully explored if quota allows.

say "build batch input from roles already triaged"
node local/orchestration/build-batch-input.mjs --prune

say "full A-G evaluation (already-qualified roles)"
run_evaluation

say "triage — pre-screen gate over the roles not yet scored"
# Count before and after. A stage that scores nothing while roles are still unscored is a
# failure, but it looks exactly like success in a log — which is how a broken entry-module
# guard turned triage into a silent no-op for several full runs while the log kept saying
# the stage had "run". Never trust a stage that produced no output; check what it changed.
verdicts_before="$(wc -l < data/triage-verdicts.tsv)"
node local/orchestration/triage-all.mjs --brain "$BRAIN" --concurrency 2
verdicts_after="$(wc -l < data/triage-verdicts.tsv)"
unscored="$(node -e '
const { readFileSync } = require("fs");
const done = new Set(readFileSync("data/triage-verdicts.tsv","utf8").split("\n").filter(Boolean).map(l=>l.split("\t")[0]));
let n = 0;
for (const l of readFileSync("data/pipeline.md","utf8").split("\n"))
  if (l.startsWith("- [ ] ") && !done.has(l.slice(6).split("|")[0].trim())) n++;
console.log(n);' 2>/dev/null || echo 0)"
if [[ "$verdicts_after" == "$verdicts_before" && "$unscored" != "0" ]]; then
  echo "!!! triage scored 0 of $unscored unscored role(s) — the stage did nothing. Not a quota pause." >&2
  echo "!!! Check that triage-all.mjs runs from this cwd: node local/orchestration/triage-all.mjs --demo" >&2
fi

say "rebuild batch input with the newly-triaged survivors"
node local/orchestration/build-batch-input.mjs --prune

say "full A-G evaluation (second pass)"
run_evaluation

say "merge / reconcile / verify"
# Workers that resolved a `local:jds/...` token write that token into the report's URL
# header. Swap in the posting's real Original URL before it reaches the tracker.
node local/orchestration/fix-report-urls.mjs || true
node merge-tracker.mjs || true
node reconcile-pipeline.mjs || true
node verify-pipeline.mjs

say "done — $(node -e "
const {readFileSync,existsSync}=require('fs');
const f='data/applications.md';
console.log(existsSync(f)?readFileSync(f,'utf8').split('\n').filter(l=>/^\|\s*\d+/.test(l)).length:0);
") tracker row(s). Next: application packets."
