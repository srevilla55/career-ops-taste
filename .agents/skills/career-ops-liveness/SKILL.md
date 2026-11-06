---
name: career-ops-liveness
description: >-
  Recheck job-posting and application-route liveness for existing numbered
  career-ops output packages, find exact reposts, and update saved routes in
  place. Use for package URL audits or refreshing dead package links. Does not
  cover general job discovery, evaluation, new package generation, or submission.
---

# Existing package liveness

Run from the personal `career-ops/` checkout root. This skill uses existing
repository scripts and public employer/ATS evidence; it needs no claude-mem
worker. Never submit an application, upload candidate documents, send outreach,
or launch another pipeline stage.
First follow [root resolution and shared preflight](../career-ops/SKILL.md#project-root-resolution), including the data-root check before mixing native scripts with local orchestration. This selects no broader mode.

## Inspect and inventory

Read `AGENTS.md`, `modes/_custom.md`, `config/profile.yml`, `DATA_CONTRACT.md`,
and the current liveness scripts. Inspect git status, tracker/pipeline and batch
state, active workers, locks, claims, and `batch/.eval-wave` before updates.
Preserve unrelated changes and coordinate any shared-file writes. Do not send
candidate data, cached JDs, or reports to an external model without explicit
authorization for this run, these data, and that model.

Enumerate every numbered directory in `output/`, including incomplete and
legacy packages without `manifest.json`. If the user limits the audit, inventory
only that scope. Map each directory to its report and existing tracker row;
package/report numbers and tracker row numbers can differ.

Collect saved posting and application URLs from each manifest, `jd/current.md`,
application/ATS prep, role-verification notes, and the linked report. Inspect
existing fields such as `application_url`, `job_url`, `official_job_url`,
`original_job_url`, and previous/mirror URLs rather than assuming one schema.
Resolve `local:jds/...` through its cached JD and `data/jd-index.tsv` to the
original public URL with `originalUrlFrom()` from `jd-capture.mjs` (`Original URL`,
`URL`, or `original_url`). Missing manifests or URLs are audit findings, not expiry
evidence. Retain a URL-to-package mapping so deduplication never drops packages
sharing a requisition.

## Check and resolve

Create a temporary directory with `mktemp -d /tmp/career-ops-liveness.XXXXXX`.
Use its path as `audit_dir`; write deduplicated saved posting/application URLs,
one per line, to `urls.txt`. Run separately so a nonzero checker exit does not
skip repost detection:

```bash
node check-liveness.mjs --throttle=5000 --no-fallback --file "$audit_dir/urls.txt" > "$audit_dir/check.txt"
node detect-reposts.mjs > "$audit_dir/reposts.json"
```

The checker tries ATS APIs first, then sequential Playwright checks. Exit 1
includes expired or uncertain results; inspect the output and final summary.
A browser/startup failure or partial run is incomplete, not posting closure.
Keep browser work sequential; use the supported headed fallback when available
if a challenge needs it.

Repost clusters are leads, not identity or liveness proof. The detector considers
`added` scan-history rows with a default 90-day clustering window. An empty result
does not rule out a repost missing from scan history.

Resolve failed, expired, and uncertain results against current employer careers
pages and ATS data. Search engines and aggregators may locate candidates; cached
snippets cannot establish current liveness. Use Playwright to inspect the exact
posting and its Apply route when APIs do not resolve them. Do not infer closure
from a login wall, TLS/network error, bot challenge, or missing Apply control.
Keep those uncertain unless positive employer/ATS closure evidence resolves them.

Accept a replacement only after comparing the saved JD with the live posting:
employer, requisition/redirect identity, team, duties, seniority, location, and
material requirements must establish the exact or materially equivalent role.
Similar titles or another vacancy at the same company are insufficient. Record
changed requirements that could invalidate existing drafts; do not silently
reuse materials for a different role or run a new evaluation.

Confirm posting liveness and application-route availability separately, without
submitting or filling forms. Record live, verified replacement, closed with no
live exact repost found, or unresolved results. A readable replacement with an
unconfirmed Apply route remains blocked for application.

## Update in place and verify

Update current routes and dated liveness evidence in existing manifests, JD
notes, validation notes, and ATS prep where relevant. Preserve evaluated/original
URLs and previous evidence; append dated corrections instead of rewriting
history. Only clear a current application route when closure is confirmed, and
retain the old URL as historical evidence. For unresolved routes, keep the saved
URL with an explicit uncertainty/blocker. Use existing package fields and
hierarchy; do not create a manifest solely to audit a legacy package, rename
files, regenerate PDFs, or mark other package gates passed.

Append tracker notes through `set-status.mjs`, using the linked report number
and the row's current canonical state from `templates/states.yml`:

```bash
node set-status.mjs --report NNN "$current_state" --note "$dated_evidence" --dry-run --json
```

Check the preview's company and role, then repeat without `--dry-run`. Preserve
the current state unless the user requested a status change. Do not hand-edit
`data/applications.md`, bypass an identity mismatch with `--force`, or use
`Expired` as a tracker state. If no row exists, report it rather than creating a
duplicate or claiming the tracker was updated.

Write `output/liveness-audit-YYYY-MM-DD.md` with one result per inventoried
package, including manifest-less packages and duplicate requisitions. Include
package/report links, historical and current URLs, posting and Apply status,
dated source evidence, replacement identity checks, edits, and unresolved
blockers. Preserve an existing same-day audit when adding a later check. Derive
totals from the inventory and reconcile every row to it.

Run `node verify-pipeline.mjs`, then
`node local/orchestration/next-step.mjs --brain codex --json`. Inspect changed
JSON and Markdown links, and run `git diff --check`. Distinguish existing
warnings from new errors; the controller's next action does not authorize it.
Report audit coverage, live/replaced/closed/unresolved results, and the audit
path. State that nothing was submitted or sent; incomplete checks stay explicit.
