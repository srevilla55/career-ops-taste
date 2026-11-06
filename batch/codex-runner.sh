#!/usr/bin/env bash
set -euo pipefail

# career-ops codex runner — sibling to batch-runner.sh for `codex exec` workers
# instead of `claude -p` ones. Reads the SAME batch-input.tsv and
# batch-state.tsv as batch-runner.sh (state-file locking is already
# mkdir-based and safe across independent processes) so a single offer
# queue can be split across two LLM brains -- e.g. run this alongside
# batch-runner.sh when Claude usage is tight. Uses its OWN lock file
# (codex-runner.pid) and OWN pause file (codex-runner.paused) so the two
# runners never block each other on "another runner is already running"
# or on one CLI's rate limit pausing the other's queue.
#
# All spend tiers use GPT-6.1 Sol at high reasoning for evaluation.
# Keep spend_tier_to_model() below in sync with the Codex row in
# modes/_shared.md.
#
# Codex workers use an ephemeral, user-config-free workspace-write sandbox. The
# prompt is sent over stdin so large JDs never hit Linux's argv size limit or
# appear in the process list.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BATCH_DIR="$SCRIPT_DIR"
INPUT_FILE="$BATCH_DIR/batch-input.tsv"
STATE_FILE="$BATCH_DIR/batch-state.tsv"
PROMPT_FILE="$BATCH_DIR/batch-prompt.md"
# Separate from batch-runner.sh's .resolved-prompt-run.md so the two runners
# never clobber each other's resolved prompt file while running concurrently.
RUN_PROMPT="$BATCH_DIR/.resolved-prompt-run-codex.md"
PROFILE_FILE="$PROJECT_DIR/config/profile.yml"
LOGS_DIR="$BATCH_DIR/logs"
DISCARD_LOG="$LOGS_DIR/discard.log"
TRACKER_DIR="$BATCH_DIR/tracker-additions"
REPORTS_DIR="$PROJECT_DIR/reports"
APPLICATIONS_FILE="$PROJECT_DIR/data/applications.md"
LOCK_FILE="$BATCH_DIR/codex-runner.pid"
PAUSE_FILE="$BATCH_DIR/codex-runner.paused"
STATE_LOCK_DIR="$BATCH_DIR/.batch-state.lock"
STATE_LOCK_PID_FILE="$STATE_LOCK_DIR/pid"
STATE_LOCK_TIMEOUT_SECONDS=30
MAIN_PID="${BASHPID:-$$}"

# Defaults
PARALLEL=1
DRY_RUN=false
RETRY_FAILED=false
RESUME_PAUSED=false
START_FROM=0
MAX_RETRIES=2
MIN_SCORE=0
SKIP_PDF=false
MODEL=""  # explicit override; otherwise resolved from config/profile.yml spend_tier
RESOLVED_MODEL=""
RESOLVED_SPEND_TIER=""
RATE_LIMIT_SLEEP=300
BATCH_PAUSED=false
STATUS_ONLY=false
WATCH_MODE=false
LIMIT=0

# Return success for non-negative integer or decimal strings.
is_decimal_number() {
  [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]
}

