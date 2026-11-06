#!/usr/bin/env python3
"""Thin JobSpy shim: scrape the search matrix, print JSON to stdout.

Deliberately dumb. It scrapes and prints — normalization, filtering, dedup and
enqueueing all happen in ingest-jobspy.mjs, which reuses career-ops' own
primitives so both discovery sources obey one config.

One scrape_jobs() call per site keeps source counts and failures independent.
Per-site isolation means a broken LinkedIn costs LinkedIn only.

Glassdoor remains quarantined from defaults after the earlier blocked-endpoint
failure. A small successful probe does not establish sustained health. Probe it
with `--sites glassdoor`. JobSpy 1.4 exposes source failures in DataFrame attrs.
Google is also omitted from the example configuration after empty-response
failures. Explicit health probes can select either provider with `--sites`.

Usage:
    uv run jobspy_fetch.py                 # full matrix -> JSON array on stdout
    uv run jobspy_fetch.py --hours 24
    uv run jobspy_fetch.py --sites glassdoor --limit 1  # explicit health probe
    uv run jobspy_fetch.py --limit 5       # first N searches only (smoke test)
    uv run jobspy_fetch.py --no-linkedin-descriptions
"""

import argparse
from contextlib import ExitStack
import fcntl
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jobspy
from jobspy import scrape_jobs
import linkedin_requests

# The pinned public wrapper constructs this class; no installed source is edited.
from jobspy.model import Site
jobspy.SCRAPER_MAPPING[Site.LINKEDIN] = linkedin_requests.LinkedIn

HERE = Path(__file__).resolve().parent
HEALTH_FILE = HERE / "source-health.json"
QUERY_ERRORS = {}

# Glassdoor and Google are omitted on purpose — see the module docstring. Both
# remain selectable by name for explicit health probes.
SITES = ["indeed", "linkedin"]

# Candidate targeting is private configuration, never a baked-in search matrix.
DEFAULT_CONFIG = HERE / "search.json"
ROLES = []
LOCATIONS = []
LOCATION_ALIASES = {}
COUNTRY_INDEED = None
HOURS_OLD = 96


def load_search_config(path=None):
    """Load and validate the private search config. Fail before any network call."""
    config_path = Path(path or os.environ.get("CAREER_OPS_SEARCH_CONFIG", DEFAULT_CONFIG))
    if not config_path.is_file():
        raise ValueError(
            f"missing {config_path}; copy local/search.example.json to "
            "local/search.json and replace every YOUR_* placeholder"
        )
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read {config_path}: {exc}") from exc

    sites = config.get("sites")
    roles = config.get("roles")
    locations = config.get("locations")
    if not isinstance(sites, list) or not sites or not all(isinstance(x, str) and x.strip() for x in sites):
        raise ValueError("search config 'sites' must be a non-empty string array")
    if not isinstance(roles, list) or not roles or not all(isinstance(x, str) and x.strip() for x in roles):
        raise ValueError("search config 'roles' must be a non-empty string array")
    if not isinstance(locations, list) or not locations:
        raise ValueError("search config 'locations' must be a non-empty array")
    for item in locations:
        if not isinstance(item, dict) or not isinstance(item.get("query"), str) or not item["query"].strip():
            raise ValueError("each search location needs a non-empty 'query'")
        if not isinstance(item.get("results"), int) or item["results"] < 1:
            raise ValueError("each search location needs a positive integer 'results'")

    country = config.get("country_indeed")
    hours = config.get("hours_old")
    aliases = config.get("location_aliases", {})
    if not isinstance(country, str) or not country.strip():
        raise ValueError("search config 'country_indeed' must be a non-empty string")
    if not isinstance(hours, int) or hours < 1:
        raise ValueError("search config 'hours_old' must be a positive integer")
    if not isinstance(aliases, dict) or not all(
        isinstance(k, str) and (isinstance(v, str) or v is None) for k, v in aliases.items()
    ):
        raise ValueError("search config 'location_aliases' must map strings to strings or null")

    serialized = json.dumps(config)
    if "YOUR_" in serialized:
        raise ValueError("search config still contains YOUR_* placeholders")
    return config


def configure_search(config):
    global ROLES, LOCATIONS, LOCATION_ALIASES, COUNTRY_INDEED, HOURS_OLD
    ROLES = config["roles"]
    LOCATIONS = [(item["query"], item["results"]) for item in config["locations"]]
    LOCATION_ALIASES = config.get("location_aliases", {})
    COUNTRY_INDEED = config["country_indeed"]
    HOURS_OLD = config["hours_old"]


