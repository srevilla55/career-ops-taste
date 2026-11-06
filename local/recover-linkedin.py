#!/usr/bin/env python3
"""Resume the configured LinkedIn search quotas, then repair accepted postings.

Search cards first: only accepted, incomplete queue entries need detail GETs.
Uses JobSpy's parser and the existing ingest/apply writers; never advances the
full-scrape marker. --since must name the beginning of the missed window.
"""

import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

import jobspy_fetch as fetch
import linkedin_requests

ROOT = Path(__file__).resolve().parent.parent


def queries_for_window(since, until, step_hours=None):
    """Guest API has a lookback, not an upper date bound: expand cumulatively."""
    if step_hours:
        if step_hours < 1:
            raise ValueError("step hours must be positive")
        starts = []
        start = until
        while start > since:
            start = max(since, start - timedelta(hours=step_hours))
            starts.append(start)
        # ponytail: overlapping lookbacks use URL dedup; exact older-day slices need API support.
        return [{"role": role, "location": loc, "wanted": 1000,
                 "offset": 0, "status": "pending", "since": start.isoformat()}
                for start in starts for role, loc, _ in fetch.searches()]
    hours = math.ceil((until - since).total_seconds() / 3600) + 1
    scale = max(1, math.ceil(hours / fetch.HOURS_OLD))
    return [{"role": role, "location": loc, "wanted": wanted * scale,
             "offset": 0, "status": "pending"}
            for role, loc, wanted in fetch.searches()]


save = fetch.save