usage() {
  cat <<'USAGE'
career-ops codex runner — process job offers in batch via `codex exec` workers
Uses spend_tier from config/profile.yml unless --model overrides it.
Shares batch-input.tsv / batch-state.tsv with batch-runner.sh -- run both
concurrently to split one offer queue across Claude and Codex.

Usage: codex-runner.sh [OPTIONS]

Options:
  --parallel N         Number of parallel workers (default: 1)
  --dry-run            Show what would be processed, don't execute
  --retry-failed       Only retry offers marked as "failed" in state
  --resume-paused      Resume offers paused by a Codex session/rate limit
  --start-from N       Start from offer ID N (skip earlier IDs)
  --limit N            Max number of offers to process in this run
  --max-retries N      Max retry attempts per offer (default: 2)
  --min-score N        Skip PDF/tracker for offers scoring below N (default: 0 = off)
  --skip-pdf           Skip PDF generation entirely (write ❌ in tracker PDF column)
  --rate-limit-sleep N Seconds to wait before retrying a rate-limited worker
                       (default: 300)
  --model NAME         Override the tier-resolved model passed to
                       `codex exec --model` (otherwise uses config/profile.yml
                       spend_tier: economy/standard/premium; default standard)
  --status             Show batch progress and a per-job table, then exit
  --watch              Live-refresh progress until the run completes
  -h, --help           Show this help

Files:
  batch-input.tsv      Input offers, shared with batch-runner.sh
  batch-state.tsv      Processing state, shared with batch-runner.sh (auto-managed)
  batch-prompt.md      Prompt template for workers, shared with batch-runner.sh
  logs/                Per-offer logs
  tracker-additions/   Tracker lines for post-batch merge

Examples:
  # Dry run to see pending offers
  ./codex-runner.sh --dry-run

  # Process all pending
  ./codex-runner.sh

  # Run alongside batch-runner.sh to split the queue across both brains
  ./batch-runner.sh --parallel 2 &
  ./codex-runner.sh --parallel 2 &
USAGE
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) [[ $# -ge 2 ]] || { echo "ERROR: --parallel requires an argument"; exit 1; }; PARALLEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --retry-failed) RETRY_FAILED=true; shift ;;
    --resume-paused) RESUME_PAUSED=true; shift ;;
    --start-from) [[ $# -ge 2 ]] || { echo "ERROR: --start-from requires an argument"; exit 1; }; START_FROM="$2"; shift 2 ;;
    --limit) [[ $# -ge 2 ]] || { echo "ERROR: --limit requires an argument"; exit 1; }; LIMIT="$2"; shift 2 ;;
    --max-retries) [[ $# -ge 2 ]] || { echo "ERROR: --max-retries requires an argument"; exit 1; }; MAX_RETRIES="$2"; shift 2 ;;
    --min-score) [[ $# -ge 2 ]] || { echo "ERROR: --min-score requires an argument"; exit 1; }; MIN_SCORE="$2"; shift 2 ;;
    --skip-pdf) SKIP_PDF=true; shift ;;
    --rate-limit-sleep)
      [[ $# -ge 2 ]] || { echo "ERROR: --rate-limit-sleep requires an argument"; exit 1; }
      RATE_LIMIT_SLEEP="$2"
      shift 2
      ;;
    --model) [[ $# -ge 2 ]] || { echo "ERROR: --model requires an argument"; exit 1; }; MODEL="$2"; shift 2 ;;
    --status) STATUS_ONLY=true; shift ;;
    --watch) WATCH_MODE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if ! [[ "$RATE_LIMIT_SLEEP" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --rate-limit-sleep must be a non-negative integer (seconds)."
  exit 1
fi

if ! is_decimal_number "$MIN_SCORE"; then
  echo "ERROR: --min-score must be a non-negative number."
  exit 1
fi

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --limit must be a non-negative integer."
  exit 1
fi

[[ "$PARALLEL" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: --parallel must be a positive integer."; exit 1; }
[[ "$MAX_RETRIES" =~ ^[0-9]+$ ]] || { echo "ERROR: --max-retries must be a non-negative integer."; exit 1; }
[[ "$START_FROM" =~ ^[0-9]+$ ]] || { echo "ERROR: --start-from must be a non-negative integer."; exit 1; }

# Lock file to prevent double execution of THIS runner (batch-runner.sh has
# its own separate lock, so both can run at once).
acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another codex-runner is already running (PID $old_pid)"
      echo "If this is stale, remove $LOCK_FILE"
      exit 1
    else
      echo "WARN: Stale lock file found (PID $old_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
}

release_lock() {
  if [[ "${BASHPID:-$$}" != "$MAIN_PID" ]]; then
    return
  fi
  rm -f "$LOCK_FILE" "$RUN_PROMPT"
}

# Assemble the static prompt once per run (candidate context + shared
# instructions). Job-specific values travel in the per-offer prompt instead.
build_run_prompt() {
  sed \
    -e "s|{{URL}}|<URL from the job message>|g" \
    -e "s|{{JD_FILE}}|<JD file from the job message>|g" \
    -e "s|{{REPORT_NUM}}|<report number from the job message>|g" \
    -e "s|{{DATE}}|<date from the job message>|g" \
    -e "s|{{ID}}|<batch ID from the job message>|g" \
    "$PROMPT_FILE" > "$RUN_PROMPT"
  local context_file
  for context_file in "$PROJECT_DIR/cv.md" "$PROJECT_DIR/article-digest.md" "$PROJECT_DIR/modes/_profile.md" "$PROJECT_DIR/config/profile.yml" "$PROJECT_DIR/modes/_custom.md"; do
    if [[ -f "$context_file" ]]; then
      {
        printf '\n\n---\n\n'
        printf '**Runtime candidate context — %s**\n\n' "${context_file#"$PROJECT_DIR/"}"
        case "$context_file" in
          "$PROJECT_DIR/cv.md"|"$PROJECT_DIR/article-digest.md") cat "$context_file" ;;
          *) sed 's/^/    /' "$context_file" ;;
        esac
        printf '\n'
      } >> "$RUN_PROMPT"
    fi
  done
}

# Put the real JD on disk before the worker starts (see batch-runner.sh for
# the rationale — same logic, shared jd-index.tsv).
resolve_jd() {
  local url="$1" out="$2" rel=""
  case "$url" in
    local:*) rel="${url#local:}" ;;
    *)
      [[ -f "$PROJECT_DIR/data/jd-index.tsv" ]] || return 1
      rel="$(awk -F'\t' -v u="$url" '$1 == u { print $2; exit }' "$PROJECT_DIR/data/jd-index.tsv")"
      ;;
  esac
  [[ -n "$rel" ]] || return 1
  case "$rel" in
    /*|../*|*/../*|*/..) echo "    ⚠️  JD path rejected (escapes repo): $rel" >&2; return 1 ;;
  esac
  [[ -f "$PROJECT_DIR/$rel" ]] || return 1
  cat "$PROJECT_DIR/$rel" > "$out" 2>/dev/null || return 1
  [[ -s "$out" ]] || return 1
  return 0
}

trap release_lock EXIT

# Validate prerequisites
check_prerequisites() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Add offers first."
    exit 1
  fi

  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: $PROMPT_FILE not found."
    exit 1
  fi

  if ! command -v codex &>/dev/null; then
    echo "ERROR: 'codex' CLI not found in PATH."
    exit 1
  fi

  mkdir -p "$LOGS_DIR" "$TRACKER_DIR" "$REPORTS_DIR"
}

check_status_prerequisites() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found at $STATE_FILE"
    exit 0
  fi
}

