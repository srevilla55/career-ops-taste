import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenPublicationPaths } from '../scripts/check-publication.mjs';

test('publication rejects candidate content disguised as scaffolding and local credentials', () => {
  const privateFiles = ['cv.md', 'config/profile.yml', 'local/search.json', '.env',
    'web/.env.production', 'local/client_secret_123.json', 'data/private/README.md',
    'reports/README.md', 'output/cv.pdf', 'batch/batch-state.tsv',
    'batch/logs/run.txt', 'local/canary-results/run/summary.md', 'local/.venv/bin/python'];
  assert.deepEqual(forbiddenPublicationPaths(privateFiles), privateFiles);
  assert.deepEqual(forbiddenPublicationPaths(['config/profile.example.yml',
    'local/search.example.json', '.env.example', 'docs/PRIVACY.md', 'data/.gitkeep',
    'documents/README.md', 'interview-prep/sessions/README.md', 'batch/logs/.gitkeep']), []);
});
