#!/usr/bin/env python3
"""Run a configured JobSpy search matrix and print one JSON array to stdout."""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import jobspy_patches
from jobspy import scrape_jobs

HERE = Path(__file__).resolve().parent
HEALTH_FILE = HERE / "source-health.json"
DEFAULT_CONFIG = HERE / "search.json"


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


def searches(config):
    for location in config["locations"]:
        for role in config["roles"]:
            yield role, location["query"], location["results"]


def location_for(site, location):
    """Translate locations for a site; None means skip this site for this pass."""
    return jobspy_patches.glassdoor_location(location) if site == "glassdoor" else location


def scrape_one(site, role, location, wanted, hours, country, verbose, li_desc=True):
    """Scrape one site. A broken provider returns no rows instead of killing the run."""
    try:
        frame = scrape_jobs(
            site_name=[site],
            search_term=role,
            google_search_term=f"{role} jobs in {location}",
            location=location,
            results_wanted=wanted,
            hours_old=hours,
            country_indeed=country,
            description_format="markdown",
            linkedin_fetch_description=li_desc,
            verbose=0,
        )
    except Exception as exc:  # a third-party scraper may raise anything
        print(f"  ! {site:<10} {role} @ {location}: {type(exc).__name__}: {exc}", file=sys.stderr)
        return []
    if frame is None or frame.empty:
        return []
    records = json.loads(frame.to_json(orient="records", date_format="iso"))
    for record in records:
        record.update(site=site, search_role=role, search_location=location)
    if verbose:
        described = sum(1 for record in records if record.get("description"))
        print(f"  · {site:<10} {role} @ {location}: {len(records)} ({described} with description)", file=sys.stderr)
    return records


def write_health(sites, rows_per_site, searches_per_site):
    try:
        previous = json.loads(HEALTH_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = {}
    today = datetime.now(timezone.utc).date().isoformat()
    health = {}
    for site in sites:
        rows = rows_per_site.get(site, 0)
        healthy = rows > 0
        health[site] = {
            "status": "healthy" if healthy else "degraded",
            "rows_last_run": rows,
            "searches_attempted": searches_per_site.get(site, 0),
            "last_success": today if healthy else previous.get(site, {}).get("last_success"),
            "reason": None if healthy else "returned nothing on every search",
        }
    for site, prior in previous.items():
        health.setdefault(site, prior)
    health["_checked"] = today
    try:
        HEALTH_FILE.write_text(json.dumps(health, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"jobspy: could not write {HEALTH_FILE.name}: {exc}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config")
    parser.add_argument("--sites", help="comma-separated override")
    parser.add_argument("--hours", type=int, help="hours-old override")
    parser.add_argument("--limit", type=int, help="only run the first N role/location searches")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--check-config", action="store_true")
    parser.add_argument("--no-linkedin-descriptions", dest="li_desc", action="store_false", default=True)
    args = parser.parse_args()

    try:
        config = load_search_config(args.config)
    except ValueError as exc:
        parser.error(str(exc))
    jobspy_patches.configure_location_aliases(config.get("location_aliases", {}))
    jobspy_patches.apply()
    if args.check_config:
        print("search config: OK")
        return

    sites = [x.strip() for x in args.sites.split(",") if x.strip()] if args.sites else config["sites"]
    hours = args.hours or config["hours_old"]
    matrix = list(searches(config))
    if args.limit is not None:
        matrix = matrix[: max(0, args.limit)]

    out = []
    rows_per_site = {site: 0 for site in sites}
    searches_per_site = {site: 0 for site in sites}
    for role, location, wanted in matrix:
        for site in sites:
            site_location = location_for(site, location)
            if site_location is None:
                continue
            searches_per_site[site] += 1
            rows = scrape_one(site, role, site_location, wanted, hours, config["country_indeed"], not args.quiet, args.li_desc)
            rows_per_site[site] += len(rows)
            out.extend(rows)

    described = sum(1 for row in out if row.get("description"))
    print(f"jobspy: {len(out)} rows from {len(matrix)} searches x {len(sites)} sites | {described}/{len(out)} with a description", file=sys.stderr)
    write_health(sites, rows_per_site, searches_per_site)
    json.dump(out, sys.stdout)
    raise SystemExit(0 if out else 1)


if __name__ == "__main__":
    main()