def save(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as tmp:
        json.dump(value, tmp, ensure_ascii=False)
        tmp.write("\n")
    os.replace(tmp.name, path)


def collect_linkedin(args, queries, other_rows=()):
    """Resume fair card pages; canonical ingest makes every saved page durable."""
    path = args.linkedin_state
    with ExitStack() as stack:
        state = {"version": 1, "since": linkedin_requests.SEARCH_SINCE.isoformat(),
                 "matrix": [[q["role"], q["location"]] for q in queries],
                 "pending": queries[:], "rows": [], "gaps": []}
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            lock = stack.enter_context(path.with_suffix(".lock").open("a"))
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SystemExit("LinkedIn discovery checkpoint is already in use")
            if path.exists():
                previous = json.loads(path.read_text())
                if previous.get("version") != 1 or previous.get("matrix") != state["matrix"]:
                    raise ValueError("LinkedIn checkpoint does not match this search matrix; use a separate --linkedin-state")
                if not previous.get("finished"):
                    since = datetime.fromisoformat(previous["since"])
                    if since.tzinfo is None or since > datetime.now(timezone.utc):
                        raise ValueError("Invalid LinkedIn checkpoint start")
                    state = previous
                    linkedin_requests.SEARCH_SINCE = since
                    print(f"LinkedIn: resuming {len(state['rows'])} saved rows, "
                          f"{len(state['pending'])} pending pages/queries", file=sys.stderr)

        def ingest(rows, raw):
            save(raw, rows)
            env = dict(os.environ, SCAN_MAX_POSTING_AGE_DAYS=str(
                (datetime.now(timezone.utc) - linkedin_requests.SEARCH_SINCE).days + 2))
            subprocess.run(["node", "local/ingest-jobspy.mjs", "--file", str(raw.resolve())],
                           cwd=HERE.parent, env=env, stdout=sys.stderr, check=True)

        def checkpoint():
            if path is None:
                return
            save(path, state)
            if state["rows"]:
                raw = path.with_name(path.stem + "-rows.json")
                # ponytail: replay this window through the canonical dedup writer after each page.
                ingest(state["rows"], raw)
            if not state["pending"] and not state["gaps"]:
                state["finished"] = datetime.now(timezone.utc).isoformat()
                save(path, state)

        if path is not None and other_rows:
            # Described Indeed results must reach dedup before body-less LinkedIn mirrors.
            ingest(other_rows, path.with_name(path.stem + "-other-rows.json"))
        checkpoint()  # Rescue a page saved just before an interrupted ingest.
        pending = state["pending"]
        attempted, skipped = 0, 0
        while pending:
            if linkedin_requests.RATE_LIMITED or linkedin_requests.REQUEST_ATTEMPTS >= linkedin_requests.REQUEST_LIMIT:
                skipped = sum(q["offset"] == 0 for q in pending)
                break
            query = pending.pop(0)
            attempted += int(query["offset"] == 0)
            previous_errors = len(QUERY_ERRORS.get("linkedin", []))
            linkedin_requests.LAST_PAGE.clear()
            got = scrape_one("linkedin", query["role"], query["location"],
                             query["wanted"] if args.li_desc else min(10, query["wanted"] - query["offset"]),
                             args.hours, not args.quiet, args.li_desc, offset=query["offset"])
            state["rows"].extend(got)
            if len(QUERY_ERRORS.get("linkedin", [])) > previous_errors:
                pending.insert(0, query)
                checkpoint()
                skipped = sum(q["offset"] == 0 for q in pending[1:])
                break
            if not args.li_desc:
                cards = linkedin_requests.LAST_PAGE.get("cards", len(got))
                urls = {r["job_url"] for r in got}
                seen = set(query.get("seen_urls", []))
                if urls and query["offset"] and urls <= seen:
                    state["gaps"].append(f"repeated search page at offset {query['offset']}")
                else:
                    query["seen_urls"] = sorted(seen | urls)
                    query["offset"] += cards
                    if cards >= 10 and query["offset"] < min(query["wanted"], 1000):
                        pending.append(query)
                    if query["offset"] >= 1000 and query["offset"] < query["wanted"]:
                        state["gaps"].append("LinkedIn 1000-result cap reached")
            checkpoint()
        complete = not pending and not state["gaps"]
        if state["gaps"]:
            QUERY_ERRORS.setdefault("linkedin", []).extend(state["gaps"])
        return state["rows"], attempted, skipped, complete


def searches():
    for location, wanted in LOCATIONS:
        for role in ROLES:
            yield role, location, wanted


def location_for(site, location):
    """Per-site location translation. None means 'skip this site for this pass'."""
    if site == "glassdoor":
        return LOCATION_ALIASES.get(location, location)
    return location


def scrape_one(site, role, location, wanted, hours, verbose, li_desc=True, offset=0):
    """Scrape a single site. Never raises — returns [] and logs on failure."""
    try:
        df = scrape_jobs(
            site_name=[site],
            search_term=role,
            google_search_term=f"{role} jobs in {location}",
            location=location,
            results_wanted=wanted,
            hours_old=hours,
            offset=offset,
            country_indeed=COUNTRY_INDEED,
            description_format="markdown",
            # Missing descriptions leave lang:unknown. Uncached detail GETs
            # share the search request gate; recovery filters cards before repair.
            fetch_description=li_desc if site == "linkedin" else True,
            verbose=0,
        )
    except Exception as exc:  # noqa: BLE001 — a scraper may raise anything
        QUERY_ERRORS.setdefault(site, []).append(f"{type(exc).__name__}: {exc}")
        print(f"  ! {site:<10} {role} @ {location}: {type(exc).__name__}: {exc}",
              file=sys.stderr)
        return []

    if df is not None:
        error = df.attrs.get("errors", {}).get(site)
        if error:
            QUERY_ERRORS.setdefault(site, []).append(error)
    if df is None or df.empty:
        return []

    records = json.loads(df.to_json(orient="records", date_format="iso"))
    for rec in records:
        # The ingest contract uses a list; upstream's DataFrame uses CSV text.
        if isinstance(rec.get("emails"), str):
            rec["emails"] = [email.strip() for email in rec["emails"].split(",")
                             if email.strip()]
        rec["site"] = site
        rec["search_role"] = role
        rec["search_location"] = location
    if verbose:
        described = sum(1 for r in records if r.get("description"))
        print(f"  · {site:<10} {role} @ {location}: {len(records)} "
              f"({described} with description)", file=sys.stderr)
    return records


def write_health(sites, rows_per_site, searches_per_site, failures=None,
                 coverage=None, skipped=None, requests_attempted=None, receipt=None, request_log=None):
    """Per-source health, so 'did Glassdoor break again?' needs no log reading."""
    try:
        previous = json.loads(HEALTH_FILE.read_text())
    except (OSError, ValueError):
        previous = {}

    today = datetime.now(timezone.utc).date().isoformat()
    health = {}
    for site in sites:
        rows = rows_per_site.get(site, 0)
        prev = previous.get(site, {})
        # Only LinkedIn's local transport counts actual HTTP. Other boards
        # expose query/parser errors, which must not masquerade as HTTP counts.
        failed = (failures or {}).get(site, 0) if site == "linkedin" else None
        complete = (coverage or {}).get(site, True)
        errors = QUERY_ERRORS.get(site, [])
        healthy = not failed and not errors and complete
        health[site] = {
            "status": "healthy" if healthy else "degraded",
            "rows_last_run": rows,
            "searches_attempted": searches_per_site.get(site, 0),
            "last_success": today if healthy else prev.get("last_success"),
            "requests_failed": failed,
            "requests_attempted": (requests_attempted or {}).get(site),
            "queries_failed": len(errors),
            "searches_skipped": (skipped or {}).get(site, 0),
            "coverage_complete": complete and not errors and not failed,
            "reason": ("; ".join(dict.fromkeys(errors)) if errors else
                       f"{failed} request(s) failed; partial results" if failed else
                       "query cap, request budget or cooldown left unfinished queries" if not complete else None),
        }
        if site == "linkedin" and request_log is not None:
            health[site].update(
                search_requests_attempted=sum(r.get("kind") == "search" for r in request_log),
                detail_requests_attempted=sum(r.get("kind") == "detail" for r in request_log),
                search_cards_received=(None if any(r.get("kind") == "search" and r.get("status") == 200
                                                  and "cards_received" not in r for r in request_log)
                                       else sum(r.get("cards_received", 0) for r in request_log)),
                last_request=request_log[-1] if request_log else None)
    # Sites not scraped this run keep whatever we knew about them.
    for site, prev in previous.items():
        health.setdefault(site, prev)
    health["_checked"] = today
    health["_checked_at"] = datetime.now(timezone.utc).isoformat()
    try:
        HEALTH_FILE.write_text(json.dumps(health, indent=2) + "\n")
    except OSError as exc:
        print(f"jobspy: could not write {HEALTH_FILE.name}: {exc}", file=sys.stderr)
    if receipt is not None:
        receipt.write_text(json.dumps(health, indent=2) + "\n")
    return health


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", type=Path, help="private search JSON; defaults to local/search.json")
    ap.add_argument("--check-config", action="store_true", help="validate configuration without network requests")
    ap.add_argument("--sites", default=None)
    ap.add_argument("--hours", type=int, default=None)
    ap.add_argument("--limit", type=int, default=None,
                    help="only run the first N (role, location) searches")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--health-file", type=Path,
                    help="also write a fresh health receipt for this invocation")
    ap.add_argument("--linkedin-request-budget", type=int, default=64,
                    help="maximum LinkedIn HTTP requests, default 64; unfinished searches stay partial")
    ap.add_argument("--linkedin-state", type=Path,
                    help="checkpoint and canonically ingest each LinkedIn card page; resume its original window")
    ap.add_argument("--linkedin-descriptions", dest="li_desc", action="store_true",
                    help="reuse cached LinkedIn descriptions during search; never fetch guest detail pages")
    ap.add_argument("--no-linkedin-descriptions", dest="li_desc",
                    action="store_false", default=False,
                    help="skip LinkedIn JD text (one fewer request per job; rows "
                         "arrive with lang:unknown and no body)")
    args = ap.parse_args()
    try:
        config = load_search_config(args.config)
        configure_search(config)
    except ValueError as exc:
        ap.error(str(exc))
    if args.check_config:
        print("Search configuration is valid; no network requests made.")
        return
    args.hours = args.hours if args.hours is not None else HOURS_OLD
    args.sites = args.sites if args.sites is not None else ",".join(config["sites"])
    if args.hours < 1:
        ap.error("--hours must be positive")
    if args.linkedin_request_budget < 1 or args.limit is not None and args.limit < 1:
        ap.error("--linkedin-request-budget and --limit must be positive")
    if args.linkedin_state is not None and args.li_desc:
        ap.error("--linkedin-state requires cards-only discovery")
    QUERY_ERRORS.clear()
    linkedin_requests.SEARCH_SINCE = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    linkedin_requests.load_saved_details()

    sites = list(dict.fromkeys(s.strip() for s in args.sites.split(",") if s.strip()))
    if not sites or any(s not in {site.value for site in Site} for s in sites):
        ap.error("--sites must name one or more supported JobSpy boards")
    matrix = list(searches())
    if not matrix:
        ap.error("no configured searches")
    if args.limit:
        matrix = matrix[: args.limit]

    out = []
    rows_per_site = {s: 0 for s in sites}
    searches_per_site = {s: 0 for s in sites}
    failures = {s: 0 for s in sites}
    coverage = {s: True for s in sites}
    skipped = {s: 0 for s in sites}
    requests_before = linkedin_requests.REQUEST_ATTEMPTS
    request_log_start = len(linkedin_requests.REQUESTS)
    failed_before = linkedin_requests.FAILED_REQUESTS
    linkedin_requests.REQUEST_LIMIT = requests_before + args.linkedin_request_budget
    linkedin_requests.SINGLE_API_PAGE = not args.li_desc
    linkedin_queries = []

    for role, location, wanted in matrix:
        for site in sites:
            site_location = location_for(site, location)
            if site_location is None:
                continue  # this site has no sensible index for this location
            # Longer windows need more result pages, or the newest roles crowd out older matches.
            expanded_wanted = wanted * max(1, (args.hours + HOURS_OLD - 1) // HOURS_OLD)
            if site == "linkedin":
                linkedin_queries.append({"role": role, "location": site_location,
                                         "wanted": expanded_wanted, "offset": 0})
                continue
            searches_per_site[site] += 1
            got = scrape_one(site, role, site_location, expanded_wanted, args.hours,
                             not args.quiet, args.li_desc)
            rows_per_site[site] += len(got)
            out.extend(got)

    # Search every query once before paginating any of them. Detail GETs happen
    # after canonical ingest filters, in the existing repair stage.
    if "linkedin" in sites:
        rows, searches_per_site["linkedin"], skipped["linkedin"], coverage["linkedin"] = collect_linkedin(args, linkedin_queries, out)
        rows_per_site["linkedin"] = len(rows)
        out.extend(rows)
        failures["linkedin"] = linkedin_requests.FAILED_REQUESTS - failed_before

    described = sum(1 for r in out if r.get("description"))
    print(f"jobspy: {len(out)} rows from {len(matrix)} searches x {len(sites)} sites "
          f"| {described}/{len(out)} with a description", file=sys.stderr)
    for site in sites:
        attempted = searches_per_site.get(site, 0)
        if attempted and rows_per_site.get(site, 0) == 0:
            print(f"jobspy: WARNING — {site} returned nothing on all {attempted} "
                  f"searches (blocked, broken, or no matches in the window)",
                  file=sys.stderr)

    health = write_health(sites, rows_per_site, searches_per_site, failures, coverage, skipped,
                          {"linkedin": linkedin_requests.REQUEST_ATTEMPTS - requests_before},
                          args.health_file, linkedin_requests.REQUESTS[request_log_start:])

    json.dump(out, sys.stdout)
    # Exit 0 as long as anything came back; the orchestrator decides what to do
    # with a partial result, and a single dead site must not fail the run.
    sys.exit(0 if out or all(health[s]["coverage_complete"] for s in sites) else 1)


if __name__ == "__main__":
    main()
