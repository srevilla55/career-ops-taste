#!/usr/bin/env python3
"""Offline integration check: uv run python test_jobspy_compat.py."""

import contextlib
from datetime import date, datetime, timedelta, timezone
import importlib.metadata
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch
from types import SimpleNamespace

import pandas as pd
from jobspy.linkedin.util import parse_location
from jobspy.linkedin import LinkedIn
from jobspy.model import JobPost, Location

import jobspy_fetch as fetch
import linkedin_requests as paced

spec = importlib.util.spec_from_file_location(
    "hydrate", Path(__file__).with_name("hydrate-descriptions.py"))
hydrate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hydrate)


FIXTURE_SEARCH = {
    "sites": ["indeed", "linkedin"], "hours_old": 96, "country_indeed": "usa",
    "roles": ["Fixture role"], "locations": [{"query": "Fixture city", "results": 10}],
    "location_aliases": {"Madrid, Spain": "Madrid", "Europe": None},
}


def check():
    fetch.configure_search(FIXTURE_SEARCH)
    assert importlib.metadata.version("python-jobspy") == "1.4.1"
    # Search and detail GETs share pacing; one 429 stops further network requests.
    clock = [0.0]
    requests_at = []
    responses = iter([Mock(status_code=200), Mock(status_code=200),
                      Mock(status_code=429, headers={"Retry-After": "3600"})])
    def get(*args, **kwargs):
        requests_at.append(clock[0])
        return next(responses)
    def sleep(seconds):
        clock[0] += seconds
    with patch.object(paced, "NEXT_REQUEST", 0.0), \
            patch.object(paced, "REQUESTS", []), \
            patch.object(paced, "FAILED_REQUESTS", 0), \
            patch.object(paced, "RATE_LIMITED", False), \
            patch.object(paced, "COOLDOWN_FILE", Mock()), \
            patch.object(paced.time, "monotonic", side_effect=lambda: clock[0]), \
            patch.object(paced.time, "sleep", side_effect=sleep):
        assert paced.paced_get(get, "https://example.test/search").status_code == 200
        assert paced.paced_get(get, "https://example.test/details").status_code == 200
        assert paced.paced_get(get, "https://example.test/search").status_code == 429
        assert paced.NEXT_REQUEST == clock[0] + 3600
        try:
            paced.paced_get(get, "https://example.test/details")
            assert False, "cooldown must prevent further network requests"
        except paced.RequestException:
            pass
    assert requests_at == [0, paced.DELAY, 2 * paced.DELAY]
    anchor = datetime(2026, 10, 2, 8, 49, tzinfo=timezone.utc)
    with patch.object(paced, "NEXT_REQUEST", 0.0), \
            patch.object(paced, "RATE_LIMITED", False), \
            patch.object(paced, "COOLDOWN_FILE", Mock()), \
            patch.object(paced, "SEARCH_SINCE", anchor), \
            patch.object(paced, "datetime", wraps=datetime) as now:
        now.now.return_value = anchor + timedelta(hours=210)
        get = Mock(return_value=Mock(status_code=200))
        paced.paced_get(get, "https://example.test/search", params={"f_TPR":"r741600", "start":20})
        assert get.call_args.kwargs["params"] == {"f_TPR":"r756000", "start":20}
    with tempfile.TemporaryDirectory() as tmp:
        spec = importlib.util.spec_from_file_location("recover", Path(__file__).with_name("recover-linkedin.py"))
        recover = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recover)
        anchor = datetime(2026, 10, 2, 8, 49, tzinfo=timezone.utc)
        end = anchor + timedelta(hours=50)
        with patch.object(fetch, "searches", return_value=[("backend", "Madrid", 40)]):
            planned = recover.queries_for_window(anchor, end, 24)
        assert [datetime.fromisoformat(q["since"]) for q in planned] == [
            end - timedelta(hours=24), end - timedelta(hours=48), anchor]
        assert all(q["wanted"] == 1000 and q["offset"] == 0 for q in planned)
        since = datetime.now(timezone.utc) - timedelta(hours=206)
        args = SimpleNamespace(since=since.isoformat(), state=Path(tmp) / "state.json",
                               public_search=False)
        recover.save(args.state, {"since": args.since, "rows": {}, "queries": [
            {"role": "backend", "location": "Madrid", "wanted": 20,
             "offset": 0, "status": "pending"}]})
        calls = [0]
        def page(site, role, location, wanted, hours, verbose, li_desc, offset):
            assert li_desc is False
            calls[0] += 1
            if calls[0] == 2:
                paced.FAILED_REQUESTS += 1
                return []
            return [{"job_url": f"https://example.test/jobs/{offset + i}"} for i in range(10)]
        with patch.object(paced, "REQUESTS", []), patch.object(paced, "FAILED_REQUESTS", 0), \
                patch.object(paced, "NEXT_REQUEST", 0.0), \
                patch.object(paced, "PUBLIC_SEARCH", False), \
                patch.object(fetch, "scrape_one", side_effect=page), \
                patch.object(recover.subprocess, "run"), \
                patch.object(recover.subprocess, "check_output", return_value=""), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            try:
                recover.run(args, since)
                assert False, "partial search must stop with saved progress"
            except SystemExit as exc:
                assert exc.code == 1
            saved = json.loads(args.state.read_text())
            assert saved["queries"][0]["offset"] == 10 and len(saved["rows"]) == 10
            assert saved["queries"][0]["status"] == "blocked"
            recover.run(args, since)
            saved = json.loads(args.state.read_text())
            assert saved["queries"][0]["status"] == "quota_reached" and len(saved["rows"]) == 20
        # A small lookback must stay small; the full backlog anchor must not override it.
        short_start = end - timedelta(hours=24)
        args.step_hours = 24
        recover.save(args.state, {"since": args.since, "step_hours": 24,
                     "window_end": end.isoformat(), "rows": {}, "queries": [
                         {"role": "backend", "location": "Madrid", "wanted": 1000,
                          "offset": 0, "status": "pending", "since": short_start.isoformat()}]})
        def short_page(*a, **kw):
            assert paced.SEARCH_SINCE == short_start
            assert a[4] == 24
            paced.FAILED_REQUESTS += 1
            return []
        with patch.object(paced, "NEXT_REQUEST", 0.0), \
                patch.object(paced, "FAILED_REQUESTS", 0), \
                patch.object(recover, "datetime", wraps=datetime) as now, \
                patch.object(fetch, "scrape_one", side_effect=short_page), \
                patch.object(recover.subprocess, "run"), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            now.now.return_value = end
            try:
                recover.run(args, anchor)
                assert False, "failed stepped page must remain resumable"
            except SystemExit as exc:
                assert exc.code == 1
        assert json.loads(args.state.read_text())["queries"][0]["status"] == "blocked"
    with patch.object(paced, "DETAILS", {"123": {"description": "Build APIs"}}), \
            patch.object(paced.UpstreamLinkedIn, "_fetch_details",
                         return_value={"description": "Build APIs"}) as details:
        assert paced.LinkedIn()._fetch_details("123")["description"] == "Build APIs"
        assert paced.LinkedIn()._fetch_details("124") == {}
        assert details.call_count == 0, "uncached LinkedIn JDs must not use guest details"
    assert fetch.SITES == ["indeed", "linkedin"]
    assert fetch.location_for("glassdoor", "Madrid, Spain") == "Madrid"
    assert fetch.location_for("glassdoor", "Europe") is None
    assert fetch.location_for("linkedin", "Europe") == "Europe"
    assert parse_location("Greater Madrid Metropolitan Area").display_location() \
        == "Greater Madrid Metropolitan Area"
    assert "Kosovo" in parse_location("Pristina, Pristina, Kosovo").display_location()

    row = {"job_url": "https://www.linkedin.com/jobs/view/123",
           "title": "Backend Engineer", "company": "Fictional Example",
           "description": "Build APIs", "location": "Madrid, Spain"}
    with patch.object(fetch, "scrape_jobs", return_value=pd.DataFrame([row])) as scrape:
        got = fetch.scrape_one("linkedin", "backend", "Madrid", 1, 48, False)
        assert got[0]["site"] == "linkedin" and got[0]["description"] == "Build APIs"
        assert scrape.call_args.kwargs["fetch_description"] is True
        assert scrape.call_args.kwargs["hours_old"] == 48
        assert "linkedin_fetch_description" not in scrape.call_args.kwargs
        fetch.scrape_one("linkedin", "backend", "Madrid", 1, 48, False, False)
        assert scrape.call_args.kwargs["fetch_description"] is False
        fetch.scrape_one("glassdoor", "backend", "Madrid", 1, 48, False, False)
        assert scrape.call_args.kwargs["fetch_description"] is True

    # Exercise upstream's real DataFrame serialization, not a guessed row shape.
    posting = JobPost(id="li-123", title=row["title"], company=row["company"],
                      job_url=row["job_url"], description=row["description"],
                      location=Location(city="Madrid", country="Spain"),
                      date_posted=date(2026, 10, 10), emails=["jobs@example.test"])
    with patch.object(LinkedIn, "scrape", return_value=[posting]), \
            patch.object(paced, "SINGLE_API_PAGE", False):
        got = fetch.scrape_one("linkedin", "backend", "Madrid", 1, 48, False)
    assert got[0]["company"] == row["company"]
    assert got[0]["emails"] == ["jobs@example.test"]
    assert got[0]["location"] == "Madrid, Spain"
    assert got[0]["date_posted"].startswith("2026-10-10")
    # Public fallback keeps the upstream row contract and performs exactly one GET.
    card = ('<div class="base-search-card" data-entity-urn="urn:li:jobPosting:123">'
            '<h3 class="base-search-card__title">Backend Engineer</h3>'
            '<h4 class="base-search-card__subtitle">Fictional Example</h4>'
            '<span class="job-search-card__location">Madrid, Spain</span>'
            '<time datetime="2026-10-10"></time></div>')
    with patch.object(paced, "PUBLIC_SEARCH", True), \
            patch.object(paced, "paced_get", return_value=Mock(status_code=200, text=card)) as get:
        got = fetch.scrape_one("linkedin", "backend", "Madrid", 10, 206, False, False)
    assert len(got) == 1 and got[0]["company"] == "Fictional Example"
    assert got[0]["location"] == "Madrid, Spain"
    assert get.call_count == 1 and get.call_args.args[1].endswith("/jobs/search/")
    assert get.call_args.kwargs["params"]["f_TPR"] == "r741600"
    # Historical private diagnostic checkpoints cannot silently become a broad scan.
    with tempfile.TemporaryDirectory() as tmp:
        args = SimpleNamespace(since=anchor.isoformat(), state=Path(tmp) / "state.json", public_search=False)
        recover.save(args.state, {"strategy": "bounded_final_trial"})
        with patch.object(fetch, "scrape_one") as scrape:
            try:
                recover.run(args, anchor)
                assert False, "legacy diagnostics must never become automatic recovery"
            except ValueError:
                pass
            scrape.assert_not_called()
    # Run only the actual wrapper's window-selection preflight in an isolated checkout.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / 'local/orchestration').mkdir(parents=True)
        (root / 'data').mkdir()
        (root / 'node_modules').symlink_to(Path(__file__).resolve().parent.parent / 'node_modules', target_is_directory=True)
        source = Path(__file__).with_name('orchestration') / 'scan-all.sh'
        preflight = source.read_text().split('# The configured four-day cutoff')[0]
        script = root / 'local/orchestration/scan-all.sh'
        script.write_text(preflight + '\nprintf "%s\\n" "$HOURS" "${SCAN_ARGS[@]}"\n')
        marker = root / 'data/scan-all-last-success'
        accepted = root / 'data/scan-all-accepted-through.json'
        old = datetime.now(timezone.utc) - timedelta(hours=72)
        cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
        marker.write_text(old.isoformat() + '\n')
        env = {k:v for k,v in os.environ.items() if k not in ('JOBSPY_HOURS', 'JOBSPY_LINKEDIN_DELAY', 'GMAIL_CLIENT_SECRET')}
        def window():
            return subprocess.run(['bash', str(script), '--since-last-scan'], env=env,
                                  capture_output=True, text=True)
        pacing_script = preflight + '\nprintf "%s|%s\\n" "$JOBSPY_LINKEDIN_DELAY" "${GMAIL_CLIENT_SECRET-unset}"\n'
        script.write_text(pacing_script)
        assert window().stdout.strip() == '65|unset'
        (root / '.env').write_text('JOBSPY_LINKEDIN_DELAY=30\nGMAIL_CLIENT_SECRET=must-not-be-exported\n')
        assert window().stdout.strip() == '30|unset'
        env['JOBSPY_LINKEDIN_DELAY'] = '17'
        assert window().stdout.startswith('17|'), 'explicit process pacing wins over .env'
        for value in ('0', '-1', '301', 'not-a-number'):
            env['JOBSPY_LINKEDIN_DELAY'] = value
            invalid = window()
            assert invalid.returncode == 2 and not invalid.stdout, 'bad pacing stops before any provider call'
        env.pop('JOBSPY_LINKEDIN_DELAY')
        (root / '.env').unlink()
        script.write_text(preflight + '\nprintf "%s\\n" "$HOURS" "${SCAN_ARGS[@]}"\n')
        assert int(window().stdout.splitlines()[0]) in (73, 74)
        accepted.write_text(json.dumps({'status':'accepted_with_gaps', 'accepted_through':cutoff.isoformat()}))
        selected = window()
        assert selected.returncode == 0 and int(selected.stdout.splitlines()[0]) in (3, 4)
        assert selected.stdout.splitlines()[-1] == cutoff.date().isoformat()
        assert marker.read_text().strip() == old.isoformat(), 'acceptance must not modify genuine success'
        newer = datetime.now(timezone.utc) - timedelta(minutes=30)
        marker.write_text(newer.isoformat() + '\n')
        assert int(window().stdout.splitlines()[0]) == 2, 'a newer genuine success takes precedence'
        for record in ({}, {'status':'completed', 'accepted_through':cutoff.isoformat()},
                       {'status':'accepted_with_gaps', 'accepted_through':'2026-02-30T12:00:00Z'},
                       {'status':'accepted_with_gaps', 'accepted_through':(datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}):
            accepted.write_text(json.dumps(record))
            assert window().returncode != 0, 'malformed/future acceptance cannot advance discovery'
        # Exercise the actual wrapper with isolated provider receipts, never live queues.
        script.write_text(source.read_text())
        # A stale shared success must not stand in for this process's receipt.
        (root / 'local/source-health.json').write_text(json.dumps({
            'linkedin': {'status': 'healthy', 'requests_failed': 0, 'coverage_complete': True}}))
        (root / 'local/apply-descriptions.mjs').write_text(
            'export function locationSlot() { return {present: false}; }\n')
        accepted.write_text(json.dumps({'status':'accepted_with_gaps', 'accepted_through':cutoff.isoformat()}))
        accepted_before = accepted.read_bytes()
        fake_bin = root / 'bin'
        fake_bin.mkdir()
        node = fake_bin / 'node'
        node.write_text(r'''#!/bin/bash
printf '%s\n' "$1" >> "$SCAN_FIXTURE_LOG"
case "$1" in
  scan.mjs)
    case "$SCAN_FIXTURE_CASE" in
      ats-invalid) printf 'not JSON\n'; exit 0;;
      ats-error|ats-soft-error)
        printf '%s\n' '{"version":"careerops.scan.receipt@1","dry_run":false,"found":1,"added":1,"errors":[{"company":"Fixture","error":"HTTP 200 returned HTML"}],"unverified_zero":[]}'
        [ "$SCAN_FIXTURE_CASE" = ats-error ] && exit 2
        exit 0;;
      ats-unverified) unverified='["Fixture"]';;
      *) unverified='[]';;
    esac
    printf '{"version":"careerops.scan.receipt@1","dry_run":false,"found":1,"added":1,"errors":[],"unverified_zero":%s}\n' "$unverified"
    exit 0;;
  local/ingest-jobspy.mjs)
    [ "$SCAN_FIXTURE_CASE" = ingest-error ] && exit 1
    exit 0;;
  local/apply-descriptions.mjs)
    [ "$SCAN_FIXTURE_CASE" = repair-apply-error ] && exit 1
    exit 0;;
  plugins.mjs)
    [ "$SCAN_FIXTURE_CASE" = gmail-missing ] && exit 0
    checked="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    [ "$SCAN_FIXTURE_CASE" = gmail-stale ] && checked='2001-01-01T00:00:00Z'
    coverage=true
    [ "$SCAN_FIXTURE_CASE" = gmail-partial ] && coverage=false
    printf 'Gmail receipt: {"version":"careerops.gmail.receipt@1","checked_at":"%s","found":1,"added":1,"coverage_complete":%s,"dry_run":false}\n' "$checked" "$coverage"
    [ "$SCAN_FIXTURE_CASE" = gmail-command-error ] && exit 2
    exit 0;;
esac
exec ''' + shutil.which('node') + ' "$@"\n')
        uv = fake_bin / 'uv'
        uv.write_text('''#!/usr/bin/env python3
import datetime, json, os, pathlib, sys
case = os.environ['SCAN_FIXTURE_CASE']
if 'hydrate-descriptions.py' in sys.argv:
    with open(os.environ['SCAN_FIXTURE_LOG'], 'a') as log: log.write('repair:' + sys.stdin.read().replace('\\n', ',') + '\\n')
    print('[]')
    sys.exit({'repair-fetch-error': 1, 'repair-rate-limited': 2}.get(case, 0))
health = {site: {'status': 'healthy', 'requests_failed': 0, 'queries_failed': 0, 'coverage_complete': True}
          for site in sys.argv[sys.argv.index('--sites') + 1].split(',')}
health['_checked_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
if case == 'stale-health': health['_checked_at'] = '2001-01-01T00:00:00Z'
if case in ('jobspy-partial', 'jobspy-blocked'):
    health['linkedin'].update(status='degraded', requests_failed=1, coverage_complete=False)
if case == 'jobspy-query-error':
    health['linkedin'].update(status='degraded', queries_failed=1, coverage_complete=False)
if case == 'jobspy-query-counter-only': health['linkedin']['queries_failed'] = 1
if case == 'healthy-unknown-http-counts': health['indeed']['requests_failed'] = None
if case == 'linkedin-not-selected':
    health['linkedin'] = {'status': 'healthy', 'requests_failed': 0, 'queries_failed': 0, 'coverage_complete': True}
if case == 'jobspy-budget': health['linkedin']['coverage_complete'] = False
if case == 'missing-site': health.pop('linkedin')
if case == 'legacy-health': health['linkedin'].pop('coverage_complete')
if case != 'missing-health':
    pathlib.Path(sys.argv[sys.argv.index('--health-file') + 1]).write_text(json.dumps(health))
print('[]')
sys.exit(1 if case == 'jobspy-blocked' else 0)
''')
        node.chmod(0o755)
        uv.chmod(0o755)
        env['PATH'] = str(fake_bin) + os.pathsep + env['PATH']
        env['JOBSPY_SITES'] = 'indeed,linkedin'
        env['SCAN_FIXTURE_LOG'] = str(root / 'events.log')
        for case in ('ats-error', 'ats-soft-error', 'ats-unverified', 'ats-invalid',
                     'jobspy-blocked', 'jobspy-partial', 'jobspy-query-error', 'jobspy-query-counter-only', 'jobspy-budget', 'missing-health',
                     'stale-health', 'missing-site', 'legacy-health', 'repair-fetch-error',
                     'repair-rate-limited', 'repair-apply-error', 'ingest-error'):
            env['SCAN_FIXTURE_CASE'] = case
            Path(env['SCAN_FIXTURE_LOG']).write_text('')
            (root / 'data/pipeline.md').write_text(
                '- [ ] local:jds/li.md | Fixture | Backend | note: src:linkedin lang:unknown url:https://www.linkedin.com/jobs/view/1\n'
                '- [ ] local:jds/other.md | Fixture | Backend | note: src:indeed lang:unknown url:https://example.test/jobs/1\n'
                if case.startswith('repair-') or case.startswith('jobspy-') else '')
            result = window()
            assert result.returncode != 0, (case, result.stdout, result.stderr)
            assert marker.read_text().strip() == newer.isoformat(), case
            assert accepted.read_bytes() == accepted_before, case
            events = Path(env['SCAN_FIXTURE_LOG']).read_text().splitlines()
            if case == 'jobspy-blocked':
                assert 'local/ingest-jobspy.mjs' not in events
                assert 'repair:https://example.test/jobs/1,' in events
            if case == 'jobspy-partial':
                assert 'local/ingest-jobspy.mjs' in events, 'save healthy partial results'
                assert 'repair:https://example.test/jobs/1,' in events, 'do not retry LinkedIn after a failed search'
            if case == 'jobspy-query-error':
                assert 'repair:https://example.test/jobs/1,' in events, 'query failure also defers LinkedIn repair'
            if case == 'jobspy-budget':
                assert any(event.startswith('repair:https://www.linkedin.com/') for event in events)
        env['SCAN_FIXTURE_CASE'] = 'healthy-empty'
        (root / 'data/pipeline.md').write_text('')
        assert window().returncode == 0
        assert datetime.fromisoformat(marker.read_text().strip().replace('Z','+00:00')) > newer
        assert accepted.read_bytes() == accepted_before
        env['SCAN_FIXTURE_CASE'] = 'healthy-unknown-http-counts'
        assert window().returncode == 0, 'query success accepts unobserved HTTP counts without inventing them'
        env['SCAN_FIXTURE_CASE'] = 'linkedin-not-selected'
        env['JOBSPY_SITES'] = 'indeed'
        (root / 'data/pipeline.md').write_text(
            '- [ ] local:jds/li.md | Fixture | Backend | note: src:linkedin lang:unknown url:https://www.linkedin.com/jobs/view/1\n')
        result = window()
        assert result.returncode == 0 and 'LinkedIn repair(s) deferred' in result.stderr
        # Gmail is opt-in after manual verification. Missing/stale/partial receipts
        # must block the full-success marker while other sources keep their work.
        (root / 'config').mkdir()
        (root / 'lib').mkdir()
        shutil.copyfile(Path(__file__).resolve().parent.parent / 'lib/yaml-document.mjs', root / 'lib/yaml-document.mjs')
        gmail_config = root / 'config/plugins.yml'
        gmail_config.write_text('plugins:\n  gmail:\n    enabled: true\n    linkedin_alerts: true\n    daily_verified: false\n')
        (root / 'data/pipeline.md').write_text('')
        env['SCAN_FIXTURE_CASE'] = 'healthy-empty'
        Path(env['SCAN_FIXTURE_LOG']).write_text('')
        assert window().returncode == 0
        assert 'plugins.mjs' not in Path(env['SCAN_FIXTURE_LOG']).read_text(), 'unverified Gmail must not run'
        gmail_config.write_text(gmail_config.read_text().replace('daily_verified: false', 'daily_verified: true'))
        for case in ('gmail-partial', 'gmail-command-error', 'gmail-missing', 'gmail-stale', 'gmail-complete'):
            env['SCAN_FIXTURE_CASE'] = case
            marker.write_text(newer.isoformat() + '\n')
            result = window()
            if case == 'gmail-complete':
                assert result.returncode == 0, (case, result.stderr)
                assert marker.read_text().strip() != newer.isoformat()
            else:
                assert result.returncode != 0, (case, result.stdout, result.stderr)
                assert marker.read_text().strip() == newer.isoformat(), case
    # One dead source must preserve the healthy rows and JSON health contract.
    with tempfile.TemporaryDirectory() as tmp:
        health = Path(tmp) / "source-health.json"
        health.write_text(json.dumps({"google": {"status": "degraded"}}))
        stdout = io.StringIO()
        with patch.object(fetch, "HEALTH_FILE", health), \
                patch.object(fetch, "searches", return_value=iter([("backend", "Madrid", 1)])), \
                patch.object(fetch, "scrape_jobs", side_effect=[RuntimeError("blocked"), pd.DataFrame([row])]), \
                patch.object(sys, "argv", ["jobspy_fetch.py", "--sites", "indeed,linkedin", "--hours", "48", "--limit", "1", "--no-linkedin-descriptions"]), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
            try:
                fetch.main()
            except SystemExit as exc:
                assert exc.code == 0
        assert len(json.loads(stdout.getvalue())) == 1
        status = json.loads(health.read_text())
        assert status["indeed"]["status"] == "degraded"
        assert status["linkedin"]["rows_last_run"] == 1
        assert status["google"]["status"] == "degraded"
        with patch.object(fetch, "HEALTH_FILE", health):
            fetch.write_health(["linkedin"], {"linkedin": 5}, {"linkedin": 1}, {"linkedin": 1})
        assert json.loads(health.read_text())["linkedin"]["status"] == "degraded"

    fetchers = hydrate.Fetchers()
    with patch.object(paced, "DETAILS", {"123": {"description": "Build APIs.", "location": "Madrid, Spain"}}), \
            patch("requests.sessions.Session.request", side_effect=AssertionError("no LinkedIn detail HTTP")) as get:
        got = hydrate.fetch_one(row["job_url"], fetchers)
        assert got["description"] == "Build APIs."
        assert got["location"] == "Madrid, Spain" and get.call_count == 0
        assert hydrate.fetch_one("https://www.linkedin.com/jobs/view/124", fetchers) == {}
        assert fetchers.jd_unavailable == 1
    session = Mock(headers={})
    session.post.return_value.status_code = 200
    session.post.return_value.json.return_value = [
        {"data": {"j456": {"job": {"description": "<p>Build services.</p>"}}}}]
    with patch.object(hydrate, "create_session", return_value=session) as create:
        got = hydrate.fetch_one("https://www.glassdoor.es/job-listing/j?jl=456", fetchers)
    assert got["description"] == "Build services."
    assert session.post.call_args.args[0] == "https://www.glassdoor.es/graph"
    payload = session.post.call_args.kwargs["json"][0]
    assert payload["operationName"] == "JobDetails" and "456" in payload["query"]
    assert create.call_args.args[2] == hydrate.headers
    with patch.object(paced, "DETAILS", {}), \
            contextlib.redirect_stderr(io.StringIO()):
        assert hydrate.fetch_one(row["job_url"], fetchers) == {}
    # Real 1.4 transport: one HTTP per page, no hidden retries/redirects, fair
    # query order, raw-card offsets despite parser losses, and a hard budget.
    for rate_limit in (False, True):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            root = Path(tmp)
            clock, requested = [0.0], []
            def page(method, url, **kw):
                assert method == "GET" and kw["allow_redirects"] is False
                assert kw["timeout"] == 15
                requested.append((kw["params"]["keywords"], kw["params"]["start"], clock[0]))
                body = "".join(card.replace("Posting:123", f"Posting:{i}") for i in range(10))
                if len(requested) == 1:
                    body = body.replace('<h3 class="base-search-card__title">Backend Engineer</h3>', '', 1)
                return Mock(status_code=429 if rate_limit else 200, text=body, headers={}, url=url)
            for target, value in [("NEXT_REQUEST", 0.0), ("REQUESTS", []), ("FAILED_REQUESTS", 0),
                                  ("REQUEST_ATTEMPTS", 0), ("REQUEST_LIMIT", None), ("RATE_LIMITED", False),
                                  ("COOLDOWN_FILE", root / "cooldown.txt"), ("SEARCH_SINCE", None),
                                  ("SINGLE_API_PAGE", False), ("PUBLIC_SEARCH", False), ("LAST_PAGE", {})]:
                stack.enter_context(patch.object(paced, target, value))
            stack.enter_context(patch.object(paced.time, "monotonic", side_effect=lambda: clock[0]))
            stack.enter_context(patch.object(paced.time, "sleep", side_effect=lambda s: clock.__setitem__(0, clock[0] + s)))
            stack.enter_context(patch("requests.sessions.Session.request", side_effect=page))
            stack.enter_context(patch.object(fetch, "HEALTH_FILE", root / "health.json"))
            stack.enter_context(patch.object(fetch, "searches", return_value=[("backend", "Madrid", 20), ("AI", "Spain", 20)]))
            stack.enter_context(patch.object(sys, "argv", ["jobspy_fetch.py", "--sites", "linkedin", "--hours", "48",
                                                          "--linkedin-request-budget", "3", "--health-file", str(root / "receipt.json")]))
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            try:
                fetch.main()
            except SystemExit as exc:
                assert exc.code == (1 if rate_limit else 0)
            health = json.loads((root / "receipt.json").read_text())
            assert health == json.loads((root / "health.json").read_text())
            li = health["linkedin"]
            assert li["coverage_complete"] is False and li["status"] == "degraded"
            assert li["requests_attempted"] == (1 if rate_limit else 3)
            assert li["requests_failed"] == (1 if rate_limit else 0)
            assert li["search_requests_attempted"] == (1 if rate_limit else 3)
            assert li["detail_requests_attempted"] == 0
            assert li["search_cards_received"] == (0 if rate_limit else 30)
            assert li["searches_skipped"] == (1 if rate_limit else 0)
            assert [(q, offset) for q, offset, _ in requested] == ([('backend', 0)] if rate_limit else
                                                                 [('backend', 0), ('AI', 0), ('backend', 10)])
            assert len(json.loads(output.getvalue())) == (0 if rate_limit else 29)
            assert all(b[2] - a[2] >= paced.DELAY for a, b in zip(requested, requested[1:]))
    # 1.4 reports actual source errors even alongside useful rows; a clean empty
    # result is a successful query, not an invented outage.
    for failed in (False, True):
        with tempfile.TemporaryDirectory() as tmp:
            frame = pd.DataFrame([row] if failed else [])
            frame.attrs = {"errors": {"indeed": "response status code 403"} if failed else {}}
            health_path = Path(tmp) / "health.json"
            with patch.object(fetch, "HEALTH_FILE", health_path), \
                    patch.object(fetch, "searches", return_value=[("backend", "Madrid", 1)]), \
                    patch.object(fetch, "scrape_jobs", return_value=frame), \
                    patch.object(sys, "argv", ["jobspy_fetch.py", "--sites", "indeed"]), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    fetch.main()
                except SystemExit as exc:
                    assert exc.code == 0
            health = json.loads(health_path.read_text())["indeed"]
            assert health["coverage_complete"] is (not failed)
            assert health["queries_failed"] == int(failed)
            assert health["requests_failed"] is None, 'query/parser errors are not measured HTTP requests'
    # Invalid budgets/selections never begin HTTP or touch persistent health.
    for flags in (["--linkedin-request-budget", "0"], ["--limit", "0"],
                  ["--sites", ""], ["--sites", "invalid-board"]):
        with patch.object(sys, "argv", ["jobspy_fetch.py", *flags]), \
                patch.object(fetch, "scrape_jobs") as scrape, \
                patch.object(fetch, "write_health") as health, \
                contextlib.redirect_stderr(io.StringIO()):
            try:
                fetch.main()
                assert False, "invalid inputs must fail before scraping"
            except SystemExit as exc:
                assert exc.code == 2
            scrape.assert_not_called()
            health.assert_not_called()
    # Bounded recovery saves the raw-card offset, resumes the next page, and
    # never turns a parser loss into an early end or a duplicate HTTP page.
    with tempfile.TemporaryDirectory() as tmp:
        start = datetime.now(timezone.utc) - timedelta(hours=48)
        args = SimpleNamespace(since=start.isoformat(), state=Path(tmp) / "recover.json",
                               public_search=False, request_budget=1)
        recover.save(args.state, {"since": args.since, "rows": {}, "queries": [
            {"role": "backend", "location": "Madrid", "wanted": 20, "offset": 0, "status": "pending"}]})
        offsets = []
        def limited_page(*a, **kw):
            offsets.append(kw["offset"])
            paced.REQUEST_ATTEMPTS += 1
            paced.LAST_PAGE.update(cards=10)
            return [{"job_url": f"https://example.test/{kw['offset'] + n}"} for n in range(9)]
        with patch.object(paced, "REQUEST_ATTEMPTS", 0), patch.object(paced, "REQUEST_LIMIT", None), \
                patch.object(paced, "NEXT_REQUEST", 0.0), patch.object(paced, "FAILED_REQUESTS", 0), \
                patch.object(paced, "LAST_PAGE", {}), patch.object(fetch, "scrape_one", side_effect=limited_page), \
                patch.object(recover.subprocess, "run"), \
                patch.object(recover.subprocess, "check_output", return_value=""), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            try:
                recover.run(args, start)
                assert False, "one-request budget must pause unfinished recovery"
            except SystemExit:
                pass
            saved = json.loads(args.state.read_text())
            assert saved["queries"][0]["offset"] == 10 and saved["queries"][0]["status"] == "budget_paused"
            recover.run(args, start)
            assert offsets == [0, 10]
            assert json.loads(args.state.read_text())["queries"][0]["status"] == "quota_reached"
        # A repeated page is an unresolved coverage gap, not another quota's
        # worth of results; resume must not keep requesting that same page.
        args.request_budget = 4
        recover.save(args.state, {"since": args.since, "rows": {}, "queries": [
            {"role": "backend", "location": "Madrid", "wanted": 40, "offset": 0, "status": "pending"}]})
        offsets.clear()
        def repeated_page(*a, **kw):
            offsets.append(kw["offset"])
            paced.REQUEST_ATTEMPTS += 1
            paced.LAST_PAGE.update(cards=10)
            return [{"job_url": f"https://example.test/{n}"} for n in range(10)]
        with patch.object(paced, "REQUEST_ATTEMPTS", 0), patch.object(paced, "REQUEST_LIMIT", None), \
                patch.object(paced, "NEXT_REQUEST", 0.0), patch.object(paced, "FAILED_REQUESTS", 0), \
                patch.object(paced, "LAST_PAGE", {}), patch.object(fetch, "scrape_one", side_effect=repeated_page), \
                patch.object(recover.subprocess, "run"), patch.object(recover.subprocess, "check_output", return_value=""), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            for _ in range(2):
                try:
                    recover.run(args, start)
                    assert False, "repeated page must retain an unresolved coverage gap"
                except SystemExit:
                    pass
            assert offsets == [0, 10]
            saved = json.loads(args.state.read_text())
            assert saved["queries"][0]["status"] == "repeated_page" and saved["coverage"] == "partial"
    # A cached LinkedIn JD survives beside an unavailable one, without guest HTTP.
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(paced, "DETAILS", {"1": {"description": "Build APIs."}}))
        stack.enter_context(patch.object(paced, "load_saved_details"))
        stack.enter_context(patch.object(paced, "RATE_LIMITED", False))
        requests = stack.enter_context(patch("requests.sessions.Session.request", side_effect=AssertionError("no guest JD HTTP")))
        stack.enter_context(patch.object(sys, "argv", ["hydrate", "--delay", "0"]))
        stack.enter_context(patch.object(sys, "stdin", io.StringIO(
            "https://www.linkedin.com/jobs/view/1\nhttps://www.linkedin.com/jobs/view/2\n")))
        output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        try:
            hydrate.main()
            assert False, "missing LinkedIn text must leave repair incomplete"
        except SystemExit as exc:
            assert exc.code == 2
        assert requests.call_count == 0
        assert json.loads(output.getvalue()) == [{"job_url": "https://www.linkedin.com/jobs/view/1", "description": "Build APIs."}]
    print("JobSpy 1.4.1 compatibility: PASS (offline parsers, pacing, fair pages, hard budgets, source receipts, resume and accepted cutoff)")