def main():
    fetch.configure_search(fetch.load_search_config())
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--since", required=True, help="timezone-aware ISO timestamp")
    ap.add_argument("--state", type=Path, required=True)
    ap.add_argument("--request-budget", type=int, default=64,
                    help="maximum LinkedIn search requests this invocation (default 64); resume the saved checkpoint later")
    ap.add_argument("--public-search", action="store_true",
                    help="recover one public search page per query; no pagination")
    ap.add_argument("--step-hours", type=int,
                    help="start with this lookback, then widen it in saved steps; "
                         "the API cannot isolate historical start/end dates")
    args = ap.parse_args()
    if args.request_budget < 1:
        ap.error("--request-budget must be positive")
    since = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
    if since.tzinfo is None or since > datetime.now(timezone.utc):
        ap.error("--since must include a timezone and be in the past")
    if args.step_hours is not None and (args.step_hours < 1 or args.public_search):
        ap.error("--step-hours must be positive and is only for API recovery")
    args.state = args.state.resolve()
    args.state.parent.mkdir(parents=True, exist_ok=True)
    with args.state.with_suffix(".lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            ap.error("this recovery is already running")
        run(args, since)



def run(args, since):
    hours = math.ceil((datetime.now(timezone.utc) - since).total_seconds() / 3600) + 1
    step_hours = getattr(args, "step_hours", None)
    if args.state.exists():
        state = json.loads(args.state.read_text())
        if state.get("strategy") == "bounded_final_trial":
            raise ValueError("historical diagnostic checkpoints cannot be reused by generic recovery")
        if state["since"] != args.since:
            raise ValueError("existing state belongs to a different window")
        if state.get("public_search", False) != args.public_search:
            raise ValueError("use separate state files for API and public searches")
        if state.get("step_hours") != step_hours:
            raise ValueError("use separate state files for stepped and broad lookbacks")
    else:
        until = datetime.now(timezone.utc)
        state = {"since": args.since, "public_search": args.public_search,
                 "started": until.isoformat(), "step_hours": step_hours,
                 "rows": {}, "queries": queries_for_window(since, until, step_hours)}
        if step_hours:
            state["window_end"] = until.isoformat()
            state["strategy"] = "cumulative_lookbacks"
        save(args.state, state)
    linkedin_requests.PUBLIC_SEARCH = args.public_search
    linkedin_requests.SINGLE_API_PAGE = not args.public_search
    linkedin_requests.REQUEST_LIMIT = linkedin_requests.REQUEST_ATTEMPTS + getattr(args, "request_budget", 64)
    linkedin_requests.SEARCH_SINCE = since
    raw = args.state.with_name(args.state.stem + "-rows.json")
    env = dict(os.environ, SCAN_MAX_POSTING_AGE_DAYS=str(math.ceil(hours / 24) + 1))

    def ingest():
        save(raw, list(state["rows"].values()))
        if state["rows"]:
            subprocess.run(["node", "local/ingest-jobspy.mjs", "--file", str(raw)],
                           cwd=ROOT, env=env, check=True)

    # Rescue cards saved just before an interrupted ingest, even for completed queries.
    ingest()
    if state.get("retry_at") and datetime.fromisoformat(state["retry_at"]) > datetime.now(timezone.utc):
        raise SystemExit(f"LinkedIn deferred until {state['retry_at']}; no waiting")

    for i, query in enumerate(state["queries"], 1):
        if query["status"] in ("quota_reached", "public_result_ended", "public_first_page_only", "repeated_page"):
            continue
        while query["offset"] < query["wanted"]:
            if linkedin_requests.REQUEST_ATTEMPTS >= linkedin_requests.REQUEST_LIMIT:
                query["status"] = "budget_paused"
                state["coverage"] = "partial"
                state["paused_reason"] = "request budget exhausted; saved page can resume"
                save(args.state, state)
                ingest()
                raise SystemExit("LinkedIn request budget exhausted; progress saved")
            # Calculate the window after a long saved cooldown, preserving its start.
            query_since = datetime.fromisoformat(query["since"]) if "since" in query else since
            linkedin_requests.SEARCH_SINCE = query_since
            hours = max(1, math.ceil((datetime.now(timezone.utc) - query_since).total_seconds() / 3600))
            env["SCAN_MAX_POSTING_AGE_DAYS"] = str(math.ceil(
                (datetime.now(timezone.utc) - since).total_seconds() / 86400) + 1)
            failures = linkedin_requests.FAILED_REQUESTS
            query_errors = len(fetch.QUERY_ERRORS.get("linkedin", []))
            linkedin_requests.LAST_PAGE.clear()
            print(f"Recovery {i}/{len(state['queries'])}: {query['role']} @ {query['location']}, "
                  f"offset {query['offset']}/{query['wanted']}, window {hours}h", flush=True)
            wanted = min(10, query["wanted"] - query["offset"])
            rows = fetch.scrape_one("linkedin", query["role"], query["location"],
                                   wanted, hours, True, False, offset=query["offset"])
            for row in rows:
                # Parsed dates have day precision; keep unknown dates uncertain.
                posted = row.get("date_posted")
                if step_hours and posted and not (
                        since.date().isoformat() <= posted[:10] <= state["window_end"][:10]):
                    continue
                state["rows"][row["job_url"]] = row
            if linkedin_requests.FAILED_REQUESTS > failures or len(fetch.QUERY_ERRORS.get("linkedin", [])) > query_errors:
                query["status"] = "blocked"
                state["retry_at"] = (datetime.now(timezone.utc) + timedelta(seconds=max(
                    0, linkedin_requests.NEXT_REQUEST - time.monotonic()))).isoformat()
            elif args.public_search:
                query["status"] = "public_first_page_only" if rows else "public_result_ended"
            else:
                cards = linkedin_requests.LAST_PAGE.get("cards", len(rows))
                urls = {row["job_url"] for row in rows}
                seen = set(query.get("seen_urls", []))
                repeated = bool(urls) and query["offset"] > 0 and urls <= seen
                query["seen_urls"] = sorted(seen | urls)
                query["offset"] += cards
                query["status"] = ("repeated_page" if repeated else
                                   "quota_reached" if query["offset"] >= query["wanted"] else
                                   "public_result_ended" if cards < wanted else "pending")
            save(args.state, state)
            if step_hours:
                ingest()  # save accepted cards after every page, before another wait
            if query["status"] != "pending":
                break
        ingest()
        print(f"Saved {len(state['rows'])} unique cards; query {query['status']}", flush=True)
        if query["status"] == "blocked":
            print("Recovery paused at the failed page; rerun this command after cooldown.",
                  file=sys.stderr)
            raise SystemExit(1)

    if any(q["status"] == "repeated_page" for q in state["queries"]):
        state["coverage"] = "partial"
        state["paused_reason"] = "repeated search page; remaining coverage is unverified"
        save(args.state, state)
        raise SystemExit(state["paused_reason"])

    if step_hours and any(q["status"] == "quota_reached" for q in state["queries"]):
        state["paused_reason"] = "API 1000-result cap reached; narrower targeting is needed"
        save(args.state, state)
        raise SystemExit("API result cap leaves this recovery incomplete")

    # Repair only accepted LinkedIn rows; the existing writer updates their JD and queue.
    select = """
import {readFileSync} from 'node:fs';
import {locationSlot} from './local/apply-descriptions.mjs';
for (const line of readFileSync('data/pipeline.md','utf8').split('\\n')) {
  if (!line.startsWith('- [ ] ') || !/\\bsrc:linkedin\\b/.test(line)) continue;
  if (!/\\blang:unknown\\b/.test(line) && locationSlot(line).present) continue;
  const url=line.match(/\\burl:(\\S+)\\s*$/)?.[1];
  if (url) console.log(url);
}
"""
    urls = subprocess.check_output(["node", "--input-type=module", "-e", select],
                                   cwd=ROOT, text=True)
    descriptions = args.state.with_name(args.state.stem + "-descriptions.json")
    if urls.strip():
        print(f"Repairing {len(urls.splitlines())} accepted LinkedIn postings", flush=True)
        # The detail transport defers saved retry deadlines without blocking.
        with descriptions.open("w") as out:
            result = subprocess.run([sys.executable, "local/hydrate-descriptions.py"],
                                    cwd=ROOT, input=urls, text=True, stdout=out)
        if result.returncode in (0, 2):
            subprocess.run(["node", "local/apply-descriptions.mjs", "--file",
                            str(descriptions)], cwd=ROOT, env=env, check=True)
        if result.returncode == 2 and linkedin_requests.saved_wait() > 0:
            state["retry_at"] = (datetime.now(timezone.utc) + timedelta(
                seconds=linkedin_requests.saved_wait())).isoformat()
    remaining = subprocess.check_output(["node", "--input-type=module", "-e", select],
                                       cwd=ROOT, text=True)
    state["remaining_incomplete"] = remaining.splitlines()
    state["finished"] = datetime.now(timezone.utc).isoformat()
    if not remaining.strip():
        state.pop("retry_at", None)
    save(args.state, state)
    print(f"Recovery finished: {len(state['rows'])} unique cards; "
          f"{len(state['remaining_incomplete'])} accepted postings still incomplete. "
          "Configured quotas and public empty pages limit coverage.", flush=True)


if __name__ == "__main__":
    main()
