// The web component is released separately and deliberately excluded from the
// core updater. This fork retains web 0.6.1; only these named newer frontend
// features may be absent. Never turn a missing file in a newer/unknown install
// into a skip, or a partial feature into an absent one.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NEWER_WEB_FEATURES = {
  analytics: ['web/src/lib/analytics-metrics.mjs'],
  reportPersistence: ['web/src/lib/report-envelope.mjs', 'web/src/lib/report-persist.mjs'],
  promotedVerdict: ['web/src/lib/report-sections.mjs'],
  scheduledScans: ['web/scripts/scheduled-jobs-runner.mjs'],
  quietCompanies: ['web/src/app/api/quiet-companies/route.ts'],
  stats: ['web/src/app/api/stats/route.ts'],
  patterns: ['web/src/app/api/patterns/route.ts'],
  keywordMatch: ['web/src/app/api/keyword-match/route.ts'],
  upskill: ['web/src/app/api/upskill/route.ts'],
  companyHistory: ['web/src/app/api/company-history/route.ts'],
};

export function preservedWebLacks(root, feature) {
  const paths = NEWER_WEB_FEATURES[feature];
  if (!paths) throw new Error(`Unknown web capability: ${feature}`);
  let version;
  try { version = JSON.parse(readFileSync(join(root, 'web/package.json'), 'utf8')).version; }
  catch { return false; }
  return version === '0.6.1' && paths.every((file) => !existsSync(join(root, file)));
}

export function missingWebFeatureReason(feature) {
  return `preserved web 0.6.1 does not expose ${feature}; the separate newer frontend was not installed`;
}
