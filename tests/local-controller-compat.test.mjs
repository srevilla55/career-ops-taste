import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkOutputFiles, hasPacketArtifact } from '../local/orchestration/next-step.mjs';

test('output packet discovery keeps relative bundle paths and excludes nested checkouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-packet-walk-'));
  try {
    mkdirSync(join(root, '047-acme-role/outreach'), { recursive: true });
    mkdirSync(join(root, '048-other-role/outreach'), { recursive: true });
    writeFileSync(join(root, '047-acme-role/outreach/047-recruiter-email.md'), 'fictional draft');
    writeFileSync(join(root, 'legacy-outreach-draft.md'), 'fictional draft');
    writeFileSync(join(root, '048-other-role/.git'), 'gitdir: /fictional/worktree');
    writeFileSync(join(root, '048-other-role/outreach/048-recruiter-email.md'), 'outside this checkout');
    const paths = walkOutputFiles(root).map(file => file.replaceAll('\\', '/'));
    assert.deepEqual(paths, ['047-acme-role/outreach/047-recruiter-email.md', 'legacy-outreach-draft.md']);
    assert.ok(hasPacketArtifact(paths, '047', 'acme'));
    assert.ok(hasPacketArtifact(paths, '046', 'legacy'));
    assert.equal(hasPacketArtifact(paths, '048', 'other'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
