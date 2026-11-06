import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const prompt = readFileSync(fileURLToPath(new URL('../batch/batch-prompt.md', import.meta.url)), 'utf8');

test('batch CV payloads and the canonical HTML/PDF bundle are report-scoped', () => {
  const paths = prompt.match(/cv-candidate-(?:\{\{REPORT_NUM\}\}-)?\{company-slug\}[^\s`]*/g) || [];
  assert.ok(paths.length >= 2, 'the payload write and renderer must both use a report-scoped file');
  for (const path of paths) {
    assert.match(path, /^cv-candidate-\{\{REPORT_NUM\}\}-\{company-slug\}/, `path without the report number: ${path}`);
  }
  assert.match(prompt, /node application-artifacts\.mjs --report \{\{REPORT_NUM\}\}/);
  assert.match(prompt, /cv\.tailored\.html[\s\S]*cv\.tailored\.pdf[\s\S]*leaf filenames begin\s+with `\{\{REPORT_NUM\}\}`/);
});
