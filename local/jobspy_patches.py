#!/usr/bin/env python3
"""Small runtime fixes for JobSpy's Glassdoor and LinkedIn scrapers.

The patch keeps one-part LinkedIn locations, tolerates unknown country names,
joins Glassdoor URLs safely, URL-encodes location queries, and accepts GraphQL
responses that contain usable data alongside peripheral errors. It never edits
site-packages and is safe to apply repeatedly.
"""

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote


from jobspy.exception import GlassdoorException
from jobspy.glassdoor import Glassdoor, log as gd_log
from jobspy.glassdoor.util import get_cursor_for_page
from jobspy.linkedin import LinkedIn
from jobspy.model import Country, DescriptionFormat, Location
from jobspy.util import markdown_converter

# Candidate-specific aliases come from ignored local/search.json.
LOCATION_ALIASES = {}


def configure_location_aliases(aliases):
    """Replace the active Glassdoor alias map with validated config values."""
    LOCATION_ALIASES.clear()
    LOCATION_ALIASES.update(aliases)

_JOB_DETAIL_QUERY = (
    "query JobDetailQuery($jl: Long!, $queryString: String, $pageTypeEnum: PageTypeEnum) {"
    "  jobview: jobView(listingId: $jl, contextHolder: {queryString: $queryString,"
    "  pageTypeEnum: $pageTypeEnum}) { job { description __typename } __typename } }"
)


def _root(scraper):
    """Base URL with no trailing slash, for call sites that add their own."""
    return scraper.base_url.rstrip("/")


def _get_location(self, location, is_remote):
    if not location or is_remote:
        return "11047", "STATE"  # Glassdoor's "remote" pseudo-location
    url = (f"{_root(self)}/findPopularLocationAjax.htm"
           f"?maxLocationsToReturn=10&term={quote(location)}")
    res = self.session.get(url)
    if res.status_code != 200:
        return None, None
    items = res.json()
    if not items:
        return None, None
    kind = {"C": "CITY", "S": "STATE", "N": "COUNTRY"}.get(
        items[0]["locationType"], items[0]["locationType"])
    return int(items[0]["locationId"]), kind


def _fetch_jobs_page(self, scraper_input, location_id, location_type, page_num, cursor):
    jobs = []
    self.scraper_input = scraper_input
    try:
        payload = self._add_payload(location_id, location_type, page_num, cursor)
        response = self.session.post(f"{_root(self)}/graph", timeout_seconds=15, data=payload)
        if response.status_code != 200:
            raise GlassdoorException(f"bad response status code: {response.status_code}")
        res_json = response.json()[0]
        listings = ((res_json.get("data") or {}).get("jobListings") or {}).get("jobListings")
        # Only a MISSING jobListings block is fatal. An `errors` array alongside
        # intact job data is Glassdoor's normal behaviour, not a failure.
        if listings is None:
            paths = [e.get("path") for e in res_json.get("errors", [])][:3]
            raise ValueError(f"no jobListings in response (error paths: {paths})")
    except Exception as exc:  # noqa: BLE001 — mirrors upstream: log, return empty
        gd_log.error(f"Glassdoor: {exc}")
        return jobs, None

    with ThreadPoolExecutor(max_workers=self.jobs_per_page) as executor:
        futures = {executor.submit(self._process_job, job): job for job in listings}
        for future in as_completed(futures):
            try:
                job_post = future.result()
            except Exception:  # noqa: BLE001 — one bad row must not lose the page
                continue
            if job_post:
                jobs.append(job_post)

    return jobs, get_cursor_for_page(
        res_json["data"]["jobListings"]["paginationCursors"], page_num + 1)


