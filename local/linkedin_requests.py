"""Pace LinkedIn card searches and reuse captured JDs with JobSpy's pinned parser."""

import os
import math
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from requests.exceptions import RequestException
from requests.adapters import HTTPAdapter

from jobspy.linkedin import LinkedIn as UpstreamLinkedIn
from urllib3.util.retry import Retry
from urllib3.exceptions import InvalidHeader

DELAY = float(os.environ.get("JOBSPY_LINKEDIN_DELAY", "65"))
if not 0 < DELAY <= 300:
    raise ValueError("JOBSPY_LINKEDIN_DELAY must be between 0 and 300 seconds")
COOLDOWN_FILE = Path(__file__).resolve().parent / "linkedin-retry-at.txt"
def saved_wait():
    try:
        return max(0, (datetime.fromisoformat(COOLDOWN_FILE.read_text().strip()) -
                       datetime.now(timezone.utc)).total_seconds())
    except (OSError, ValueError, TypeError):
        return 0

NEXT_REQUEST = time.monotonic() + saved_wait()
LOCK = Lock()
REQUESTS = []
FAILED_REQUESTS = 0
DETAILS = {}
RATE_LIMITED = False
PUBLIC_SEARCH = False
SINGLE_API_PAGE = False
REQUEST_LIMIT = None
REQUEST_ATTEMPTS = 0
SEARCH_SINCE = None
LAST_PAGE = {}


def save_next_request():
    COOLDOWN_FILE.write_text((datetime.now(timezone.utc) + timedelta(seconds=max(
        0, NEXT_REQUEST - time.monotonic()))).isoformat() + "\n")


def paced_get(get, *args, **kwargs):
    global NEXT_REQUEST, FAILED_REQUESTS, RATE_LIMITED, REQUEST_ATTEMPTS
    # ponytail: one-process gate; shared process locking if concurrent collectors are allowed.
    with LOCK:
        if RATE_LIMITED:
            raise RequestException("LinkedIn cooldown active; resume in a later run")
        if REQUEST_LIMIT is not None and REQUEST_ATTEMPTS >= REQUEST_LIMIT:
            raise RequestException("LinkedIn final-trial request budget exhausted")
        if REQUEST_ATTEMPTS == 0 and saved_wait() > 0:
            RATE_LIMITED = True
            raise RequestException("LinkedIn deferred until " + COOLDOWN_FILE.read_text().strip() +
                                   "; saved retry deadline is active, no waiting")
        time.sleep(max(0, NEXT_REQUEST - time.monotonic()))
        if SEARCH_SINCE is not None and "f_TPR" in kwargs.get("params", {}):
            # Keep the original lookback when request pacing or cooldowns take hours.
            hours = math.ceil((datetime.now(timezone.utc) - SEARCH_SINCE).total_seconds() / 3600)
            seconds = max(int(kwargs["params"]["f_TPR"][1:]), hours * 3600)
            kwargs["params"] = {**kwargs["params"], "f_TPR": f"r{seconds}"}
        request = {"start": kwargs.get("params", {}).get("start"), "url": args[0],
                   "kind": "search" if "/search" in args[0] else "detail",
                   "query": kwargs.get("params", {}).get("keywords"),
                   "location": kwargs.get("params", {}).get("location"),
                   "request_number": REQUEST_ATTEMPTS + 1,
                   "f_TPR": kwargs.get("params", {}).get("f_TPR"),
                   "requested_at": datetime.now(timezone.utc).isoformat()}
        REQUEST_ATTEMPTS += 1
        # Reserve the gap before HTTP too, so an interrupted request cannot burst on resume.
        NEXT_REQUEST = time.monotonic() + DELAY
        save_next_request()
        kwargs.setdefault("allow_redirects", False)
        try:
            response = get(*args, **kwargs)
        except RequestException as exc:
            NEXT_REQUEST = time.monotonic() + DELAY
            FAILED_REQUESTS += 1
            REQUESTS.append({**request, "status": None, "error": type(exc).__name__})
            save_next_request()
            raise
        NEXT_REQUEST = time.monotonic() + DELAY
        REQUESTS.append({**request, "status": response.status_code})
        if response.status_code != 200:
            FAILED_REQUESTS += 1
        if response.status_code == 429:
            try:
                retry_after = Retry().get_retry_after(response) or 0
            except InvalidHeader:
                retry_after = 0
            cooldown = max(retry_after, 1800)
            NEXT_REQUEST = time.monotonic() + cooldown
            RATE_LIMITED = True
            searches = sum(r["kind"] == "search" for r in REQUESTS)
            print(f"LinkedIn HTTP 429 after {REQUEST_ATTEMPTS} HTTP requests "
                  f"({searches} search, {REQUEST_ATTEMPTS - searches} detail), "
                  f"offset {request['start']}: stop requests; cooldown at least {cooldown:.0f}s",
                  file=sys.stderr, flush=True)
        # Carry the next allowed request time across the search/repair subprocesses.
        save_next_request()
        return response


