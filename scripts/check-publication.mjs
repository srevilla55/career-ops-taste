#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { isMainModule } from '../lib/is-main-module.mjs';
import { USER_PATHS, MANIFEST_USER_PATH_OVERLAPS, localUserPaths } from '../update-system.mjs';

const scaffold = new Set([...MANIFEST_USER_PATH_OVERLAPS, 'interview-prep/.gitkeep']);
const privatePaths = [...USER_PATHS, 'local/search.json', 'config/privacy.yml',
  '.career-ops-data', '.env', '.mcp.json',
  'batch/batch-input.tsv', 'batch/batch-state.tsv', 'batch/tracker-additions/',
  'batch/logs/', 'local/data/', 'local/canary-results/', 'local/source-health.json',
  'local/linkedin-retry-at.txt', 'local/linkedin-request-after.txt'];

export function forbiddenPublicationPaths(paths) {
  return paths.filter(name => {
    if (scaffold.has(name) || ['batch/logs/.gitkeep', 'batch/tracker-additions/.gitkeep'].includes(name)) return false;
    if (privatePaths.some(p => p.endsWith('/') ? name.startsWith(p) : name === p)) return true;
    if (name.split('/').some(part => ['node_modules', '.venv', '__pycache__', '.next', '.git'].includes(part))) return true;
    const base = name.split('/').at(-1);
    return /^(?:\.env(?:\..*)?|client_secret.*\.json|credentials\.json|token\.json|.*\.bak(?:[-.].*)?)$/i.test(base)
      && base !== '.env.example';
  });
}

if (isMainModule(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
    console.log('Usage: node scripts/check-publication.mjs [--history]');
    process.exit(0);
  }
  localUserPaths(process.cwd()); // Validate the shared fork-source declaration.
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const revisions = process.argv.includes('--history') ? git('rev-list', 'HEAD').trim().split('\n') : [];
  const current = git('ls-files', '-z').split('\0').filter(Boolean);
  const failures = new Set(forbiddenPublicationPaths(current));
  for (const revision of revisions) {
    for (const name of forbiddenPublicationPaths(git('ls-tree', '-r', '--name-only', '-z', revision).split('\0').filter(Boolean))) failures.add(name);
  }
  if (failures.size) {
    console.error('Private paths cannot be published:\n' + [...failures].sort().join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Publication path guard passed: ${current.length} indexed files, ${revisions.length} historical commits.`);
  }
}
