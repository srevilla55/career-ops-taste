# Optional discovery and orchestration

These source files extend the core scanner with JobSpy, cached JD repair,
resumable triage/evaluation helpers, and a read-only Gmail OAuth connector.
Candidate targeting and all runtime state stay private.

## Configure

```sh
cp local/search.example.json local/search.json
uv sync --project local --locked
uv run --project local python local/jobspy_fetch.py --check-config
```

Replace every placeholder in `local/search.json`. The configuration selects
`sites`, `hours_old`, `country_indeed`, exact `roles`, location `query`/`results`,
optional `location_aliases`, and priority patterns. Four priority weights must
sum to 1; regex weights must be between 0 and 1. Priority changes review order,
not candidate fit or eligibility. Missing patterns use neutral defaults.

The Python config check makes no network requests. Missing, malformed, or
placeholder targeting fails before JobSpy provider calls. Private search
configuration can also be selected with `--config` or
`CAREER_OPS_SEARCH_CONFIG`.

## Discover

```sh
./local/orchestration/scan-all.sh
./local/orchestration/today.sh
```

The discovery wrapper runs the core scanner, JobSpy, canonical ingestion and
repair. It deduplicates against the existing pipeline, tracker and history.
It does not run an AI model, evaluate a candidate, generate an application,
send mail or submit a form. No background schedule is installed.

The automatic lookback starts from the newer full success or explicitly
accepted partial cutoff. `JOBSPY_HOURS=N` overrides it. Incomplete source
receipts do not silently advance the full-success marker.

LinkedIn searches are cards-only: missing text is not repaired through guest
detail requests. Cached text, the employer posting, or a pasted JD can resolve
those leads. Search requests share pacing, request budgets, locks and persisted
cooldowns. HTTP 429 stops the run and saves unfinished work for a later resume.

The default LinkedIn delay is 65 seconds. The wrapper reads only a validated
numeric `JOBSPY_LINKEDIN_DELAY` from the ignored root `.env`; an explicit process
environment value wins. It never exports Gmail secrets to scraper children.
Raw Python invocations use their environment or the default. A small clean
diagnostic does not establish sustained freedom from throttling.

Indeed and LinkedIn are the example defaults. Glassdoor and Google remain
explicit diagnostic options, because previous provider failures do not justify
routine retries. Some ATS feeds also cap results: useful rows are retained,
and partial coverage remains visible.

## Other stages

- `hydrate-descriptions.py` reuses captured LinkedIn text and supports configured
  Glassdoor repair; it never retries LinkedIn guest details.
- `orchestration/hydrate-jds.mjs` maintains JD captures and uncertainty.
- `orchestration/triage-all.mjs` persists resumable pre-screen verdicts.
- `orchestration/resume-batch-state.mjs` recovers existing evaluation artifacts.
- `orchestration/next-step.mjs --brain codex --json` reports what is due; it
  does not authorize the next stage.
- `gmail-oauth.mjs --client /absolute/path/client_secret.json` performs Google's
  Desktop OAuth flow and saves read-only credentials locally. Follow
  [`docs/LINKEDIN_JOBS.md`](../docs/LINKEDIN_JOBS.md) before running an import.

Read current help and mode instructions before running a stage. Model calls
require authorization covering the current candidate data, roles and model.
Source or fixture checks must not be confused with real evaluations.

## Offline checks

```sh
uv run --project local python local/test_jobspy_compat.py
node --test tests/jobspy-ingest.test.mjs
```

The integration check uses mocked providers and simulated pacing. It covers
partial results, hard request limits, cooldowns, source receipts and resumable
checkpoints without a live scraping test.

`search.json`, `.env`, `.venv/`, caches, source-health receipts, cooldowns,
checkpoints, canary runs, JDs, reports and generated output are never published.
