#!/usr/bin/env node
/**
 * build-cv.mjs — fill templates/cv-template.html from a JSON spec.
 *
 * The pdf mode is deliberately agent-driven: what goes ON the page is a judgement call per
 * job (modes/pdf.md), and this script does not make it. It only handles the mechanical half
 * that was being retyped for every role, and bakes in the two things that cost real time
 * the first time round:
 *
 *   1. **Empty sections are omitted, not blanked.** Passing "" for a section leaves a
 *      `.section` with an empty `.section-title` in the page. It still occupies vertical
 *      space, and that alone pushed a CV that fits comfortably (855px of content against a
 *      1007px budget) onto a second page. It cost several rounds of trimming real bullets
 *      to chase a phantom overflow.
 *   2. **PAGE_WIDTH is the printable width, not the paper width.** The @page margin is
 *      already applied, so 210mm here overflows the content box.
 *
 *   node local/orchestration/build-cv.mjs spec.json out.html
 *
 * Spec: { lang, name, email, phone, linkedin, github, location, summary,
 *         competencies: [], experience: [{company, location, period, role, bullets: []}],
 *         projects: [{title, tech, desc}], education: [{title, org, year, desc}],
 *         skills: [{category, items}], certifications: [{title, org}] }
 */

import { isMainModule } from '../../lib/is-main-module.mjs';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// A4 210mm less the 0.6in margins generate-pdf applies on each side.
export const PRINTABLE_WIDTH = '179.5mm';

