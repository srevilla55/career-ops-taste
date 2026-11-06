# Add LinkedIn jobs

Paste a LinkedIn job alert without connecting Gmail, or connect the read-only Gmail reader below. Both paths save canonical job links for review; an alert does not establish a readable JD, a live employer posting, or eligibility.

## Paste on the dashboard

1. Open CareerOps in the browser.
2. Open a LinkedIn job alert email.
3. Select all, then copy.
4. On the home page or the pipeline, paste into **LinkedIn job alerts**.
5. Click **Add these jobs**.

You should see a line such as `12 LinkedIn jobs added. Open Pipeline to review them.` Each row uses the job title from the line above the link. When the paste has no title, the row uses the words in the job link. Open Pipeline to read the posting.

A job that is already in the pipeline, tracker, or scan history is not added again.

To use a saved email instead of a paste, choose the file next to the paste box. `.eml` and `.txt` both work.

## Paste from the terminal

Save the alert as a file, then run:

```bash
node linkedin-import.mjs --file alert.eml
```

Or pipe it:

```bash
node linkedin-import.mjs < alert.eml
```

`--dry-run` prints the count and writes nothing. `--json` prints one object with `added`, `already`, `found`, and `message`.

With no file and no pipe, the command prints this help and waits for nothing.

## What gets saved

Each job is saved as `https://www.linkedin.com/jobs/view/{id}`. A tracking link from the email, including `/comm/jobs/view/`, becomes that address.

CareerOps does not log in to LinkedIn, does not search LinkedIn, and does not message anyone.

## Read LinkedIn alerts from Gmail

This uses the bundled Gmail reader, not a second scraper. It reads matching messages from your configured label, checks Gmail's sender-authentication verdict, and extracts LinkedIn job links. It never sends, modifies, deletes, or marks mail read. No email content is sent to an external model.

Google's `gmail.readonly` permission permits reading the mailbox; Google does not restrict it to one label. The reader restricts its queries to **LinkedIn Jobs** and the exact LinkedIn alert senders. See [Google's scope documentation](https://developers.google.com/workspace/gmail/api/auth/scopes).

### Create the OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **Gmail API**.
2. Configure Google Auth Platform's branding and **External** audience. While the app is in Testing, add your own Gmail address as a test user.
3. Create an OAuth client with application type **Desktop app**, then download its JSON. Keep that file locally; do not paste its contents into chat or commit it.
4. From the career-ops checkout, run:

```bash
node local/gmail-oauth.mjs --client /absolute/path/client_secret.json
```

Open the printed Google URL in your normal browser and approve read-only Gmail access. The command uses Google's installed-app flow with a loopback callback and PKCE. It stores `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN` in the data root's ignored `.env` with owner-only permissions, preserving unrelated entries. It prints no credentials and reads no mail during setup. See [Google's desktop authorization flow](https://developers.google.com/identity/protocols/oauth2/native-app).

### Label and preview

In Gmail, create a filter matching `from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com)` and apply the label **LinkedIn Jobs**. You can apply it to existing matching alerts too.

Add these flat settings to the existing `plugins.gmail` block in `config/plugins.yml`, preserving other plugin settings. Do not nest them under `settings:`.

```yaml
plugins:
  gmail:
    enabled: true
    label: LinkedIn Jobs
    days_back: 7
    linkedin_alerts: true
    daily_verified: false
```

Preview:

```bash
node plugins.mjs run gmail --dry-run
```

Review the count, sample URLs, and final `Gmail receipt`. Preview leaves the pipeline, scan history, and processed-message cursor unchanged. Pagination and failed message reads are reported as incomplete; failed messages remain eligible for retry.

After reviewing the preview, import once:

```bash
node plugins.mjs run gmail
```

The reader uses the canonical pipeline/history writers and deduplicates across pipeline, tracker, and history. Per-job plaintext cards retain their own explicit metadata. Ambiguous or HTML-only metadata stays unknown instead of copying one subject onto every job. Authenticated links with unavailable title or location remain explicitly unresolved Pending leads; known fields still obey the configured filters. Row notes keep JD availability and employer/liveness unconfirmed. Resolve the exact JD and employer posting before evaluation.

Only after checking that manual import, set `daily_verified: true` to include this reader when the existing daily runner is invoked. This does not create a background schedule. A seven-day overlap is intentional: URL dedup prevents duplicates, and messages are acknowledged only after successful canonical writes.

### Reconnect or disable

An External OAuth app left in **Testing** receives refresh tokens that expire after seven days for Gmail scopes. Configure publishing status appropriately for durable personal use under Google's rules, or repeat the local authorization command when it expires. Revocation produces a reconnect error too. See [Google's refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

Set `daily_verified: false` to stop daily ingestion, or `enabled: false` to disable the reader entirely. You can revoke the application's access in your Google Account connections. Manual paste/import remains available without Gmail access.
