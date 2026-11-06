---
name: career-ops-scraper-only
description: >-
  Discover and ingest new career-ops job postings when the user explicitly asks
  to run the scraper only, with no triage or later stages. Separate from the
  broader career-ops scan mode.
---

# Career-ops scraper-only discovery

Use the existing scraper from the career-ops checkout. This workflow requires
no claude-mem service or external model; do not query or start claude-mem.
First follow [root resolution and shared preflight](../career-ops/SKILL.md#project-root-resolution), including the local-controller data-root check. This selects no broader mode.

## Before running

1. Read the checkout's current `AGENTS.md`, `modes/_custom.md`,
   `config/profile.yml`, `DATA_CONTRACT.md`, and
   `local/orchestration/scan-all.sh`. Current code and rules take precedence
   over remembered commands or queue counts.
2. Inspect `git status --short`, active scan and batch workers, locks and their
   owners (including `data/pipeline.md.lock`), batch claims and `.eval-wave`.
   Respect existing work; do not delete locks, rebuild batch input, or start a
   competing scan.
3. Inspect `data/pipeline.md`, `data/scan-all-last-success`, and
   `data/scan-runs.tsv`. Record the pending count and completion marker before
   running. Do not infer a current result from historical logs.
4. Read `local/README.md`, `local/pyproject.toml`, `local/uv.lock`, and the
   effective `JOBSPY_SITES`. Read the installed version from the lock; use that
   locked environment and preserve the adapter's metadata/filter contracts.
   If dependency setup is needed, sync the existing lock from `local/` with
   `UV_CACHE_DIR=/tmp/job-agent-uv-cache uv sync --locked`; do not upgrade
   dependencies or restore obsolete provider monkeypatches during a scan.

## Run and wait

Run the canonical script from the checkout root:

```bash
env -u JOBSPY_HOURS UV_CACHE_DIR=/tmp/job-agent-uv-cache ./local/orchestration/scan-all.sh
```

The script calculates the window from the last successful full scrape. If its
completion marker is absent, it uses the last broad completed scan in
`data/scan-runs.tsv`, or its bootstrap default. Do not calculate routine hours
manually. The wrapper also respects an existing explicitly accepted cutoff
(`data/scan-all-accepted-through.json`); never create or advance one merely to
hide missing coverage. Clear an inherited `JOBSPY_HOURS` unless the user explicitly requests
an override; only then supply their positive whole-number hours as
`JOBSPY_HOURS` instead of unsetting it.

The script runs ATS discovery, JobSpy, ingestion, and built-in repair. Keep its
process/session handle and wait for that same process's final ingest and repair
output and exit status. It checks per-process native ATS and JobSpy health
receipts before advancing the success marker. Missing/stale receipts, provider
errors, an unavailable LinkedIn query, or request/page budgets that truncate
coverage leave the marker unchanged. A file or exit code alone is insufficient. If interrupted or a stage fails,
report partial progress and preserve written state; do not claim a full scan.
Check the completion marker afterward as supporting evidence, never as a
substitute for the current process's output.
The wrapper has no safe `--dry-run`/`--help` preview; inspect its source instead.

## Report and stop

Report the window, ATS additions, JobSpy ingested additions, pending queue
change, and repair results from this run. State observed coverage limits such
as provider errors, NVIDIA page limits, LinkedIn per-query caps, or unrepaired
metadata. Do not claim exhaustive coverage. Keep the configured healthy source
defaults; probe quarantined Glassdoor only when explicitly requested.
Defaults are Indeed and LinkedIn. LinkedIn requests have shared pacing and
hard budgets; a 429 pauses that source. Do not add authenticated sessions or
proxies, or start a separate recovery run without its requested scope. Existing
recovery helpers retain checkpoints when that work is requested. Captured rows remain
usable even when the overall window is incomplete. Correlate `local/source-health.json` and
scan receipts with this run; distinguish a provider failure from zero matches
or filtering. A partial ATS/provider result remains partial even when the other
sources add jobs.

Stop after discovery, ingestion, and the script's built-in repair. Do not run
separate hydration, triage, evaluation, packaging, updates, sending, or
submissions. The script's `Next:` footer, the broader scan mode, and
`next-step.mjs` do not authorize advancing to another stage.