const esc = s => String(s ?? '').replace(/&(?![a-z]+;|#\d+;)/g, '&amp;');

/**
 * Drop a section's whole block when it has no content.
 *
 * The template hardcodes each `<div class="section">`, so blanking the placeholders leaves
 * the wrapper behind. Matching on the comment marker removes the wrapper too.
 */
export function dropSection(html, marker) {
  const start = html.indexOf(`<!-- ${marker} -->`);
  if (start === -1) return html;
  // Sections nest to different depths (awards and certifications carry an extra table
  // div), so counting closing tags is fragile. Every section is delimited by the next
  // HTML comment, which is not.
  const next = html.indexOf('<!--', start + 4);
  const end = next === -1 ? html.length : next;
  return html.slice(0, start) + html.slice(end);
}

export function render(spec, tpl) {
  const experience = (spec.experience || []).map(j => `
<div class="job">
  <div class="job-header">
    <span class="job-company">${esc(j.company)}</span>
    <span class="job-location">${esc(j.location)}</span>
  </div>
  <div class="job-subheader">
    <div class="job-role">${esc(j.role)}</div>
    <div class="job-period">${esc(j.period)}</div>
  </div>
  <ul>${(j.bullets || []).map(b => `\n    <li>${b}</li>`).join('')}
  </ul>
</div>`).join('\n');

  const projects = (spec.projects || []).map(p => `
<div class="project">
  <div class="project-header">
    <div class="project-title">${esc(p.title)}</div>
    ${p.tech ? `<div class="project-tech">${esc(p.tech)}</div>` : ''}
  </div>
  <div class="project-desc">${p.desc}</div>
</div>`).join('\n');

  const education = (spec.education || []).map(e => `
<div class="edu-item">
  <div class="edu-header">
    <div class="edu-title">${esc(e.title)}</div>
    <div class="edu-year">${esc(e.year)}</div>
  </div>
  <div class="edu-org">${esc(e.org)}</div>${e.desc ? `\n  <div class="edu-desc">${e.desc}</div>` : ''}
</div>`).join('\n');

  const skills = (spec.skills || []).length
    ? `<div class="skills-grid">${(spec.skills || []).map(s =>
        `\n  <div class="skill-item"><span class="skill-category">${esc(s.category)}:</span> ${s.items}</div>`).join('')}\n</div>`
    : '';

  const certs = (spec.certifications || []).map(c =>
    `<div class="cert-item"><span class="cert-title">${esc(c.title)}</span><span class="cert-org">${esc(c.org)}</span></div>`).join('');

  const vals = {
    LANG: spec.lang || 'en', NAME: spec.name, EMAIL: spec.email, PHONE: spec.phone,
    LINKEDIN_URL: `https://${spec.linkedin}`, LINKEDIN_DISPLAY: spec.linkedin,
    PORTFOLIO_URL: `https://${spec.github}`, PORTFOLIO_DISPLAY: spec.github,
    LOCATION: spec.location, PHOTO: '', TITLE_BLOCK: '', CONSENT: '', PAGE_WIDTH: PRINTABLE_WIDTH,
    SECTION_SUMMARY: spec.labels?.summary || 'Summary', SUMMARY_TEXT: spec.summary,
    SECTION_COMPETENCIES: spec.labels?.competencies || 'Core Competencies',
    COMPETENCIES: (spec.competencies || []).map(c => `<div class="competency-tag">${esc(c)}</div>`).join(''),
    SECTION_EXPERIENCE: spec.labels?.experience || 'Work Experience', EXPERIENCE: experience,
    SECTION_PROJECTS: spec.labels?.projects || 'Projects', PROJECTS: projects,
    SECTION_EDUCATION: spec.labels?.education || 'Education', EDUCATION: education,
    SECTION_CERTIFICATIONS: spec.labels?.certifications || 'Certifications', CERTIFICATIONS: certs,
    SECTION_AWARDS: '', AWARDS: '',
    SECTION_INTERESTS: '', INTERESTS: '',
    SECTION_SKILLS: spec.labels?.skills || 'Technical Skills', SKILLS: skills,
  };

  let out = tpl;
  for (const [k, v] of Object.entries(vals)) out = out.replaceAll(`{{${k}}}`, v ?? '');

  // Whatever the spec left empty gets its wrapper removed, not just its contents.
  if (!certs) out = dropSection(out, 'CERTIFICATIONS');
  if (!vals.AWARDS) out = dropSection(out, 'AWARDS');
  if (!projects) out = dropSection(out, 'PROJECTS');
  if (!vals.COMPETENCIES) out = dropSection(out, 'CORE COMPETENCIES');
  if (!experience) out = dropSection(out, 'WORK EXPERIENCE');
  out = dropSection(out, 'INTERESTS');
  return out;
}

function demo() {
  const tpl = readFileSync(path.join(ROOT, 'templates/cv-template.html'), 'utf-8');
  const html = render({
    name: 'A B', email: 'a@b.c', phone: '1', linkedin: 'l/x', github: 'g/x', location: 'Madrid',
    summary: 'S', competencies: ['One'],
    experience: [{ company: 'Acme', location: 'Madrid', period: '2024', role: 'Dev', bullets: ['<strong>Did</strong> a thing'] }],
    education: [{ title: 'BSc', org: 'UPM', year: '2026' }],
    skills: [{ category: 'Cloud', items: 'Docker' }],
  }, tpl);

  assert.ok(!html.includes('{{'), 'every placeholder is filled');
  assert.ok(html.includes(PRINTABLE_WIDTH), 'uses the printable width, not the paper width');
  assert.ok(html.includes('Acme') && html.includes('Did'), 'experience renders');
  assert.ok(html.includes('>l/x</a>') && !html.includes('>https://l/x</a>'), 'visible links omit the scheme');

  // The bug this file exists to prevent: an empty section must leave nothing behind,
  // because an empty .section-title still takes vertical space and silently costs a page.
  assert.ok(!/<div class="section-title"><\/div>/.test(html), 'no empty section survives');
  // Check the rendered markup, not the stylesheet — the template's CSS defines
  // .award-table / .cert-table regardless of whether either section is used.
  const body = html.slice(html.indexOf('<body'));
  assert.ok(!body.includes('<div class="award-table">'), 'the unused awards section is removed entirely');
  assert.ok(!body.includes('<div class="cert-table">'), 'the unused certifications section is removed entirely');
  assert.ok(body.includes('skills-grid'), 'a populated section is kept');
  assert.ok(body.includes('<!-- SKILLS -->'), 'dropping a section does not eat its neighbours');
  console.log('build-cv self-check: all assertions passed');
}

// The shared guard handles imports, direct execution and symlinked worker roots.
if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node local/orchestration/build-cv.mjs spec.json out.html | --demo');
  } else if (process.argv.includes('--demo')) demo();
  else {
    const [specPath, outPath] = process.argv.slice(2);
    const tpl = readFileSync(path.join(ROOT, 'templates/cv-template.html'), 'utf-8');
    writeFileSync(outPath, render(JSON.parse(readFileSync(specPath, 'utf-8')), tpl), 'utf-8');
    console.log(`wrote ${outPath}`);
  }
}
