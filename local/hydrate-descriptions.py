#!/usr/bin/env python3
"""Repair postings captured without JD text or without a location.

Needed because dedup is durable: once a URL is in data/scan-history.tsv, a
re-scan correctly refuses to re-add it. Description stubs and missing locations
can only be repaired by fetching them directly.

LinkedIn repairs reuse captured text only. Missing text needs the employer
posting or pasted JD; the guest detail endpoint is never retried.

Reads job URLs on stdin (one per line), writes [{job_url, description,
location}] to stdout — either field may be absent. Per-URL try/except, so one
dead posting never costs the rest.

    grep -o 'url:https://[^ ]*' data/pipeline.md | cut -d: -f2- \\
      | uv run local/hydrate-descriptions.py > /tmp/desc.json
"""

import argparse
import json
import random
import re
import sys
import time
from jobspy.glassdoor import Glassdoor
from jobspy.glassdoor.constant import domains, headers
import linkedin_requests
from jobspy_fetch import load_search_config
from jobspy.model import Country, DescriptionFormat, ScraperInput
from jobspy.util import TLSRotating, create_session

LINKEDIN_ID = re.compile(r"^https://(?:[\w-]+\.)?linkedin\.com/(?:comm/)?jobs/view/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)", re.I)
GLASSDOOR_ID = re.compile(r"[?&]jl=(\d+)")

def _scraper_input():
    return ScraperInput(search_term="", country_indeed=Country(load_search_config()["country_indeed"].lower()),
                        description_format=DescriptionFormat.MARKDOWN)


class Fetchers:
    """Lazily built so we only pay for the sites actually present in the input."""

    def __init__(self):
        self._glassdoor = None
        self.transport_failures = 0
        self.jd_unavailable = 0

    def observe_transport(self, session):
        request = session.request
        def observed(*args, **kwargs):
            try:
                response = request(*args, **kwargs)
            except Exception:
                self.transport_failures += 1
                raise
            if response.status_code != 200:
                self.transport_failures += 1
            return response
        session.request = observed
        return session

    @property
    def glassdoor(self):
        if self._glassdoor is None:
            gd = Glassdoor()
            gd.scraper_input = _scraper_input()
            gd.base_url = f"https://{domains[gd.scraper_input.country_indeed]}"
            gd.session = self.observe_transport(create_session(TLSRotating(gd.scraper_input.proxies),
                                                gd.scraper_input, headers))
            self._glassdoor = gd
        return self._glassdoor


def fetch_one(url, fetchers):
    """Return {description?, location?} for one URL, or {}. Never raises."""
    try:
        m = LINKEDIN_ID.search(url)
        if m:
            cached = dict(linkedin_requests.DETAILS.get(str(m.group(1)), {}))
            if not cached.get("description"):
                fetchers.jd_unavailable += 1
                print(f"  - {url}: JD unavailable; provide the employer posting or pasted text", file=sys.stderr)
            return cached
        m = GLASSDOOR_ID.search(url)
        if m:
            # Glassdoor rows always arrive with a location; only the body is at risk.
            job_id = f"gd-{m.group(1)}"
            details = fetchers.glassdoor._fetch_details([job_id]).get(job_id, {})
            return {"description": details.get("description")}
    except Exception as exc:  # noqa: BLE001 — a dead posting is not a run failure
        print(f"  ! {url}: {type(exc).__name__}: {exc}", file=sys.stderr)
        return {}
    print(f"  - {url}: no fetcher for this host, skipped", file=sys.stderr)
    return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--delay", type=float, default=0.4,
                    help="base seconds between requests (jittered), default 0.4")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--linkedin-request-budget", type=int, default=32,
                    help="legacy request cap; LinkedIn JD repair is cache-only")
    args = ap.parse_args()
    if args.delay < 0 or args.limit is not None and args.limit < 1 or args.linkedin_request_budget < 1:
        ap.error("--delay must be nonnegative; --limit and --linkedin-request-budget must be positive")
    linkedin_requests.REQUEST_LIMIT = linkedin_requests.REQUEST_ATTEMPTS + args.linkedin_request_budget
    linkedin_requests.load_saved_details()

    urls = [ln.strip() for ln in sys.stdin if ln.strip()]
    seen = set()
    urls = [u for u in urls if not (u in seen or seen.add(u))]
    if args.limit:
        urls = urls[: args.limit]

    fetchers = Fetchers()
    out, descs, locs = [], 0, 0
    budget_exhausted = False
    for i, url in enumerate(urls, 1):
        if LINKEDIN_ID.search(url) and linkedin_requests.REQUEST_ATTEMPTS >= linkedin_requests.REQUEST_LIMIT:
            budget_exhausted = True
            print("hydrate: LinkedIn request budget exhausted; preserving completed repairs", file=sys.stderr)
            break
        got = fetch_one(url, fetchers) or {}
        row = {"job_url": url}
        if got.get("description"):
            row["description"] = got["description"]
            descs += 1
        if got.get("location"):
            row["location"] = got["location"]
            locs += 1
        if len(row) > 1:
            out.append(row)
        if linkedin_requests.RATE_LIMITED:
            print("hydrate: preserving completed repairs; stopped after LinkedIn 429",
                  file=sys.stderr)
            break
        if not args.quiet and (i % 25 == 0 or i == len(urls)):
            print(f"  · {i}/{len(urls)} fetched, {descs} with text, {locs} with location",
                  file=sys.stderr)
        if args.delay and i < len(urls):
            time.sleep(random.uniform(args.delay, args.delay * 2))

    print(f"hydrate: {len(urls)} URLs → {descs} descriptions, {locs} locations",
          file=sys.stderr)
    json.dump(out, sys.stdout)
    sys.exit(2 if linkedin_requests.RATE_LIMITED or budget_exhausted or fetchers.transport_failures or fetchers.jd_unavailable
             else 0 if out else 1)


if __name__ == "__main__":
    main()