init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$STATE_FILE"
  fi
}

acquire_state_lock() {
  if [[ "${STATE_LOCK_DISABLED:-0}" -eq 1 ]]; then
    return 0
  fi

  local waited=0
  local max_waits=$((STATE_LOCK_TIMEOUT_SECONDS * 10))

  while true; do
    if mkdir "$STATE_LOCK_DIR" 2>/dev/null; then
      if printf '%s\n' "${BASHPID:-$$}" > "$STATE_LOCK_PID_FILE"; then
        STATE_LOCK_OWNED=1
        return 0
      fi
      rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
      rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
      echo "ERROR: Failed to initialize state lock metadata at $STATE_LOCK_DIR"
      return 1
    fi

    if [[ ! -d "$STATE_LOCK_DIR" ]]; then
      if (( PARALLEL <= 1 )); then
        echo "WARN: State lock creation failed. Falling back to lock-free operation (single-worker mode)." >&2
        STATE_LOCK_DISABLED=1
        STATE_LOCK_OWNED=0
        return 0
      fi
      echo "ERROR: Failed to create state lock directory $STATE_LOCK_DIR"
      return 1
    fi

    if [[ -f "$STATE_LOCK_PID_FILE" ]]; then
      local lock_pid
      lock_pid=$(cat "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$STATE_LOCK_PID_FILE"
        if rmdir "$STATE_LOCK_DIR" 2>/dev/null; then
          echo "WARN: Recovered stale state lock (PID $lock_pid not running)."
          continue
        fi
      fi
    fi

    if (( waited >= max_waits )); then
      echo "ERROR: Timed out waiting for state lock at $STATE_LOCK_DIR"
      echo "If no batch-runner/codex-runner worker is active, remove the stale lock directory."
      return 1
    fi

    sleep 0.1
    ((waited += 1))
  done
}

release_state_lock() {
  if [[ "${STATE_LOCK_OWNED:-0}" -ne 1 ]]; then
    return
  fi
  rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
  STATE_LOCK_OWNED=0
}

run_with_state_lock() {
  acquire_state_lock || return $?

  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi

  release_state_lock
  return "$status"
}

get_status() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "none"
    return
  fi
  local status
  status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$STATE_FILE")
  echo "${status:-none}"
}

get_retries() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "0"
    return
  fi
  local retries
  retries=$(awk -F'\t' -v id="$id" '$1 == id { print $9 }' "$STATE_FILE")
  echo "${retries:-0}"
}

# Read spend_tier from config/profile.yml. Defaults to "standard" if the key
# is absent or invalid.
read_spend_tier() {
  local raw=""

  if [[ -f "$PROFILE_FILE" ]]; then
    raw=$(
      awk -F: '
        /^[[:space:]]*spend_tier[[:space:]]*:/ {
          value = substr($0, index($0, ":") + 1)
          print value
          exit
        }
      ' "$PROFILE_FILE"
    )
    raw="${raw%%#*}"
    raw="${raw//$'\r'/}"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    case "$raw" in
      \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
      \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
    esac
    raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  fi

  case "$raw" in
    economy|standard|premium)
      printf '%s\n' "$raw"
      ;;
    "")
      printf '%s\n' "standard"
      ;;
    *)
      echo "WARN: Invalid spend_tier \"$raw\" in ${PROFILE_FILE#"$PROJECT_DIR/"}; falling back to standard." >&2
      printf '%s\n' "standard"
      ;;
  esac
}

