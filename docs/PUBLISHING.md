# Publishing the Taste starter

Keep source publication separate from a candidate's working checkout.
The starter's Git history must never contain their profile, CV, job-search
history, emails, reports, credentials, or application documents.

## Update source

1. Start from this repository's clean history and inspect the checkout status.
2. Import an explicit upstream release's system files and review local source
   improvements. Preserve the MIT license and upstream attribution.
3. Keep neutral onboarding templates. Search roles, locations, country and
   priority rules belong in ignored `local/search.json`, not source constants.
4. Exclude the complete user layer in `DATA_CONTRACT.md`, runtime/cache files,
   canary artifacts and local credentials. Do not copy a working `.git` folder,
   merge personal history, or rely on a broad `git add` in the personal checkout.
5. Review both staged content and every reachable commit. Check for names,
   contact details, local machine paths, candidate facts and real credentials.
   Removing a file in a later commit does not remove its history.
6. Run the relevant core, web and local integration checks and
   `npm run privacy:check`. Commit only the reviewed source tree, then push to
   this fork's remote. Never force-push as a substitute for history review.

`scripts/check-publication.mjs --history` rejects private paths in the index
and reachable commits using the updater's user-layer boundary plus local
integration state. Only exact system-owned scaffolds are exempt. A file named
`README.md` under an arbitrary private directory is still private.
This path check does not replace content/secret review.

## Baseline and retained improvements

This update uses [Career-Ops 1.39.0 / web 0.17.0 at
d3fc7d1b2766ca0cc46ca87f2ac92561f00c550d](https://github.com/career-ops-hq/career-ops/tree/d3fc7d1b2766ca0cc46ca87f2ac92561f00c550d)
and [JobSpy 1.4.1](https://github.com/speedyapply/JobSpy/releases/tag/v1.4.1).

Retained improvements include strict ATS host parsing, Workday result-cap and
pagination coverage reporting, paced cards-only LinkedIn discovery, resumable
checkpoints, conservative JD repair, authenticated Gmail-alert ingestion,
backend-owned dashboard report/PDF persistence, and one-page A4 safeguards.
Candidate-specific searches and historical one-off diagnostics are excluded.

## Automation

Read-only tests, dependency/security checks and the publication privacy guard
run in the fork. Upstream release publishing, community bots and other
non-validation workflows are restricted by job conditions to the upstream
repository. A source push does not publish an npm package or submit anything
on a candidate's behalf.

AI-assisted user workflows still require a locally authenticated CLI and
the candidate's authorization. Gmail requires their own OAuth client and
browser consent; `.env` is never included in a publication.

The tracked `config/local-paths.txt` declares shared fork-owned source using the
updater's supported mechanism. It contains relative source paths only, never
candidate files or machine-specific paths. Keep those declarations intact.
