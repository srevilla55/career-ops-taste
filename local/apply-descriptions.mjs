#!/usr/bin/env node
/**
 * apply-descriptions.mjs — write hydrated JD text and locations back into
 * captured postings.
 *
 * Companion to hydrate-descriptions.py. That script fetches; this one applies,
 * so the language decision stays in one place: jdLanguage() from the ingest,
 * never a second detector that could drift from house rule 2 (the CV language
 * follows the JD). Same reason priorityScore() is imported rather than
 * reimplemented — a backfilled location has to score on exactly the scale the
 * ingest used, or the queue sorts on two different rulers.
 *
 * For each {job_url, description?, location?} it:
 *   1. finds the data/pipeline.md row whose note ends in `url:{job_url}`
 *   2. rewrites that JD file's Description body, Detected-JD-language line
 *      and/or Location line
 *   3. flips `lang:unknown` to the detected language in the pipeline row, sets
 *      the row's location column, and recomputes `prio` from the new location
 *
 * Idempotent: re-running with the same input changes nothing.
 *
 *   uv run local/hydrate-descriptions.py < urls.txt > desc.json
 *   node local/apply-descriptions.mjs --file desc.json [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { sanitizeMarkdownField } from '../scan.mjs';
import { jdLanguage, priorityScore, loadPriorityConfig } from './ingest-jobspy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');

const LANG_LINE = /^- \*\*Detected JD language:\*\*.*$/m;
const LOCATION_LINE = /^- \*\*Location:\*\*.*$/m;
const DESCRIPTION_SPLIT = /^## Description$/m;

/** Map `url:<real url>` -> the `local:` JD path, from the pipeline rows. */
export function indexPipeline(text) {
  const byUrl = new Map();
  for (const line of text.split('\n')) {
    const local = line.match(/(local:\S+\.md)/);
    const url = line.match(/\burl:(\S+)\s*$/);
    if (local && url) byUrl.set(url[1], { line, jdPath: local[1].slice('local:'.length) });
  }
  return byUrl;
}

/** Replace the language line and everything under `## Description`. */
export function rewriteJd(existing, description, lang) {
  const idx = existing.search(DESCRIPTION_SPLIT);
  if (idx === -1) return null;
  const head = existing.slice(0, idx).replace(
    LANG_LINE, `- **Detected JD language:** ${lang}`);
  return `${head}## Description\n\n${description.trim()}\n`;
}

/** Set the JD file's Location line. Returns the text unchanged if there isn't one. */
export function rewriteJdLocation(existing, location) {
  return existing.replace(
    LOCATION_LINE, `- **Location:** ${sanitizeMarkdownField(location)}`);
}

/** Swap the `lang:` token in one pipeline row. */
export function rewriteRow(line, lang) {
  return line.replace(/\blang:[a-z]+\b/, `lang:${lang}`);
}

// The labeled trailing segments formatPipelineOffer can emit after the
// positional cells (scan.mjs:1555). Field 3 being one of these means the
// location column was omitted entirely.
const LABELLED_SEGMENT = /^(?:posted:|trust:|note:)/;

/**
 * Split a pipeline row into its `|` fields and locate the location column.
 *
 * scan.mjs emits four shapes, and backfilling has to handle all of them:
 *
 *   … | {title} | {location} | posted: …            replace field 3
 *   … | {title} | {location} | {salary} | posted: … replace field 3
 *   … | {title} | posted: …                         INSERT at 3
 *   … | {title} |  | {salary} | posted: …           replace field 3 (EMPTY cell)
 *
 * The last one is the trap: a present compensation forces an empty location
 * cell to keep comp positional in column 5, so the column exists but carries
 * nothing. Hence two flags — `hasCell` decides replace-vs-insert, `present`
 * decides whether the row actually needs repairing. Confusing them would
 * either overwrite the posted date or silently skip a repairable row.
 */
export function locationSlot(line) {
  const fields = line.split('|').map(s => s.trim());
  const third = fields.length > 3 ? fields[3] : null;
  const hasCell = third !== null && !LABELLED_SEGMENT.test(third);
  return { fields, index: 3, hasCell, present: hasCell && third !== '' };
}