# Tier -> model mapping. Keep in sync with the Codex row in modes/_shared.md.
spend_tier_to_model() {
  echo "gpt-6.1-sol"
}

# Resolve the model to pass to `codex exec --model`. --model always wins.
resolve_worker_model() {
  if [[ -n "$MODEL" ]]; then
    RESOLVED_MODEL="$MODEL"
    RESOLVED_SPEND_TIER="override"
    return 0
  fi

  RESOLVED_SPEND_TIER="$(read_spend_tier)"
  RESOLVED_MODEL="$(spend_tier_to_model "$RESOLVED_SPEND_TIER")"
}

log_discard() {
  local id="$1" url="$2" reason="$3"
  mkdir -p "$LOGS_DIR"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\t%s\t%s\t%s\n' "$ts" "$id" "$url" "$reason" >> "$DISCARD_LOG"
}

# Update or insert state for an offer. Caller must hold STATE_LOCK_DIR.
# Shared state file with batch-runner.sh -- the lock dir above is the same
# path for both scripts, so writes from either runner are serialized.
update_state_unlocked() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"

  error=${error//$'\r'/ }
  error=${error//$'\n'/ }
  error=${error//$'\t'/ }

  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
  fi

  local tmp="$STATE_FILE.tmp"
  local found=false

  head -1 "$STATE_FILE" > "$tmp"

  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries; do
    [[ "$sid" == "id" ]] && continue
    if [[ "$sid" == "$id" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
      found=true
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sid" "$surl" "$sstatus" "$sstarted" "$scompleted" "$sreport" "$sscore" "$serror" "$sretries" >> "$tmp"
    fi
  done < "$STATE_FILE"

  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
  fi

  mv "$tmp" "$STATE_FILE"
}

update_state() {
  run_with_state_lock update_state_unlocked "$@"
}

# ponytail: exact codex-exec wording for rate limits vs. session/usage limits
# hasn't been verified against a real quota-exceeded run. These keyword
# patterns are copied from the Claude-side detector as a best-effort default
# -- adjust once real codex exec rate-limit output is observed.
is_rate_limit_log() {
  local log_file="$1"
  grep -Eiq '(rate limit|rate_limit|too many requests|429|quota exceeded|try again later|temporarily unavailable)' "$log_file"
}

is_session_limit_log() {
  local log_file="$1"
  grep -Eiq '(session limit|resets [0-9:]+[ap]m|usage limit|limit[[:space:]]+reached)' "$log_file"
}

is_access_egress_log() {
  node - "$1" <<'NODE'
const fs = require('fs');
const rejected = /(model.*(not supported|does not exist|not found|access.*denied|do not have access)|egress[ _-]*(guard|blocked|denied)|sensitive[ _-]*data[ _-]*egress)/i;
const found = fs.readFileSync(process.argv[2], 'utf8').split('\n').some(line => {
  try {
    const event = JSON.parse(line);
    // Only provider errors: report prose and logged commands are not rejections.
    return ['error', 'turn.failed'].includes(event.type) && rejected.test(event.message || event.error?.message || '');
  } catch {
    return rejected.test(line);
  }
});
process.exit(found ? 0 : 1);
NODE
}

mark_paused_rate_limit() {
  local id="$1" url="$2" started_at="$3" report_num="$4" retries="$5" log_file="$6"
  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local error_msg
  error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "session/rate limit reached")
  update_state "$id" "$url" "paused_rate_limit" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
  printf '%s\t%s\t%s\n' "$id" "$report_num" "$error_msg" > "$PAUSE_FILE"
  BATCH_PAUSED=true
}

# Shared, cross-process-atomic reservation system (see batch-runner.sh for
# the full rationale) -- routes both runners through the same node script so
# report numbers never collide between a Claude worker and a Codex worker.
reserve_report_num_unlocked() {
  local id="$1" url="$2" started="$3" retries="$4"

  # Re-check under the shared state lock: the main loop's pending-offer scan
  # (in this script AND in batch-runner.sh) reads a status snapshot before
  # calling this, so the OTHER runner could have already claimed this offer
  # in the gap between that read and this reservation. Print the CLAIMED
  # sentinel (never a valid report number, distinct from a genuine
  # reservation failure which prints nothing) rather than reserving a
  # second report number for one offer.
  local current_status
  current_status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$STATE_FILE" 2>/dev/null)
  if [[ "$current_status" == "processing" || "$current_status" == "completed" || "$current_status" == "skipped" ]]; then
    printf 'CLAIMED\n'
    return 0
  fi

  local report_num=""
  report_num=$(node "$PROJECT_DIR/reserve-report-num.mjs" 2>/dev/null | tr -d '[:space:]')
  if [[ -n "$report_num" ]]; then
    update_state_unlocked "$id" "$url" "processing" "$started" "-" "$report_num" "-" "-" "$retries"
  fi

  printf '%s\n' "$report_num"
}

release_report_num() {
  local report_num="$1"
  [[ -n "$report_num" && "$report_num" != "-" ]] || return 0
  node "$PROJECT_DIR/reserve-report-num.mjs" --release "$report_num" >/dev/null 2>&1 || true
}

reserve_report_num() {
  run_with_state_lock reserve_report_num_unlocked "$@"
}

# Process a single offer
process_offer() {
  local id="$1" url="$2" source="$3" notes="$4"

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local retries
  retries=$(get_retries "$id")
  local report_num
  report_num=$(reserve_report_num "$id" "$url" "$started_at" "$retries")
  if [[ "$report_num" == "CLAIMED" ]]; then
    echo "    ⏭️  Skipping #$id — already claimed by another runner (batch-runner.sh/codex-runner.sh race)"
    return 0
  fi
  if [[ -z "$report_num" ]]; then
    echo "    ❌ Could not reserve a report number for #$id; leaving it pending." >&2
    return 0
  fi
  local date
  date=$(date +%Y-%m-%d)
  local jd_file
  jd_file="$(mktemp "${TMPDIR:-/tmp}/codex-batch-jd-${id}.XXXXXX")"
  local result_file
  result_file="$(mktemp "${TMPDIR:-/tmp}/.resolved-prompt-codex-${id}.XXXXXX")"
  trap 'rm -f "$jd_file" "$result_file"; trap - RETURN' RETURN

  echo "--- Processing offer #$id: $url (report $report_num, attempt $((retries + 1)))"
  if resolve_jd "$url" "$jd_file"; then
    echo "    📄 JD resolved from index ($(wc -c < "$jd_file") bytes)"
  else
    echo "    ⚠️  JD not resolvable — worker will fall back to WebFetch"
  fi

  local prompt
  if [[ "$SKIP_PDF" == "true" ]]; then
    prompt="Process this job offer. Run only A-G evaluation + report .md + tracker line. Do not generate PDFs, Block H application answers, output packages, CVs, cover letters, outreach, or submissions; write ❌ in the tracker PDF column and set \"pdf\": null in the final JSON."
    echo "    ⏭️  --skip-pdf set — skipping PDF generation for #$id ($url)"
  else
    prompt="Process this job offer. Run the full pipeline: A-G evaluation + report .md + optional PDF + tracker line."
  fi
  prompt="$prompt URL: $url"
  prompt="$prompt JD file: $jd_file"
  prompt="$prompt Report number: $report_num"
  prompt="$prompt Date: $date"
  prompt="$prompt Batch ID: $id"

  local log_file="$LOGS_DIR/${report_num}-${id}.log"

  # Codex has no append-system-prompt-file equivalent, so concatenate once and
  # send the result over stdin. This avoids argv limits and process-list leaks.
  local full_prompt
  full_prompt="$(cat "$RUN_PROMPT")

$prompt"

  local -a codex_args=(exec --model "$RESOLVED_MODEL" --ignore-user-config --ephemeral
    -C "$PROJECT_DIR" --sandbox workspace-write
    -c 'approval_policy="never"'
    -c 'sandbox_workspace_write.network_access=true'
    -c 'project_doc_max_bytes=0'
    -c 'model_reasoning_effort="high"'
    --json --output-last-message "$result_file" -)

  local exit_code=0
  local terminal_failure_recorded=false
  while true; do
    exit_code=0
    printf '(metadata: model=%s, provider=openai)\n' "$RESOLVED_MODEL" > "$log_file"
    codex "${codex_args[@]}" >> "$log_file" 2>&1 <<< "$full_prompt" || exit_code=$?

    if [[ $exit_code -eq 0 ]]; then
      break
    fi

    if is_access_egress_log "$log_file"; then
      printf '%s\t%s\taccess or egress rejected\n' "$id" "$report_num" > "$PAUSE_FILE"
      BATCH_PAUSED=true
      echo "    ⏸️  Model access or egress rejected; stopping batch."
      break
    fi

    if is_session_limit_log "$log_file"; then
      mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
      echo "    ⏸️  Session/rate limit reached; pausing batch without consuming retry budget."
      terminal_failure_recorded=true
      break
    fi

    if is_rate_limit_log "$log_file" && (( retries < MAX_RETRIES )); then
      if (( RATE_LIMIT_SLEEP <= 0 )); then
        mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
        echo "    ⏸️  Rate limited and --rate-limit-sleep is 0; pausing batch without consuming retry budget."
        terminal_failure_recorded=true
        break
      fi
      retries=$((retries + 1))
      local retry_completed_at
      retry_completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      update_state "$id" "$url" "rate_limited" "$started_at" "$retry_completed_at" "$report_num" "-" "rate-limit; retrying after ${RATE_LIMIT_SLEEP}s" "$retries"
      echo "    ⏳ Rate limited (attempt $retries/$MAX_RETRIES). Waiting ${RATE_LIMIT_SLEEP}s before retry..."
      sleep "$RATE_LIMIT_SLEEP"
      continue
    fi

    break
  done

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [[ $exit_code -eq 0 ]]; then
    local worker_result_json
    worker_result_json=$(awk '
      /^```json[[:space:]]*$/ { in_block=1; block=""; next }
      in_block && /^```[[:space:]]*$/ { in_block=0; last=block; next }
      in_block { block = block $0 "\n" }
      END { printf "%s", last }
    ' "$result_file" 2>/dev/null || true)

    local worker_failed_match="" worker_error_match="" score="-"
    if [[ -n "$worker_result_json" ]]; then
      local parsed
      parsed=$(printf '%s' "$worker_result_json" | node -e '
        let data = "";
        process.stdin.on("data", d => data += d);
        process.stdin.on("end", () => {
          try {
            const obj = JSON.parse(data);
            const status = typeof obj.status === "string" ? obj.status : "";
            const error = typeof obj.error === "string" ? obj.error : "";
            const score = typeof obj.score === "number" ? String(obj.score) : "";
            process.stdout.write(status + "\x1f" + error + "\x1f" + score);
          } catch {
            process.stdout.write("");
          }
        });
      ' 2>/dev/null || true)
      if [[ -n "$parsed" ]]; then
        IFS=$'\x1f' read -r parsed_status parsed_error parsed_score <<< "$parsed"
        if [[ "$parsed_status" == "failed" ]]; then
          worker_failed_match="failed"
          worker_error_match="$parsed_error"
        elif [[ -n "$parsed_score" ]]; then
          score="$parsed_score"
        fi
      fi
    fi

    if [[ -n "$worker_failed_match" ]]; then
      [[ -z "$worker_error_match" ]] && worker_error_match="worker reported status:failed (exit code 0)"
      if grep -Eiq '(model.*(not supported|does not exist|not found|access.*denied|do not have access)|egress[ _-]*(guard|blocked|denied)|sensitive[ _-]*data[ _-]*egress)' <<< "$worker_error_match"; then
        printf '%s\t%s\taccess or egress rejected\n' "$id" "$report_num" > "$PAUSE_FILE"
        BATCH_PAUSED=true
      fi
      if (( retries < MAX_RETRIES )); then
        retries=$((retries + 1))
      fi
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$worker_error_match" "$retries"
      release_report_num "$report_num"
      echo "    ❌ Failed (worker-reported, attempt $retries): $worker_error_match"
      return 0
    fi

    # The reservation sentinel is not a completed evaluation report.
    if ! compgen -G "$REPORTS_DIR/${report_num}-*.md" | grep -Fvx "$REPORTS_DIR/${report_num}-RESERVED.md" >/dev/null; then
      if (( retries < MAX_RETRIES )); then
        retries=$((retries + 1))
      fi
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "worker exited cleanly but wrote no report file for this report number" "$retries"
      release_report_num "$report_num"
      echo "    ❌ Failed (no report file on disk, attempt $retries)"
      return 0
    fi

    # Completion is proven by the artifacts consumed by the next stage.
    local artifact_error
    if ! artifact_error=$(node "$PROJECT_DIR/validate-batch-artifacts.mjs" "$PROJECT_DIR" "$report_num" "$id" "$url" "$score" "$jd_file" 2>&1); then
      if (( retries < MAX_RETRIES )); then retries=$((retries + 1)); fi
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$artifact_error" "$retries"
      release_report_num "$report_num"
      echo "    ❌ Failed (incomplete artifacts, attempt $retries): $artifact_error"
      return 0
    fi

    if is_decimal_number "$score" && awk -v min="$MIN_SCORE" 'BEGIN{exit !(min > 0)}'; then
      if awk -v score="$score" -v min="$MIN_SCORE" 'BEGIN{exit !(score < min)}'; then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$score" "below-min-score" "$retries"
        release_report_num "$report_num"
        echo "    ⏭️  Skipped (score: $score < min-score: $MIN_SCORE)"
        return 0
      fi
    fi

    update_state "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "$score" "-" "$retries"
    release_report_num "$report_num"
    echo "    ✅ Completed (score: $score, report: $report_num)"
  elif [[ "$terminal_failure_recorded" == "false" ]]; then
    if (( retries < MAX_RETRIES )); then
      retries=$((retries + 1))
    fi
    local error_msg
    error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "Unknown error (exit code $exit_code)")
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
    release_report_num "$report_num"
    echo "    ❌ Failed (attempt $retries, exit code $exit_code)"
  fi
}

# Merge tracker additions into applications.md (same shared pipeline as
# batch-runner.sh).
merge_tracker() {
  echo ""
  echo "=== Merging tracker additions ==="
  node "$PROJECT_DIR/merge-tracker.mjs"
  echo ""
  echo "=== Reconciling pipeline.md ==="
  node "$PROJECT_DIR/reconcile-pipeline.mjs" || echo "⚠️  Pipeline reconcile had issues (see above)"
  echo ""
  echo "=== Verifying pipeline integrity ==="
  node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues (see above)"
}

print_summary() {
  echo ""
  echo "=== Batch Summary ==="

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found."
    return
  fi

  local total=0 completed=0 skipped=0 failed=0 pending=0
  local score_sum=0 score_count=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1))
        if is_decimal_number "$sscore"; then
          score_sum=$(awk -v sum="$score_sum" -v score="$sscore" 'BEGIN{print sum + score}' 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      skipped) skipped=$((skipped + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "Total: $total | Completed: $completed | Skipped: $skipped | Failed: $failed | Pending: $pending"

  if (( score_count > 0 )); then
    local avg
    avg=$(awk -v sum="$score_sum" -v count="$score_count" 'BEGIN{printf "%.1f", sum / count}' 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi

  if [[ -f "$BATCH_DIR/aggregate-tokens.mjs" ]]; then
    if ! node "$BATCH_DIR/aggregate-tokens.mjs"; then
      echo "Warning: token aggregation failed." >&2
    fi
  fi
}

print_status_table() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found at $STATE_FILE"
    return
  fi

  local total=0 completed=0 processing=0 failed=0 pending=0 skipped=0 rate_limited=0 paused_rate_limit=0
  local score_sum=0 score_count=0

  local header=true
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries || [[ -n "$sid" ]]; do
    if [[ "$header" == "true" ]]; then
      header=false
      continue
    fi
    [[ -z "$sid" ]] && continue
    sstatus="${sstatus%$'\r'}"
    sscore="${sscore%$'\r'}"
    serror="${serror%$'\r'}"
    sreport="${sreport%$'\r'}"
    total=$((total + 1))
    case "$sstatus" in
      completed)
        completed=$((completed + 1))
        if is_decimal_number "$sscore"; then
          score_sum=$(awk -v sum="$score_sum" -v score="$sscore" 'BEGIN{print sum + score}' 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      processing) processing=$((processing + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      skipped) skipped=$((skipped + 1)) ;;
      rate_limited) rate_limited=$((rate_limited + 1)) ;;
      paused_rate_limit) paused_rate_limit=$((paused_rate_limit + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "=== Batch Progress ==="
  echo "Total: $total | Completed: $completed | Processing: $processing | Failed: $failed | Pending: $pending | Skipped: $skipped | Rate Limited: $rate_limited | Paused: $paused_rate_limit"
  if (( score_count > 0 )); then
    local avg
    avg=$(awk -v sum="$score_sum" -v count="$score_count" 'BEGIN{printf "%.1f", sum / count}' 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
  echo ""

  printf "%-4s | %-17s | %-6s | %-5s | %-40s\n" "ID" "Status" "Report" "Score" "URL / Error"
  printf "%-4s+%-19s+%-8s+%-7s+%-42s\n" "----" "-------------------" "--------" "-------" "------------------------------------------"

  header=true
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries || [[ -n "$sid" ]]; do
    if [[ "$header" == "true" ]]; then
      header=false
      continue
    fi
    [[ -z "$sid" ]] && continue
    sstatus="${sstatus%$'\r'}"
    sscore="${sscore%$'\r'}"
    serror="${serror%$'\r'}"
    sreport="${sreport%$'\r'}"
    local target="$surl"
    if [[ "$sstatus" == "failed" && -n "$serror" && "$serror" != "-" ]]; then
      target="Error: $serror"
    fi
    if (( ${#target} > 50 )); then
      target="${target:0:47}..."
    fi
    printf "%-4s | %-17s | %-6s | %-5s | %-50s\n" "$sid" "$sstatus" "$sreport" "$sscore" "$target"
  done < "$STATE_FILE"
}

watch_status() {
  local active_pid=""
  if [[ -f "$LOCK_FILE" ]]; then
    active_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  fi

  if [[ -n "$active_pid" ]] && kill -0 "$active_pid" 2>/dev/null; then
    echo "Watching codex-runner (PID $active_pid)... Press Ctrl+C to stop."
    while kill -0 "$active_pid" 2>/dev/null; do
      clear || printf "\033[c"
      echo "=== Watching Batch Progress (PID $active_pid) ==="
      print_status_table
      sleep 2
    done
    echo ""
    echo "=== Codex runner process (PID $active_pid) has finished ==="
  else
    echo "No active codex-runner detected."
  fi

  echo "Showing final status:"
  print_status_table

  if [[ -f "$PROJECT_DIR/verify-pipeline.mjs" ]]; then
    echo ""
    echo "=== Running pipeline verification ==="
    node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues"
  fi
}

# Main
main() {
  if [[ "$STATUS_ONLY" == "true" ]]; then
    check_status_prerequisites
    print_status_table
    exit 0
  fi

  if [[ "$WATCH_MODE" == "true" ]]; then
    check_status_prerequisites
    watch_status
    exit 0
  fi

  check_prerequisites

  resolve_worker_model

  if [[ "$DRY_RUN" == "false" ]]; then
    acquire_lock
    build_run_prompt
    rm -f "$PAUSE_FILE"
  fi

  init_state

  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  if (( total_input == 0 )); then
    echo "No offers in $INPUT_FILE. Add offers first."
    exit 0
  fi

  echo "=== career-ops codex runner ==="
  if (( LIMIT > 0 )); then
    echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES | Limit: $LIMIT"
  else
    echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES"
  fi
  if [[ "$RESOLVED_SPEND_TIER" == "override" ]]; then
    echo "Model: $RESOLVED_MODEL (explicit --model override)"
  else
    echo "Model: $RESOLVED_MODEL (spend_tier=${RESOLVED_SPEND_TIER})"
  fi
  echo "Input: $total_input offers"
  echo ""

  local -a pending_ids=()
  local -a pending_urls=()
  local -a pending_sources=()
  local -a pending_notes=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue
    [[ -z "$id" || -z "$url" ]] && continue

    [[ "$id" =~ ^[0-9]+$ ]] || continue

    if (( id < START_FROM )); then
      continue
    fi

    local status
    status=$(get_status "$id")

    if [[ "$RESUME_PAUSED" == "true" ]]; then
      if [[ "$status" != "paused_rate_limit" ]]; then
        continue
      fi
    elif [[ "$RETRY_FAILED" == "true" ]]; then
      if [[ "$status" != "failed" ]]; then
        continue
      fi
      local retries
      retries=$(get_retries "$id")
      if (( retries >= MAX_RETRIES )); then
        echo "SKIP #$id: max retries ($MAX_RETRIES) reached"
        continue
      fi
    else
      if [[ "$status" == "completed" || "$status" == "skipped" ]]; then
        continue
      fi
      if [[ "$status" == "paused_rate_limit" ]]; then
        continue
      fi
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_retries "$id")
        if (( retries >= MAX_RETRIES )); then
          echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
          continue
        fi
      fi
      # A worker from the OTHER runner may already have this offer in
      # flight -- shared state, so "processing" here can mean "claimed by
      # batch-runner.sh right now," not just a crashed run of this script.
      if [[ "$status" == "processing" ]]; then
        continue
      fi
    fi

    if (( LIMIT > 0 )) && (( ${#pending_ids[@]} >= LIMIT )); then
      break
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
    pending_sources+=("$source")
    pending_notes+=("$notes")
  done < "$INPUT_FILE"

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No offers to process."
    print_summary
    exit 0
  fi

  echo "Pending: $pending_count offers"
  echo ""

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN (no processing) ==="
    for i in "${!pending_ids[@]}"; do
      local status
      status=$(get_status "${pending_ids[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} [${pending_sources[$i]}] (status: $status)"
    done
    echo ""
    echo "Would process $pending_count offers"
    exit 0
  fi

  if (( PARALLEL <= 1 )); then
    for i in "${!pending_ids[@]}"; do
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}"
      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        echo "=== Batch paused: session/rate limit reached. Resume later with --resume-paused. ==="
        break
      fi
    done
  else
    local running=0
    local -a pids=()
    local -a pid_ids=()

    for i in "${!pending_ids[@]}"; do
      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        echo "=== Batch paused: session/rate limit reached. Waiting for running workers, not scheduling new offers. ==="
        break
      fi

      while (( running >= PARALLEL )); do
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            wait "${pids[$j]}" 2>/dev/null || true
            unset 'pids[j]'
            unset 'pid_ids[j]'
            running=$((running - 1))
          fi
        done
        pids=("${pids[@]}")
        pid_ids=("${pid_ids[@]}")
        if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
          echo "=== Batch paused: session/rate limit reached. Waiting for running workers, not scheduling new offers. ==="
          break
        fi
        sleep 1
      done

      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        break
      fi

      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      pids+=($!)
      pid_ids+=("${pending_ids[$i]}")
      running=$((running + 1))
    done

    for pid in "${pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  merge_tracker

  print_summary

  exit 0
}

main "$@"
