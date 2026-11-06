import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import "../helpers/web-ts-alias-loader.mjs";

const systemRoot = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const yamlUrl = pathToFileURL(require.resolve("js-yaml")).href;
const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const homeModule = dataModule(`
  export const careerOpsRoot = () => process.env.CAREER_OPS_ROOT;
  export const rootScript = (name) => ${JSON.stringify(systemRoot)} + name + '.mjs';
`);

// Load the actual route source with its framework imports replaced. The real
// core CLIs run against fictional data; no frontend install or model call.
function routeModule(relative) {
  const file = path.join(systemRoot, "web", relative);
  let source = stripTypeScriptTypes(fs.readFileSync(file, "utf8"));
  source = source.replace('import { NextResponse } from "next/server";', "const NextResponse = Response;");
  source = source.replaceAll('"js-yaml"', JSON.stringify(yamlUrl));
  source = source.replace(/(from\s+|import\s*)(["'])(@\/[^"']+|\.\.?\/[^"']+)\2/g, (_all, prefix, _quote, specifier) => {
    let target = specifier.startsWith("@/") ? path.join(systemRoot, "web/src", specifier.slice(2)) : path.resolve(path.dirname(file), specifier);
    if (!path.extname(target)) target = [".ts", ".mjs"].map((ext) => target + ext).find(fs.existsSync) ?? target;
    return prefix + JSON.stringify(pathToFileURL(target).href);
  });
  return dataModule(source);
}

const request = (value) => new Request("http://localhost/fixture", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});

test("cadence and status routes use the upgraded core without replacing profile data", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-web-contract-"));
  const envKeys = ["CAREER_OPS_ROOT", "CAREER_OPS_DATA_DIR", "CAREER_OPS_TRACKER", "CAREER_OPS_CODE_ROOT"];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    fs.mkdirSync(path.join(fixture, "config"));
    fs.mkdirSync(path.join(fixture, "data"));
    const profile = path.join(fixture, "config/profile.yml");
    const tracker = path.join(fixture, "data/applications.md");
    fs.writeFileSync(profile, "name: Fixture Candidate\nfollowup_cadence:\n  applied_first_days: 11\n");
    fs.writeFileSync(tracker, "# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-01-01 | Example Co | Engineer | 4.2/5 | Applied | ❌ | — | fixture |\n");
    process.env.CAREER_OPS_ROOT = fixture;
    process.env.CAREER_OPS_DATA_DIR = "";
    process.env.CAREER_OPS_TRACKER = tracker;
    process.env.CAREER_OPS_CODE_ROOT = systemRoot;
    const cadence = await import(routeModule("src/app/api/followups/cadence/route.ts"));
    const settings = await (await cadence.GET()).json();
    assert.equal(settings.defaultsAvailable, true);
    assert.equal(settings.defaults.applied_first_days, 7);
    assert.equal(settings.effective.applied_first_days, 11);
    assert.equal((await cadence.POST(request({ applied_first_days: "1.5" }))).status, 400);
    assert.equal((await cadence.POST(request(null))).status, 400);

    const malformed = "- invalid profile\n";
    fs.writeFileSync(profile, malformed);
    assert.equal((await cadence.POST(request({ applied_first_days: 13 }))).status, 409);
    assert.equal(fs.readFileSync(profile, "utf8"), malformed);
    fs.writeFileSync(profile, "name: Fixture Candidate\nfollowup_cadence:\n  applied_first_days: 11\n");
    assert.equal((await cadence.POST(request({ applied_first_days: 13 }))).status, 200);
    assert.match(fs.readFileSync(profile, "utf8"), /name: Fixture Candidate/);
    assert.equal((await (await cadence.GET()).json()).effective.applied_first_days, 13);

    const status = await import(routeModule("src/app/api/status/route.ts"));
    assert.equal((await status.POST(request(null))).status, 400);
    assert.equal((await status.POST(request({ n: {}, status: "Responded" }))).status, 400);
    const response = await status.POST(request({ n: "1", status: "Responded" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status: "Responded", changed: true, statusLogged: true });
    assert.match(fs.readFileSync(tracker, "utf8"), /\| Responded \|/);
    assert.match(fs.readFileSync(path.join(fixture, "data/status-log.tsv"), "utf8"), /\tweb\t/);
    assert.equal((await status.POST(request({ n: "99", status: "Responded" }))).status, 404);
    // Data-only roots use the states fallback. New canonical stages must remain
    // writable there, including aliases, and still go through the locked CLI.
    const assessment = await status.POST(request({ n: "1", status: "online assessment" }));
    assert.equal(assessment.status, 200);
    assert.equal((await assessment.json()).status, "Assessment");
    assert.match(fs.readFileSync(tracker, "utf8"), /\| Assessment \|/);
    assert.match(fs.readFileSync(path.join(fixture, "data/status-log.tsv"), "utf8"), /Responded\tAssessment\tweb\t/);

  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});


test("tracker posting URLs follow the core link contract", async () => {
  const { parseApplications } = await import("../../src/lib/tracker-table.mjs");
  const { extractCellUrl } = await import(pathToFileURL(path.join(systemRoot, "tracker-parse.mjs")).href);
  const cells = [
    "[ATS](https://jobs.example.com/Engineer_(Remote))",
    "[ATS](<https://jobs.example.com/Engineer_(Remote)> \"title\")",
    "[ATS](https://jobs.example.com/Engineer_\\(Remote\\))",
    "[local](reports/001-example.md) [posting](https://jobs.example.com/1)",
    "https://jobs.example.com/1", "—", "", "[invalid](javascript:alert(1))",
  ];
  const header = "| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |";
  const markdown = [header, ...cells.map((cell, i) => `| ${i + 1} | 2026-01-01 | Example | Engineer | 4/5 | Evaluated | | | | ${cell} |`)].join("\n");
  const rows = parseApplications(markdown, systemRoot);
  assert.deepEqual(rows.map((row) => row.url), cells.map(extractCellUrl));
  assert.ok(parseApplications(markdown.replace(/ \| URL \|/, " | Other |"), systemRoot).every((row) => row.url === ""));
});

test("Assessment aliases and status colour match the active stage", async () => {
  const { canonStatus, statusDot, CANONICAL_STATES } = await import(routeModule("src/lib/format.ts"));
  assert.ok(CANONICAL_STATES.includes("Assessment"));
  for (const status of ["Assessment", "screening", "online assessment", "online_assessment", "online screening"]) {
    assert.equal(canonStatus(status), "ASSESSMENT");
    assert.equal(statusDot(status), statusDot("Responded"));
  }
});