/**
 * Put `location` into a pipeline row and rescore it.
 *
 * prio is recomputed rather than patched because geography carries 35% of the
 * weight: a row that scored 0.60 with no location is a different row once it
 * turns out to contain a configured target location.
 */
export function rewriteRowLocation(line, location, priority) {
  const { fields, index, hasCell } = locationSlot(line);
  const clean = sanitizeMarkdownField(location);
  if (hasCell) fields[index] = clean;
  else fields.splice(index, 0, clean);

  const title = fields[2] || '';
  const postedField = fields.find(f => f.startsWith('posted:')) || '';
  const posted = Date.parse(postedField.replace('posted:', '').trim());
  const prio = priorityScore(
    { title, location: clean, postedAt: Number.isFinite(posted) ? posted : undefined },
    Date.now(),
    priority,
  );

  return fields.join(' | ').replace(/\bprio [0-9.]+/, `prio ${prio.toFixed(2)}`);
}

function main(argv) {
  let priority;
  try { priority = loadPriorityConfig(undefined, { required: true }); }
  catch (err) { console.error(`apply-descriptions: ${err.message}`); process.exit(1); }
  const dryRun = argv.includes('--dry-run');
  const fileIdx = argv.indexOf('--file');
  const raw = fileIdx !== -1 ? readFileSync(argv[fileIdx + 1], 'utf-8') : readFileSync(0, 'utf-8');

  let items;
  try {
    items = JSON.parse(raw);
  } catch (err) {
    console.error(`apply-descriptions: input is not valid JSON — ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(items)) {
    console.error('apply-descriptions: expected a JSON array of {job_url, description}');
    process.exit(1);
  }

  let pipeline = readFileSync(PIPELINE, 'utf-8');
  const byUrl = indexPipeline(pipeline);

  const stats = {
    input: items.length, unmatched: 0, missingFile: 0, malformed: 0,
    unchanged: 0, updated: 0, descriptions: 0, locations: 0,
  };
  const langs = {};

  for (const item of items) {
    const url = String(item?.job_url || '').trim();
    const description = String(item?.description || '').trim();
    const location = String(item?.location || '').trim();
    if (!url || (!description && !location)) { stats.malformed++; continue; }

    const hit = byUrl.get(url);
    if (!hit) { stats.unmatched++; continue; }

    const jdFile = path.join(ROOT, hit.jdPath);
    if (!existsSync(jdFile)) { stats.missingFile++; continue; }

    const existing = readFileSync(jdFile, 'utf-8');
    let updated = existing;
    let newRow = hit.line;

    if (description) {
      const lang = jdLanguage(description);
      const withBody = rewriteJd(updated, description, lang);
      // No `## Description` heading means this is not a file we wrote. Skip it
      // rather than append and corrupt something we do not understand.
      if (withBody === null) { stats.malformed++; continue; }
      updated = withBody;
      newRow = rewriteRow(newRow, lang);
      langs[lang] = (langs[lang] || 0) + 1;
    }

    if (location) {
      updated = rewriteJdLocation(updated, location);
      newRow = rewriteRowLocation(newRow, location, priority);
    }

    if (updated === existing && newRow === hit.line) { stats.unchanged++; continue; }

    if (!dryRun) {
      if (updated !== existing) writeFileSync(jdFile, updated, 'utf-8');
      // Replacer FUNCTION, not a string: `$&` / `$'` in a scraped title or
      // location are substitution patterns to String.replace and would splice
      // the old row back into the new one. sanitizeMarkdownField strips pipes
      // and brackets, not dollars, and "$120k" in a title is entirely normal.
      if (newRow !== hit.line) pipeline = pipeline.replace(hit.line, () => newRow);
    }
    if (description) stats.descriptions++;
    if (location) stats.locations++;
    stats.updated++;
  }

  if (!dryRun && stats.updated) writeFileSync(PIPELINE, pipeline, 'utf-8');

  const langSummary = Object.entries(langs).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  console.error(
    `apply-descriptions:${dryRun ? ' [dry-run]' : ''} ${stats.input} in → ${stats.updated} updated ` +
    `(${stats.descriptions} descriptions [${langSummary}], ${stats.locations} locations) | ` +
    `unchanged ${stats.unchanged}, unmatched ${stats.unmatched}, ` +
    `missing JD file ${stats.missingFile}, malformed ${stats.malformed}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
