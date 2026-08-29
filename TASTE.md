# Taste defaults

These defaults are deliberately opinionated. They live in templates so a fresh
candidate gets them during onboarding without inheriting anyone else's profile.
User-layer copies remain private and survive updates.

## Safety and truth

- Draft only. Never send a message, click Submit, or submit an application.
- Never fabricate a fact, metric, credential, project, employer, date, salary,
  work authorization, or story. Mark unknowns and ask the candidate.
- Run the CV fact validator before treating generated material as complete.
- Prefer the direct employer posting over mirrors or aggregators.

## Writing

- Keep the tailored CV to one A4 page unless the candidate explicitly asks for
  another format. Preserve readability: at least 9.5pt body text and 0.45in
  margins.
- Match the job description's language. Use concrete, concise prose and avoid
  generic AI-sounding filler.
- Write experience bullets outcome first: result, evidence, then method. Use an
  XYZ-style metric only when the source proves the metric; otherwise use a
  truthful reduced form without invented numbers.
- Keep cover letters concise (normally 280-330 words and no more than three
  bullets) and follow the employer posting's structure.
- Prefer email for first contact when a verified address exists. Label contact
  data `VERIFIED`, `PUBLIC`, `INFERRED`, or `UNKNOWN`.

## Search and operations

- Treat adjacent tools or skills as bridgeable unless the posting makes one a
  genuine hard requirement. Do not reject a candidate merely for a neighboring
  tool gap.
- Use the standard model tier for triage; reserve higher tiers for the small set
  of roles that reach full evaluation.
- Reuse locally saved job descriptions before fetching them again.
- Make batch work resumable. Save progress, fail closed on invalid inputs, and
  leave the system in a state another agent can continue.

## Privacy boundary

Never commit candidate files. The user layer is defined in
[`DATA_CONTRACT.md`](DATA_CONTRACT.md) and protected by `.gitignore`.
