# Batch Processing

Process multiple job offers via headless workers. By default (`--mode full`) each worker runs the full evaluation pipeline (A-G report + PDF + tracker line) autonomously. With `--mode match` it runs a single-pass CV match instead: a condensed report and a tracker line, no PDF (the tracker PDF column gets ❌). Workers are `claude -p` by default; `--cli NAME` selects `opencode`, `gemini`, `qwen` or `grok` instead (`--model NAME` picks that CLI's model). Only `claude` workers run in parallel; the other CLIs run one offer at a time. The **Headless / Batch Mode** table in `AGENTS.md` is not the runner's `--cli` list: it includes CLIs the runner does not launch, and it has no Gemini row because Gemini CLI is now a legacy wrapper (see `docs/SUPPORTED_CLIS.md`).

Two orchestrators are available, sharing the same `batch-input.tsv` / `batch-state.tsv` queue: `batch-runner.sh` (Claude, `claude -p` workers) and `codex-runner.sh` (Codex, `codex exec` workers on GPT-6.1 Sol at high reasoning). Run both at once to split one offer queue across two LLM brains — handy when Claude usage is tight. See **Running Both Runners Together** below.

## Quick Start

1. **Add offers** to `batch-input.tsv` (tab-separated: `id`, `url`, `source`, `notes`):

   ```tsv
   id	url	source	notes
   1	https://jobs.example.com/role-a	LinkedIn	
   2	https://greenhouse.io/company/role-b	Greenhouse	priority
   ```

2. **Dry run** to preview what will be processed:

   ```bash
   ./batch/batch-runner.sh --dry-run
   ```

3. **Run the batch**:

   ```bash
   ./batch/batch-runner.sh
   ```

4. **Results** are automatically merged into `data/applications.md`, processed offers are reconciled out of the `data/pipeline.md` inbox, and integrity is verified with `verify-pipeline.mjs` at the end of the run.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--cli NAME` | `claude` | Worker CLI: `claude`, `opencode`, `gemini`, `qwen` or `grok`. Only `claude` runs in parallel and retries; the others run one offer at a time, one attempt each |
| `--model NAME` | per CLI | Model for the worker CLI. For `claude`, overrides the model resolved from `spend_tier` in `config/profile.yml` |
| `--parallel N` | `3` for `claude`, `1` otherwise | Number of concurrent headless workers; after a rate limit the rest of the batch runs on 1 |
| `--dry-run` | off | Preview pending offers without processing |
| `--retry-failed` | off | Only retry offers marked as `failed` in state |
| `--resume-paused` | off | Resume offers paused after a Claude session/rate limit |
| `--start-from N` | `0` | Skip offers with ID below N |
| `--company A,B` | off | Only process offers whose company matches one of the comma-separated names (case- and punctuation-insensitive substring of the URL or of the company in `notes`, i.e. the part before ` - ` in `Company - Role`); applied before `--limit` |
| `--limit N` | no limit | Max number of offers to process in this run; must be a positive integer (`0` is rejected), so omit the flag for no limit |
| `--min-score N` | `0` (off) | Record offers that score below N as `skipped` instead of `completed` |
| `--skip-pdf` | off | Skip PDF generation; the tracker PDF column gets ❌ |
| `--max-retries N` | `2` | Max retry attempts per offer before giving up |
| `--worker-timeout N` | `1800` | Stop a worker that runs longer than N seconds and mark the offer failed (0 = no limit) |
| `--mode NAME` | `full` | Evaluation mode: `full` (A-G report + PDF + tracker line) or `match` (condensed single-pass CV match: report + tracker line, no PDF; implies `--skip-pdf`) |
| `--single-pass` | off | Alias for `--mode match` |
| `--thin-action MODE` | `webfetch` | What to do when no usable JD text could be fetched (JS-rendered page, empty shell). `webfetch`: the worker tries WebFetch. `skip`: record the offer as skipped (`needs-playwright`), spawn no worker. `browser-extract`: render the page with `browser-extract.mjs` (headless Chromium, no model tokens) and give the text to the worker. Retryable outcomes are recorded as `failed` and picked up again by `--retry-failed` (each spends one of `--max-retries`): no HTTP response from the fetch (DNS, refused, timeout, TLS), and for `browser-extract` a missing Playwright, `empty_text` or `navigation_error`. Anything else is terminal `skipped` |
| `--rate-limit-sleep N` | `300` | Maximum adaptive retry delay in seconds (0–2147483647); use `0` to pause the batch immediately |

### Adaptive rate-limit retries (Claude only)

Transient rate limits start at `min(30, N)` seconds, double for each retry
already consumed by the offer (including persisted retries on resume), and
saturate at `N`. A random integer percentage from 0 through 20 is added,
rounded down to whole seconds, then capped at `N`. With the default ceiling,
the first waits are 30–36s and 60–72s. Small ceilings can leave no jitter room.

The current failed attempt's log may override exponential growth with a
standalone `Retry-After: <non-negative integer seconds>` line (case insensitive,
surrounding whitespace and CRLF allowed). Its delay is `max(min(30, N), seconds)`
plus the same capped upward jitter, so it never retries before the requested
time. If several valid lines exist, the largest wins. Values exceeding `N`
pause the batch without consuming a retry, rather than retrying too early.
HTTP dates, fractions, signed values, JSON/embedded prose and malformed lines
are ignored; no worker log text is evaluated as code. Each attempt overwrites
its log, so a prior attempt's header cannot affect the next wait.

There is no new base-delay flag. Waits within the ceiling remain in the worker,
including in serial mode. `--max-retries` still bounds retries; once exhausted,
the existing failure path applies. `--rate-limit-sleep 0` and session-limit
pauses retain their existing behavior. Actual waits appear in the console and
the `rate_limited` state note; the TSV schema is unchanged.

### Checking progress

| Flag | Description |
|------|-------------|
| `--status` | Print batch progress and a per-offer table, then exit |
| `--summary` | With `--status`, print the totals only |
| `--full` | With `--status`, print the per-offer table (the default) |
| `--watch` | Refresh progress live, with the per-offer table, until the run completes |

`./batch/batch-runner.sh --help` prints every flag.

## Directory Layout

```
batch/
  batch-runner.sh          # Orchestrator script
  batch-prompt.md          # Full multi-step prompt template for workers
  batch-prompt-match.md    # Condensed single-pass match prompt template
  batch-input.tsv          # Input offers (you create this)
  batch-state.tsv          # Processing state (auto-managed, resumable)
  logs/                    # Per-offer worker logs ({report_num}-{id}.log)
  tracker-additions/       # TSV lines produced by workers
    merged/                # TSVs already merged into applications.md
```

## How It Works

1. **batch-runner.sh** reads `batch-input.tsv` and `batch-state.tsv` to determine which offers need processing.
2. For each pending offer, it assigns a report number and launches a headless worker with `batch-prompt.md` as the system prompt. Placeholders like `{{URL}}`, `{{REPORT_NUM}}` resolve to stable labels (e.g. `<URL from the job message>`), not the concrete value, so the resolved system prompt is byte-identical across offers and prompt caching can reuse it. The actual URL, JD file, report number, date and batch ID are passed separately in the per-job message the worker also receives.
3. Each worker evaluates the offer, writes a report to `reports/`, generates a PDF to `output/` (full mode only; `--mode match` writes no PDF), and writes a tracker TSV to `tracker-additions/`. The run shares one Chromium, started on the first PDF and stopped when the run ends.
   A worker whose posting breaks one of your hard rules (a dealbreaker or `compensation.minimum`, stated in the JD) stops before evaluating. It writes only a SKIP tracker row that quotes the rule and the JD line. The runner records it as `skipped`, merges the row, moves the posting out of the pipeline inbox, and lists it under "Dealbreaker skips" in the batch summary. To evaluate one anyway, run it in a session and say "evaluate anyway".
4. After all workers finish, batch-runner calls `merge-tracker.mjs` to merge TSVs into `data/applications.md`, `reconcile-pipeline.mjs` to move processed offers out of the `data/pipeline.md` inbox, and `verify-pipeline.mjs` to check integrity.

## Tracker Merge

Workers write one TSV per offer to `batch/tracker-additions/`. The merge script (`npm run merge`) handles:

- Deduplication by company + role fuzzy match and report number
- Column order conversion (TSV has status before score; applications.md has score before status)
- In-place updates when a re-evaluation scores higher than the existing entry
- Moving processed TSVs to `tracker-additions/merged/`

Run `npm run merge` manually if you need to merge outside of a batch run.

## Pipeline Reconcile

Batch mode reads offers from `batch-input.tsv`, but the `data/pipeline.md` inbox is a separate list. Without reconciliation, an offer evaluated by a batch run stays in the pipeline "Pendientes" section and gets surfaced again on the next scan or `/career-ops pipeline` run -- producing duplicate reports.

`reconcile-pipeline.mjs` (run as `npm run reconcile`) closes that gap: after the tracker merge, every `completed` or `skipped` offer in `batch-state.tsv` whose URL is still in pipeline "Pendientes" is moved to "Procesadas" with its report link and score (entries without a report file on disk are left in place). It is idempotent -- safe to run after every batch, or manually.

## Resumability

`batch-state.tsv` tracks the status of every offer (`pending`, `processing`, `completed`, `failed`, `skipped`, `rate_limited`, `paused_rate_limit`). If the batch is interrupted, re-running `batch-runner.sh` picks up where it left off -- completed offers are skipped automatically. `rate_limited` is a non-completed state used while the runner waits before retrying, so interrupted rate-limited jobs are eligible on the next normal run.

`paused_rate_limit` is different: a worker hit a Claude session/usage limit, zero-wait pause, or a `Retry-After` above the configured ceiling, so the runner stopped scheduling new offers and preserved the retry count. Resume those rows explicitly after the limit resets:

```bash
./batch/batch-runner.sh --resume-paused
```

A PID-based lock file (`batch-runner.pid`) prevents concurrent batch runs. If a previous run crashed, the stale lock is detected and removed automatically.

## Prerequisites

- Your CLI in PATH (see **Headless / Batch Mode** table in `AGENTS.md`)
- Node.js >= 22.13, Playwright chromium installed (`npm run doctor` to verify)
- `batch-input.tsv` with at least one offer

## Running Both Runners Together

`codex-runner.sh` is a sibling to `batch-runner.sh` with the identical flag surface (`--parallel`, `--dry-run`, `--retry-failed`, `--resume-paused`, `--start-from`, `--limit`, `--max-retries`, `--min-score`, `--skip-pdf`, `--model`, `--status`, `--watch`), but launches `codex exec` workers on GPT-6.1 Sol at high reasoning across economy, standard, and premium tiers instead of `claude -p` workers. `--model` preserves an explicit user-directed override.

Both read and write the *same* `batch-input.tsv` and `batch-state.tsv`, so you can run them concurrently against one queue and each will pick up different pending offers:

```bash
./batch/batch-runner.sh --parallel 2 &
./batch/codex-runner.sh --parallel 2 &
wait
```

Each runner has its own lock file (`batch-runner.pid` / `codex-runner.pid`) and pause file, so one CLI's rate limit doesn't stop the other's queue. Report numbers never collide between them (both go through the same `reserve-report-num.mjs` atomic reservation), and a shared status re-check right before reserving prevents both runners from claiming the same offer in the small window between reading state and reserving a report number.

`codex exec` has no equivalent of Claude's prompt-cache-prefix flags (`--append-system-prompt-file`, `--exclude-dynamic-system-prompt-sections`, etc.), so `codex-runner.sh` concatenates the static run prompt and per-offer instructions once, then sends them on stdin. It does not get Claude's same cache-prefix tuning, but it avoids argv-size failures and process-list exposure.

For the complete local pipeline with one selected brain, use:

```bash
CAREER_OPS_BRAIN=codex ./local/orchestration/run-overnight.sh --parallel 2
```

The same switch is honored by `next-step.mjs` and `triage-all.mjs`. Codex uses GPT-6.1 Sol at medium reasoning for triage, high for full evaluation, and xhigh for future output packages. Package settings do not authorize package generation; each external-model run still needs approval for its data and model. Codex workers run ephemerally in a workspace-write sandbox, ignore personal config, receive prompts on stdin, and record exact `--json` usage in their logs. Model-access or egress rejection stops scheduling new offers without substituting a model; inspect the failure and resolve that boundary before resuming. Use `--rate-limit-sleep 0` to stop on rate or usage limits as well.
