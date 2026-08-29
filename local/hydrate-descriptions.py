#!/usr/bin/env python3
"""Repair postings captured without JD text or without a location.

Needed because dedup is durable: once a URL is in data/scan-history.tsv, a
re-scan correctly refuses to re-add it. The 205 LinkedIn description stubs from
the first run, and the 53 rows jobspy stripped the location off (see
jobspy_patches.py, bug A), can only be repaired by fetching them directly.

Not a one-shot. Any future run where LinkedIn rate-limits mid-way leaves stubs
behind, and this repairs those too.

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

from bs4 import BeautifulSoup

import jobspy_patches
from jobspy.glassdoor import Glassdoor
from jobspy.linkedin import LinkedIn
from jobspy.model import Country, DescriptionFormat, ScraperInput
from jobspy.util import markdown_converter, remove_attributes

jobspy_patches.apply()

LINKEDIN_ID = re.compile(r"/jobs/view/(\d+)")
GLASSDOOR_ID = re.compile(r"[?&]jl=(\d+)")

# The job page carries the location the search card sometimes omits. Two class
# names because LinkedIn serves both layouts; the first that hits wins.
LOCATION_CLASSES = ("topcard__flavor--bullet", "sub-nav-cta__meta-text")


def _scraper_input():
    return ScraperInput(site_type=[], search_term="",
                        description_format=DescriptionFormat.MARKDOWN)


class Fetchers:
    """Lazily built so we only pay for the sites actually present in the input."""

    def __init__(self):
        self._linkedin = None
        self._glassdoor = None

    @property
    def linkedin(self):
        if self._linkedin is None:
            self._linkedin = LinkedIn()
            self._linkedin.scraper_input = _scraper_input()
        return self._linkedin

    @property
    def glassdoor(self):
        if self._glassdoor is None:
            gd = Glassdoor()
            gd.scraper_input = _scraper_input()
            gd.base_url = Country.SPAIN.get_glassdoor_url()
            # scrape() normally builds the session and the csrf header; do it here.
            from jobspy.glassdoor.constant import fallback_token, headers
            from jobspy.util import create_session
            gd.session = create_session(has_retry=True)
            hdrs = dict(headers)
            hdrs["gd-csrf-token"] = fallback_token
            gd.session.headers.update(hdrs)
            self._glassdoor = gd
        return self._glassdoor


def _linkedin_page(scraper, job_id):
    """One GET, both fields. Upstream's _get_job_details drops the location, and
    fetching the same page twice to get it back would be silly."""
    res = scraper.session.get(f"{scraper.base_url}/jobs/view/{job_id}", timeout=10)
    res.raise_for_status()
    if "linkedin.com/signup" in res.url:
        return {}

    soup = BeautifulSoup(res.text, "html.parser")

    description = None
    body = soup.find("div", class_=lambda c: c and "show-more-less-html__markup" in c)
    if body is not None:
        description = markdown_converter(
            remove_attributes(body).prettify(formatter="html"))

    location = None
    for cls in LOCATION_CLASSES:
        tag = soup.find(class_=lambda c, want=cls: c and want in c)
        text = tag.get_text(strip=True) if tag else ""
        # The bullet spans also carry applicant counts ("27 applicants").
        if text and not text[0].isdigit():
            location = " ".join(text.split())
            break

    return {"description": description, "location": location}


def fetch_one(url, fetchers):
    """Return {description?, location?} for one URL, or {}. Never raises."""
    try:
        m = LINKEDIN_ID.search(url)
        if m:
            return _linkedin_page(fetchers.linkedin, m.group(1))
        m = GLASSDOOR_ID.search(url)
        if m:
            # Glassdoor rows always arrive with a location; only the body is at risk.
            return {"description": fetchers.glassdoor._fetch_job_description(int(m.group(1)))}
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
    args = ap.parse_args()

    urls = [ln.strip() for ln in sys.stdin if ln.strip()]
    seen = set()
    urls = [u for u in urls if not (u in seen or seen.add(u))]
    if args.limit:
        urls = urls[: args.limit]

    fetchers = Fetchers()
    out, descs, locs = [], 0, 0
    for i, url in enumerate(urls, 1):
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
        if not args.quiet and (i % 25 == 0 or i == len(urls)):
            print(f"  · {i}/{len(urls)} fetched, {descs} with text, {locs} with location",
                  file=sys.stderr)
        if args.delay and i < len(urls):
            time.sleep(random.uniform(args.delay, args.delay * 2))

    print(f"hydrate: {len(urls)} URLs → {descs} descriptions, {locs} locations",
          file=sys.stderr)
    json.dump(out, sys.stdout)
    sys.exit(0 if out else 1)


if __name__ == "__main__":
    main()
