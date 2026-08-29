# Batch Processing

Process multiple job offers in parallel via headless workers. Each worker runs the full evaluation pipeline (A-F report + PDF + tracker line) autonomously. See the **Headless / Batch Mode** table in `AGENTS.md` for the correct command per CLI.

Two orchestrators are available, sharing the same `batch-input.tsv` / `batch-state.tsv` queue: `batch-runner.sh` (Claude, `claude -p` workers) and `codex-runner.sh` (Codex, `codex exec` workers on GPT-5.6 Luna/Terra/Sol). Run both at once to split one offer queue across two LLM brains — handy when Claude usage is tight. See **Running Both Runners Together** below.

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
| `--parallel N` | `1` | Number of concurrent headless workers |
| `--dry-run` | off | Preview pending offers without processing |
| `--retry-failed` | off | Only retry offers marked as `failed` in state |
| `--resume-paused` | off | Resume offers paused after a Claude session/rate limit |
| `--start-from N` | `0` | Skip offers with ID below N |
| `--limit N` | `0` | Max number of offers to process in this run (0 = no limit) |
| `--max-retries N` | `2` | Max retry attempts per offer before giving up |
| `--rate-limit-sleep N` | `300` | Seconds to wait before retrying a transient rate-limited worker; use `0` to pause the batch immediately |

## Directory Layout

```
batch/
  batch-runner.sh          # Orchestrator script
  batch-prompt.md          # Prompt template sent to each worker
  batch-input.tsv          # Input offers (you create this)
  batch-state.tsv          # Processing state (auto-managed, resumable)
  logs/                    # Per-offer worker logs ({report_num}-{id}.log)
  tracker-additions/       # TSV lines produced by workers
    merged/                # TSVs already merged into applications.md
```

## How It Works

1. **batch-runner.sh** reads `batch-input.tsv` and `batch-state.tsv` to determine which offers need processing.
2. For each pending offer, it assigns a report number and launches a headless worker with `batch-prompt.md` as the system prompt (placeholders like `{{URL}}`, `{{REPORT_NUM}}` are resolved).
3. Each worker evaluates the offer, writes a report to `reports/`, generates a PDF to `output/`, and writes a tracker TSV to `tracker-additions/`.
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

`paused_rate_limit` is different: it means a worker hit a Claude session/usage limit, so the runner stopped scheduling new offers and preserved the retry count. Resume those rows explicitly after the limit resets:

```bash
./batch/batch-runner.sh --resume-paused
```

A PID-based lock file (`batch-runner.pid`) prevents concurrent batch runs. If a previous run crashed, the stale lock is detected and removed automatically.

## Prerequisites

- Your CLI in PATH (see **Headless / Batch Mode** table in `AGENTS.md`)
- Node.js >= 18, Playwright chromium installed (`npm run doctor` to verify)
- `batch-input.tsv` with at least one offer

## Running Both Runners Together

`codex-runner.sh` is a sibling to `batch-runner.sh` with the identical flag surface (`--parallel`, `--dry-run`, `--retry-failed`, `--resume-paused`, `--start-from`, `--limit`, `--max-retries`, `--min-score`, `--skip-pdf`, `--model`, `--status`, `--watch`), but launches `codex exec` workers on GPT-5.6 Luna (economy) / Terra (standard) / Sol (premium) instead of `claude -p` workers.

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

The same switch is honored by `next-step.mjs` and `triage-all.mjs`. Codex triage defaults to GPT-5.6 Terra; full evaluation follows `spend_tier` (standard = Terra). Codex workers run ephemerally in a workspace-write sandbox, ignore personal config, receive prompts on stdin, and record exact `--json` usage in their logs.