def check_routine_resume():
    with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
        root = Path(tmp)
        cooldown = root / "retry-at.txt"
        deadline = (datetime.now(timezone.utc) + timedelta(minutes=20)).isoformat()
        cooldown.write_text(deadline)
        for name, value in [("COOLDOWN_FILE", cooldown), ("REQUEST_ATTEMPTS", 0),
                            ("RATE_LIMITED", False), ("REQUEST_LIMIT", 1)]:
            stack.enter_context(patch.object(paced, name, value))
        get, sleep = Mock(), stack.enter_context(patch.object(paced.time, "sleep"))
        try:
            paced.paced_get(get, "https://example.test/search")
            assert False, "a saved retry deadline must defer without sleeping or HTTP"
        except paced.RequestException as exc:
            assert "no waiting" in str(exc)
        get.assert_not_called()
        sleep.assert_not_called()
        assert paced.REQUEST_ATTEMPTS == 0 and cooldown.read_text() == deadline

    with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
        root = Path(tmp)
        args = SimpleNamespace(linkedin_state=root / "state.json", li_desc=False, hours=48, quiet=True)
        since = datetime.now(timezone.utc) - timedelta(hours=48)
        def queries():
            return [{"role": role, "location": "Madrid", "wanted": wanted, "offset": 0}
                    for role, wanted in [("backend", 20), ("AI", 10)]]
        pages = []
        def page(site, role, location, wanted, hours, verbose, descriptions, offset):
            assert not descriptions
            pages.append((role, offset))
            paced.REQUEST_ATTEMPTS += 1
            paced.LAST_PAGE.update(cards=10)
            return [{"job_url": f"https://example.test/{role}/{offset + n}"} for n in range(9)]
        for target, name, value in [
            (paced, "REQUEST_ATTEMPTS", 0), (paced, "REQUEST_LIMIT", 1),
            (paced, "RATE_LIMITED", False), (paced, "SEARCH_SINCE", since),
            (paced, "LAST_PAGE", {}), (fetch, "QUERY_ERRORS", {}),
        ]:
            stack.enter_context(patch.object(target, name, value))
        stack.enter_context(patch.object(fetch, "scrape_one", side_effect=page))
        ingest = stack.enter_context(patch.object(fetch.subprocess, "run"))
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        described = [{"job_url": "https://example.test/indeed/1", "description": "Build APIs"}]
        rows, _, _, complete = fetch.collect_linkedin(args, queries(), described)
        assert json.loads(Path(ingest.call_args_list[0].args[0][-1]).read_text()) == described
        assert len(rows) == 9 and not complete
        saved = json.loads(args.linkedin_state.read_text())
        assert [(q['role'], q['offset']) for q in saved['pending']] == [('AI', 0), ('backend', 10)]
        paced.REQUEST_LIMIT += 1
        paced.SEARCH_SINCE = datetime.now(timezone.utc) - timedelta(hours=24)
        rows, _, _, complete = fetch.collect_linkedin(args, queries())
        assert len(rows) == 18 and not complete and paced.SEARCH_SINCE == since
        assert pages == [('backend', 0), ('AI', 0)]
        paced.REQUEST_LIMIT += 1
        def interrupted_ingest(*a, **kw):
            assert a[0][:2] == ['node', 'local/ingest-jobspy.mjs']
            if len(json.loads(Path(a[0][-1]).read_text())) == 27:
                raise subprocess.CalledProcessError(1, a[0])
        ingest.side_effect = interrupted_ingest
        try:
            fetch.collect_linkedin(args, queries())
            assert False, "a failed ingest must leave the saved page available for rescue"
        except subprocess.CalledProcessError:
            pass
        saved = json.loads(args.linkedin_state.read_text())
        assert len(saved['rows']) == 27 and not saved.get('finished')
        ingest.side_effect = None
        rows, _, _, complete = fetch.collect_linkedin(args, queries())
        assert complete and len(rows) == 27
        assert pages == [('backend', 0), ('AI', 0), ('backend', 10)]
        assert json.loads(args.linkedin_state.read_text())['finished']
        assert not (root / 'retry-at.txt').exists()
        with args.linkedin_state.with_suffix('.lock').open('a') as held:
            fetch.fcntl.flock(held, fetch.fcntl.LOCK_EX | fetch.fcntl.LOCK_NB)
            try:
                fetch.collect_linkedin(args, queries())
                assert False, 'another collector must not acquire this checkpoint'
            except SystemExit as exc:
                assert 'already in use' in str(exc)
            assert pages == [('backend', 0), ('AI', 0), ('backend', 10)]
    with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
        spec = importlib.util.spec_from_file_location('recover_check', Path(__file__).with_name('recover-linkedin.py'))
        recover = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recover)
        since = datetime.now(timezone.utc) - timedelta(hours=48)
        args = SimpleNamespace(since=since.isoformat(), state=Path(tmp) / 'recover.json', public_search=False)
        recover.save(args.state, {'since': args.since, 'queries': [], 'rows': {}})
        urls = 'https://www.linkedin.com/jobs/view/123\n'
        stack.enter_context(patch.object(recover.subprocess, 'run', return_value=SimpleNamespace(returncode=2)))
        stack.enter_context(patch.object(recover.subprocess, 'check_output', return_value=urls))
        stack.enter_context(patch.object(paced, 'saved_wait', return_value=45))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        recover.run(args, since)
        saved = json.loads(args.state.read_text())
        wait = (datetime.fromisoformat(saved['retry_at']) - datetime.now(timezone.utc)).total_seconds()
        assert 0 < wait <= 45, 'repair deferral must not invent a 30-minute cooldown'
    print("LinkedIn routine checkpoints: PASS (no cooldown sleep, fair resume, original window, interrupted ingest rescue)")


if __name__ == "__main__":
    # Offline checks use a simulated clock when pacing matters; never wait on
    # a fixture's persisted cooldown in the remaining recovery scenarios.
    # Validate the real private-config boundary before mocking it for transport tests.
    with tempfile.TemporaryDirectory() as tmp:
        config_path = Path(tmp) / "search.json"
        try:
            fetch.load_search_config(config_path)
            assert False, "missing configuration must fail closed"
        except ValueError:
            pass
        config_path.write_text(json.dumps(FIXTURE_SEARCH))
        assert fetch.load_search_config(config_path) == FIXTURE_SEARCH
        config_path.write_text(json.dumps({**FIXTURE_SEARCH, "roles": ["YOUR_ROLE"]}))
        try:
            fetch.load_search_config(config_path)
            assert False, "placeholder targeting must fail closed"
        except ValueError:
            pass
    with patch.object(paced.time, "sleep", return_value=None), \
            patch.object(fetch, "load_search_config", return_value=FIXTURE_SEARCH), \
            patch.object(hydrate, "load_search_config", return_value={**FIXTURE_SEARCH, "country_indeed": "spain"}):
        check()
        check_routine_resume()