def _fetch_job_description(self, job_id):
    # Must go through self.session (tls_client), NOT plain requests. Upstream
    # used requests.post and Glassdoor now answers that with 403 on every call
    # — swallowed by upstream's bare `except`, which is why every row arrived
    # with description=None. Verified: session 4/4, plain requests 0/4.
    # The session is shared across _process_job's thread pool; that is fine for
    # tls_client, and jobs_per_page caps it at 30.
    body = [{
        "operationName": "JobDetailQuery",
        "variables": {"jl": job_id, "queryString": "q", "pageTypeEnum": "SERP"},
        "query": _JOB_DETAIL_QUERY,
    }]
    res = self.session.post(f"{_root(self)}/graph", timeout_seconds=20, data=json.dumps(body))
    if res.status_code != 200:
        return None
    desc = res.json()[0]["data"]["jobview"]["job"]["description"]
    if desc and self.scraper_input.description_format == DescriptionFormat.MARKDOWN:
        return markdown_converter(desc)
    return desc


def glassdoor_location(location):
    """Translate a search-matrix location for Glassdoor. None means 'skip'."""
    return LOCATION_ALIASES.get(location, location)


# ── LinkedIn ────────────────────────────────────────────────────────────────

def _country_or_raw(name):
    """Country enum when jobspy knows it, else the raw string. Never raises."""
    try:
        return Country.from_string(name)
    except ValueError:
        # Kosovo, Iceland, Albania, ... Location.country accepts a plain str and
        # display_location() renders it as-is, so nothing downstream cares.
        return name


def parse_linkedin_location(text, home):
    """Split a LinkedIn job-card location string into a Location.

    Split out from _li_get_location so the self-check can exercise it without
    a network call or a BeautifulSoup tag.
    """
    text = (text or "").strip()
    if not text or text == "N/A":
        return Location(country=home)
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if len(parts) == 1:
        # Upstream returns a bare worldwide Location here, which renders empty.
        # A region name is still filterable and rankable — keep it.
        return Location(city=parts[0], country=home)
    if len(parts) == 2:
        return Location(city=parts[0], state=parts[1], country=home)
    # 3+: last field is the country, everything between city and it is state.
    return Location(city=parts[0], state=", ".join(parts[1:-1]),
                    country=_country_or_raw(parts[-1]))


def _li_get_location(self, metadata_card):
    home = Country.from_string(self.country)  # "worldwide" — omitted from display
    if metadata_card is None:
        return Location(country=home)
    tag = metadata_card.find("span", class_="job-search-card__location")
    return parse_linkedin_location(tag.text if tag else "", home)


def apply():
    """Idempotent. Safe to call more than once."""
    Glassdoor._get_location = _get_location
    Glassdoor._fetch_jobs_page = _fetch_jobs_page
    Glassdoor._fetch_job_description = _fetch_job_description
    LinkedIn._get_location = _li_get_location


if __name__ == "__main__":
    import logging
    import sys

    logging.disable(logging.CRITICAL)
    configure_location_aliases({"City, Country": "City", "Region": None})
    apply()

    print("self-check: LinkedIn location parsing (offline) ...")
    wl = Country.from_string("worldwide")

    # Bug A: upstream renders this as "" and the row loses its location.
    area = parse_linkedin_location("Greater Example Area", wl)
    assert area.display_location() == "Greater Example Area", \
        f"one-part location dropped: {area.display_location()!r}"

    # Bug B: upstream raises ValueError here and loses the entire search.
    unknown = parse_linkedin_location("Example City, Example State, Exampleland", wl)
    assert unknown.display_location() == "Example City, Example State, Exampleland", \
        f"unknown country mangled: {unknown.display_location()!r}"

    # Known countries must still resolve to the enum, not degrade to a string.
    known = parse_linkedin_location("Austin, Texas, United States", wl)
    assert known.country is Country.from_string("United States"), f"known country lost: {known.country!r}"
    assert known.display_location() == "Austin, Texas, USA"

    # Unchanged upstream behaviour.
    assert parse_linkedin_location("London, United Kingdom", wl).display_location() == "London, United Kingdom"
    assert parse_linkedin_location("", wl).display_location() == ""
    assert parse_linkedin_location("N/A", wl).display_location() == ""
    print("  OK")

    assert glassdoor_location("City, Country") == "City"
    assert glassdoor_location("Region") is None
    assert glassdoor_location("Unmapped") == "Unmapped"
    print("  OK")
    sys.exit(0)
