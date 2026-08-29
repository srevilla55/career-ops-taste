# Optional JobSpy discovery layer

This directory adds LinkedIn, Indeed, and Glassdoor discovery to career-ops.
It saves job descriptions locally, applies the same deterministic filters as
the built-in scanner, deduplicates board mirrors, and places discoveries in the
normal pipeline. It never evaluates a candidate or submits an application.

## Mac setup

Install [uv](https://docs.astral.sh/uv/), then from the repository root:

```bash
cp local/search.example.json local/search.json
cd local
uv sync
uv run jobspy_fetch.py --check-config
```

`local/search.json` is private and ignored by Git. Replace every `YOUR_*`
placeholder. The process fails before making network requests if the file is
missing, invalid, or still contains placeholders.

## Configuration

- `sites`: JobSpy providers to query.
- `hours_old`: maximum posting age in hours.
- `country_indeed`: country name JobSpy uses for Indeed and Glassdoor.
- `roles`: exact search phrases.
- `locations`: objects with `query` and per-search `results`.
- `location_aliases`: optional Glassdoor translation; a `null` value skips that
  Glassdoor location pass.
- `priority`: four weights that sum to 1 plus ordered regex/weight lists. The
  first matching pattern wins. These scores only sort discoveries.

## Run

```bash
./local/orchestration/scan-all.sh
./local/orchestration/today.sh
```

Or inspect a small live sample without ingesting it:

```bash
cd local
uv run jobspy_fetch.py --limit 1
```

Useful overrides are `--config`, `--sites`, `--hours`, and
`CAREER_OPS_SEARCH_CONFIG=/path/to/search.json`.

## Local patches and checks

`jobspy_patches.py` applies narrowly scoped runtime fixes without modifying the
virtual environment. Offline checks:

```bash
uv run python jobspy_patches.py
node ingest-jobspy.test.mjs
```

Runtime outputs (`search.json`, `.venv/`, `data/`, `source-health.json`, and
canary results) are ignored. The source and example config remain tracked.
