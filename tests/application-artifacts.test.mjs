import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { rmSync } from './helpers.mjs';
import { applicationArtifactPaths, ensureApplicationArtifactDirs, slugifySegment, writeReuseDecision } from '../application-artifacts.mjs';
import { safeOutputPath } from '../generate-cover-letter.mjs';
import { repoRelativeManifestPath, workspaceRelativeManifestPath } from '../generate-pdf.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

function expectError(label, action, pattern) {
  try {
    action();
  } catch (error) {
    if (pattern.test(error.message)) {
      console.log(`  ✅ ${label}`);
      return;
    }
    throw new Error(`${label}: unexpected error: ${error.message}`);
  }
  throw new Error(`${label}: expected an error`);
}

const root = mkdtempSync(join(tmpdir(), 'career-ops-application-artifacts-'));
try {
  const paths = applicationArtifactPaths({ reportNum: 7, company: 'Acme AI', role: 'Senior AI Engineer', version: 2, root });
  if (paths.key === '007-acme-ai-senior-ai-engineer'
      && paths.cv.source.html === join(paths.root, 'cv', 'source', 'original.html')
      && paths.cv.tailored.html === join(paths.root, 'cv', 'tailored', 'v002', '007-cv.html')
      && paths.cv.tailored.pdf === join(paths.root, 'cv', 'tailored', 'v002', '007-cv.pdf')
      && paths.cover.markdown === join(paths.root, 'cover', '007-cover-letter.md')
      && paths.cover.html === join(paths.root, 'cover', '007-cover-letter.html')
      && paths.cover.pdf === join(paths.root, 'cover', '007-cover-letter.pdf')
      && paths.outreach.email === join(paths.root, 'outreach', '007-recruiter-email.md')) {
    console.log('  ✅ package leaves use the stable report number');
  } else {
    throw new Error(`unexpected artifact paths: ${JSON.stringify(paths)}`);
  }

  ensureApplicationArtifactDirs(paths);
  if (existsSync(join(paths.root, 'jd'))
      && existsSync(join(paths.root, 'cv', 'source'))
      && existsSync(join(paths.root, 'cv', 'tailored', 'v002'))
      && existsSync(join(paths.root, 'cover'))
      && existsSync(join(paths.root, 'outreach'))
      && existsSync(join(paths.root, 'decision'))) {
    console.log('  ✅ application artifact directories initialize together');
  } else {
    throw new Error('application artifact directories were not created');
  }

  writeReuseDecision(paths, {
    decision: 'reuse-with-edits',
    score: 0.81,
    sourceCv: paths.cv.source.html,
    currentJd: paths.jd.current,
    previousSource: paths.jd.previous,
    changedSections: ['Summary', 'Skills'],
  });
  const decision = JSON.parse(readFileSync(paths.decision.reuse, 'utf8'));
  if (decision.decision === 'reuse-with-edits' && decision.changed_sections.length === 2) {
    console.log('  ✅ reuse decisions are recorded beside the artifact bundle');
  } else {
    throw new Error(`unexpected reuse decision: ${JSON.stringify(decision)}`);
  }

  expectError('report numbers must be numeric', () => applicationArtifactPaths({ reportNum: 'x', company: 'Acme', role: 'Engineer', root }), /reportNum must be a numeric report number/);
  expectError('versions must be positive integers', () => applicationArtifactPaths({ reportNum: 7, company: 'Acme', role: 'Engineer', version: 0, root }), /version must be a positive integer/);
  expectError('reuse decisions reject unknown values', () => writeReuseDecision(paths, { decision: 'maybe' }), /decision must be one of/);
  expectError('changed sections must be an array', () => writeReuseDecision(paths, { decision: 'reuse', changedSections: 'Summary' }), /changedSections must be an array/);
  if (slugifySegment('!!!') === 'application') console.log('  ✅ punctuation-only slugs use the application fallback');
  else throw new Error('punctuation-only slug did not use the application fallback');

  // Manifest paths are relative to the workspace, which is the data root, not
  // the working directory: the two differ whenever the data root is pointed
  // elsewhere, as the suite points it (tests/helpers.mjs, #5113).
  const repoPaths = applicationArtifactPaths({ reportNum: 7, company: 'Acme AI', role: 'Senior AI Engineer', version: 2, root: join(getCareerOpsRoot(), 'output') });
  if (workspaceRelativeManifestPath(repoPaths.cv.tailored.html) === 'output/007-acme-ai-senior-ai-engineer/cv/tailored/v002/007-cv.html'
      && workspaceRelativeManifestPath(repoPaths.cv.tailored.pdf) === 'output/007-acme-ai-senior-ai-engineer/cv/tailored/v002/007-cv.pdf'
      && repoRelativeManifestPath(repoPaths.cv.tailored.pdf) === workspaceRelativeManifestPath(repoPaths.cv.tailored.pdf)) {
    console.log('  ✅ nested application HTML and PDF paths remain manifest-safe');
  } else {
    throw new Error('nested application paths were not preserved as repo-relative manifest entries');
  }

  if (safeOutputPath('output/007-acme-ai-senior-ai-engineer/cover/007-cover-letter.pdf')
      === join(getCareerOpsRoot(), 'output', '007-acme-ai-senior-ai-engineer', 'cover', '007-cover-letter.pdf')) {
    console.log('  ✅ cover output preserves safe nested bundle paths');
  } else {
    throw new Error('safe nested cover output path was not preserved');
  }
  if (safeOutputPath('legacy-cover.pdf') === join(getCareerOpsRoot(), 'output', 'legacy-cover.pdf')) {
    console.log('  ✅ flat one-off cover paths remain compatible');
  } else {
    throw new Error('flat cover output path compatibility changed');
  }
  expectError('cover output rejects traversal outside output', () => safeOutputPath('output/../escaped.pdf'), /outside output/);

  const cli = spawnSync(process.execPath, [
    fileURLToPath(new URL('../application-artifacts.mjs', import.meta.url)),
    '--report', 'bad', '--company', 'Acme', '--role', 'Engineer', '--init',
  ], { encoding: 'utf8' });
  if (cli.status === 1
      && /application-artifacts: reportNum must be a numeric report number/.test(cli.stderr)
      && !/\n\s+at /.test(cli.stderr)) {
    console.log('  ✅ CLI validation failures exit cleanly without a stack trace');
  } else {
    throw new Error(`CLI failure was not clean: status=${cli.status} stderr=${JSON.stringify(cli.stderr)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
