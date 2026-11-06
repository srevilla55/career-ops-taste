#!/usr/bin/env node
// Read-only: for each numbered output/ package, resolve candidate job-posting
// URLs via manifest.json -> draft-answers.json -> jd/current.md front matter
// -> report **URL:** header. Prints one line per package: dir\turls\tsources
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT_DIR = join(ROOT, 'output');
const REPORTS_DIR = join(ROOT, 'reports');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function urlsFromManifest(dir) {
  const m = readJson(join(dir, 'manifest.json'));
  if (!m) return [];
  return [m.official_job_url, m.application_url].filter(Boolean);
}

function urlsFromDraftAnswers(dir) {
  const d = readJson(join(dir, 'application', 'draft-answers.json'));
  if (!d) return [];
  return [d.job_url, d.application_url].filter(Boolean);
}

function urlsFromJd(dir) {
  const path = join(dir, 'jd', 'current.md');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const urls = [];
  for (const re of [
    /-\s*\*\*Original URL:\*\*\s*(\S+)/i,
    /^original_url:\s*["']?(\S+?)["']?\s*$/im,
    /^official_url:\s*["']?(\S+?)["']?\s*$/im,
    /^apply_url:\s*["']?(\S+?)["']?\s*$/im,
  ]) {
    const match = text.match(re);
    if (match) urls.push(match[1]);
  }
  return urls;
}

function urlFromReport(reportNum) {
  const match = readdirSync(REPORTS_DIR).find((f) => f.startsWith(`${reportNum}-`));
  if (!match) return null;
  const text = readFileSync(join(REPORTS_DIR, match), 'utf8');
  const m = text.match(/^\*\*URL:\*\*\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

const dirs = readdirSync(OUTPUT_DIR).filter((d) => /^\d{3}-/.test(d));
for (const d of dirs) {
  const full = join(OUTPUT_DIR, d);
  const num = d.slice(0, 3);
  const found = [];
  for (const url of urlsFromManifest(full)) found.push([url, 'manifest']);
  if (found.length === 0) for (const url of urlsFromDraftAnswers(full)) found.push([url, 'draft-answers']);
  if (found.length === 0) for (const url of urlsFromJd(full)) found.push([url, 'jd']);
  const reportUrl = urlFromReport(num);
  if (reportUrl) found.push([reportUrl, 'report']);

  const seen = new Set();
  const dedup = [];
  for (const [url, src] of found) {
    if (!seen.has(url)) { seen.add(url); dedup.push(`${url} (${src})`); }
  }
  console.log(`${d}\t${dedup.join(' | ')}`);
}