def load_saved_details():
    for path in (Path(__file__).resolve().parent.parent / "jds/jobspy").glob("*.md"):
        text = path.read_text(errors="replace")
        match = re.search(r"Original URL:\*\* https://www.linkedin.com/jobs/view/(\d+)", text)
        head, separator, body = text.partition("\n## Description\n")
        if match and separator and body.strip() and "lang:unknown" not in head \
                and "**Detected JD language:** unknown" not in head:
            DETAILS[match[1]] = {"description": body.strip()}


class LinkedIn(UpstreamLinkedIn):
    """Use upstream parsing, plus a shared request gate and description cache."""

    @property
    def session(self):
        return self._session

    @session.setter
    def session(self, session):
        # JobSpy 1.4 creates its session in scrape(), rather than its constructor.
        session.mount("https://", HTTPAdapter(max_retries=0))
        session.mount("http://", HTTPAdapter(max_retries=0))
        original = session.get
        session.get = lambda *a, **kw: paced_get(original, *a, **kw)
        self._session = session

    def initialize_session(self, scraper_input):
        from jobspy.linkedin.constant import headers
        from jobspy.util import RequestsRotating, create_session
        self.scraper_input = scraper_input
        self.session = create_session(RequestsRotating(scraper_input.proxies,
                                      clear_cookies=True), scraper_input, headers)

    def _fetch_details(self, job_id):
        # LinkedIn JD guard: reuse captured text; guest detail requests are not a fallback.
        return DETAILS.get(str(job_id), {})

    def scrape(self, scraper_input):
        if not PUBLIC_SEARCH and not SINGLE_API_PAGE:
            return super().scrape(scraper_input)
        # One-page mode bypasses upstream's automatic pagination after malformed cards.
        from bs4 import BeautifulSoup
        if SINGLE_API_PAGE and scraper_input.fetch_description:
            raise ValueError("final-trial pages must not fetch descriptions")
        self.initialize_session(scraper_input)
        LAST_PAGE.clear()
        endpoint = "/jobs/search/" if PUBLIC_SEARCH else "/jobs-guest/jobs/api/seeMoreJobPostings/search"
        params = self._search_params()
        if SINGLE_API_PAGE:
            params["start"] = scraper_input.offset
        options = {"allow_redirects": False} if SINGLE_API_PAGE else {}
        try:
            response = self.session.get(f"{self.base_url}{endpoint}", params=params,
                                        **options)
        except RequestException as exc:
            self.fail(str(exc))
            return []
        if response.status_code != 200:
            self.fail(f"response status code {response.status_code}")
            return []
        jobs = []
        cards = BeautifulSoup(response.text, "html.parser").find_all(class_="base-search-card")
        LAST_PAGE.update(cards=len(cards), offset=scraper_input.offset)
        if REQUESTS:
            REQUESTS[-1]["cards_received"] = len(cards)
        from jobspy.linkedin.constant import empty_page
        if not cards and response.text.strip() != empty_page:
            self.fail("unexpected page with no jobs (blocked?)")
        if SINGLE_API_PAGE:
            cards = cards[:scraper_input.results_wanted]
        for card in cards:
            job_id = card.get("data-entity-urn", "").split(":")[-1]
            if not job_id:
                continue
            try:
                jobs.append(self._process_job(card, job_id))
            except (AttributeError, ValueError, TypeError) as exc:
                print(f"LinkedIn: skipping malformed search card: {exc}", file=sys.stderr)
        return jobs
