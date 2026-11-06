---
name: career-ops-output-packages
description: Prepare or finish local application draft bundles for career-ops reports that already meet the packaging score gate. Use for output-packages-only requests and resumes; excludes discovery, hydration, triage, evaluation, standalone liveness audits, and sending.
---

# Output packages only

Resolve this skill's canonical path, then walk upward to the checkout containing
`AGENTS.md` and `modes/`. Run commands there. Resolve candidate data and the tracker
through `path-resolver.mjs`; controllers assume checkout-local shared state, so
stop that combination if an override selects a different queue or tracker.

## Select existing work

- Read `AGENTS.md`, `DATA_CONTRACT.md`, `config/profile.yml`, `modes/_custom.md`,
  and the relevant PDF, cover, email/application and writing instructions.
  Inspect dirty work, workers, locks, claims and `batch/.eval-wave` first.
- Read the current `pipeline.packet_min_score` and `packet_max`; zero means all
  qualifying reports. This gate uses the full evaluation score, not triage or
  `auto_pdf_score_threshold`. Preserve each report's independent verdict and gaps.
- Join `batch/batch-state.tsv`, reports, tracker and output manifests. Exclude
  reservations, below-gate reports, already closed/discarded roles and completed
  materials. Resume valid partial artifacts. Do not rerun their evaluation.
- Read `next-step.mjs --brain codex --json` for guidance, then verify actual
  coverage. Its outreach-filename heuristic can count a different legacy role
  at the same company or miss a report covered by an existing bundle. Match the
  report, role and manifest, including `covered_reports`, before drafting.
- Reuse documented identical requisitions once. For possible reposts, distinguish
  document reuse from proven requisition identity. Use `jd-similarity.mjs` and
  record the reuse decision; similar text does not prove an identical vacancy.
- Use the cached JD from `data/jd-index.tsv`, the `local:` path or the report's
  verbatim archive. No hydration or replacement-role search in this workflow.

## Prepare the bundle

Candidate claims come only from the primary sources allowed by `AGENTS.md` and
the current conversation. Reports, old packages and memory can guide emphasis;
they do not establish candidate facts. Load `cv.md`, `article-digest.md`,
`modes/_profile.md`, `config/profile.yml` and the writing/style rules as needed.

Use the current user instruction for languages. When Spanish/English only is
requested, use Spanish for Spanish responsibilities and English for every other
JD, including German and Italian. A translation never establishes proficiency.
Keep internal notes in English; do not change profile language for one artifact.

Initialize through:

```bash
npm run application:init -- --report NNN --company "Company" --role "Role" --version 1
```

Use the printed paths and existing report-prefixed leaves. Keep prior versions
when refreshing a bundle; record new report coverage without assigning numbers
or making a second tracker row. Build these local artifacts:

- cached JD and auditable reuse/change decision;
- tailored CV payload, HTML and PDF;
- cover-letter payload, Markdown, HTML and PDF;
- company context with dated sources and contact discovery with confidence;
- application-field/free-text drafts and explicit unanswered items;
- validation records, package manifest and recruiter email draft.

Use the existing CV/cover builders and `generate-pdf.mjs`. Follow the current
one-page A4, template, font/margin, credential and cover-word-count rules. Tailor
content to this JD rather than copying another role's pitch. Do not manufacture
stack experience, metrics, seniority, language ability or completed education.
Email is preferred; label `VERIFIED`, `PUBLIC`, `INFERRED` or `UNKNOWN` accurately.
Support, privacy, accessibility and admissions inboxes are not recruiting contacts.
An unknown recipient leaves a usable unaddressed draft. Do not save shared contacts
or answer unknown declarations, demographics or relocation terms without authority.

Respect stage exclusions. When liveness is explicitly excluded, retain dated
existing evidence and prepare local drafts with `send_ready: false`; do not call
them currently live/application-ready, lift holds or run a liveness audit.
Otherwise follow the checkout's exact-employer verification gate. Never submit,
upload, send or click a final action as part of packaging.

Read the current model policy. Any new external-model worker requires explicit
run/data/model authorization; a skill or score gate does not grant it. Preserve
written work when egress, access or usage limits stop a worker.

## Validate and record completion

Run `verify-cv-facts.mjs` on the CV, cover, outreach and candidate form text.
Review warnings and gaps; fix truthful formatting problems without weakening
the gate or adding guessed facts. Run structural/keyword diagnostics as useful.

```bash
node generate-pdf.mjs INPUT.html OUTPUT.pdf --format=a4 --max-pages=1 --strict-pages --report=NNN
```

Exit zero is required; an overflow PDF on disk is incomplete. For cover output
use `--kind=cover`. For multiple documents the existing `--batch` manifest accepts
`input`, `output`, `format`, `reportNum` and `kind`; keep shared writes sequential.

Check page count/A4 size, qpdf, extracted text, embedded fonts and visual layout.
Verify every manifest path and source-grounded claim. Write the final outreach
leaf last, since the controller treats it as the completion marker. Distinguish
complete local materials from unresolved posting, eligibility and sending gates.

Use `mark-pdf-ready.mjs NNN --json` for PDF readiness and
`set-status.mjs --report NNN Evaluated --note "..."` for existing-row notes.
Bare numeric `set-status` selects a tracker row ID, which can differ from NNN.
Preserve status and score; never hand-edit the tracker or shared batch queue.

Finish with `merge-tracker.mjs`, `reconcile-pipeline.mjs`, `verify-pipeline.mjs`
and the controller check. Inspect reservation ownership before verification,
which can remove stale sentinels. Confirm protected stage/source files were
preserved. Report exact package counts, paths, languages, checks and remaining
holds or reused coverage; controller advice never authorizes another stage.
