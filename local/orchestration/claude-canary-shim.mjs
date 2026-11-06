#!/usr/bin/env node

import { isMainModule } from '../../lib/is-main-module.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_FORBIDDEN = [
  'cv.md',
  'article-digest.md',
  'modes/_profile.md',
  'modes/_shared.md',
  'config/profile.yml',
  'modes/_custom.md',
  'llms.txt',
];

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function forbiddenSources(value, forbidden = DEFAULT_FORBIDDEN) {
  if (typeof value !== 'string') return [];
  const normalized = value.replaceAll('\\', '/');
  return forbidden.filter(source => {
    const target = escapeRegExp(source);
    return new RegExp(`(^|[^A-Za-z0-9_.-])${target}(?=$|[^A-Za-z0-9_.-])`).test(normalized);
  });
}

// Fields that CARRY content rather than address it. A report's prose legitimately
// names cv.md and article-digest.md ("Evidence: cv.md, Acme"), and scanning it
// flagged a clean Write as a forbidden access in the pre-injection baseline.
// Writing about a file is not reading it.
const CONTENT_KEYS = new Set(['content', 'new_string', 'old_string', 'replace_all']);

function stringValues(value, out = [], skipKeys = null) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => stringValues(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (skipKeys && skipKeys.has(key)) continue;
      stringValues(item, out);
    }
  }
  return out;
}

export function createState() {
  return {
    toolCalls: [],
    forbiddenAccesses: [],
    assistantUsage: [],
    usage: null,
    numTurns: null,
    totalCostUsd: null,
    resultText: '',
    lastAssistantText: '',
    errorEnvelopes: [],
    parseErrors: 0,
  };
}

export function observeEvent(state, event, rawLine = JSON.stringify(event)) {
  if (event?.type === 'assistant' && event.message) {
    if (event.message.usage) state.assistantUsage.push(event.message.usage);
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('');
    if (text) state.lastAssistantText = text;

    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      const filePath = typeof input.file_path === 'string' ? input.file_path.replaceAll('\\', '/') : null;
      const forbidden = new Set();
      if (filePath) forbiddenSources(filePath).forEach(item => forbidden.add(item));
      for (const value of stringValues(input, [], CONTENT_KEYS)) {
        forbiddenSources(value).forEach(item => forbidden.add(item));
      }
      const call = { id: block.id ?? null, name: block.name ?? null, filePath, input, forbidden: [...forbidden] };
      state.toolCalls.push(call);
      if (call.forbidden.length) state.forbiddenAccesses.push(call);
    }
  }

  if (event?.type === 'result') {
    if (event.usage) state.usage = event.usage;
    if (Number.isFinite(event.num_turns)) state.numTurns = event.num_turns;
    if (Number.isFinite(event.total_cost_usd)) state.totalCostUsd = event.total_cost_usd;
    if (event.is_error || (event.subtype && event.subtype !== 'success')) {
      state.errorEnvelopes.push(rawLine);
    } else if (typeof event.result === 'string') {
      state.resultText = event.result;
    }
  } else if (event?.type === 'error') {
    state.errorEnvelopes.push(rawLine);
  }
}

export function analyzeLines(lines) {
  const state = createState();
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    try {
      observeEvent(state, JSON.parse(rawLine), rawLine);
    } catch {
      state.parseErrors++;
    }
  }
  return state;
}

function effectiveExitCode(claudeExitCode, parseErrors) {
  return claudeExitCode || (parseErrors > 0 ? 1 : 0);
}

function metricsFrom(state, invocationId, claudeExitCode) {
  const exitCode = effectiveExitCode(claudeExitCode, state.parseErrors);
  return {
    invocationId,
    exitCode,
    claudeExitCode,
    usage: state.usage,
    assistantUsage: state.assistantUsage,
    numTurns: state.numTurns,
    totalCostUsd: state.totalCostUsd,
    toolCount: state.toolCalls.length,
    forbiddenAccessCount: state.forbiddenAccesses.length,
    toolCalls: state.toolCalls,
    forbiddenAccesses: state.forbiddenAccesses,
    errorEnvelopeCount: state.errorEnvelopes.length,
    parseErrors: state.parseErrors,
  };
}

export function cliArgs(args, safeMode = false) {
  const clean = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--include-partial-messages' || args[i] === '--verbose') continue;
    if (args[i] === '--output-format') { i++; continue; }
    if (args[i].startsWith('--output-format=')) continue;
    if (safeMode && args[i] === '--safe-mode') continue;
    clean.push(args[i]);
  }
  return ['--output-format', 'stream-json', '--verbose', ...(safeMode ? ['--safe-mode'] : []), ...clean];
}

async function run(args) {
  const realClaude = process.env.CANARY_REAL_CLAUDE;
  const metricsDir = process.env.CANARY_METRICS_DIR;
  if (!realClaude || !path.isAbsolute(realClaude)) throw new Error('CANARY_REAL_CLAUDE must be an absolute path');
  if (!metricsDir || !path.isAbsolute(metricsDir)) throw new Error('CANARY_METRICS_DIR must be an absolute path');

  fs.mkdirSync(metricsDir, { recursive: true, mode: 0o700 });
  const invocationId = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const rawPath = path.join(metricsDir, `${invocationId}.ndjson`);
  const metricsPath = path.join(metricsDir, `${invocationId}.metrics.json`);
  const rawFd = fs.openSync(rawPath, 'wx', 0o600);
  const state = createState();
  let pending = '';

  const child = spawn(realClaude, cliArgs(args, process.env.CANARY_SAFE_MODE === '1'), {
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  child.stderr.pipe(process.stderr);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    fs.writeSync(rawFd, chunk);
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const rawLine of lines) {
      if (!rawLine.trim()) continue;
      try {
        observeEvent(state, JSON.parse(rawLine), rawLine);
      } catch {
        state.parseErrors++;
      }
    }
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (pending.trim()) {
    try {
      observeEvent(state, JSON.parse(pending), pending);
    } catch {
      state.parseErrors++;
    }
  }
  fs.closeSync(rawFd);

  const metrics = metricsFrom(state, invocationId, exitCode);
  fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, {
    flag: 'wx', mode: 0o600,
  });

  if (state.errorEnvelopes.length) {
    process.stdout.write(`${state.errorEnvelopes.join('\n')}\n`);
  } else {
    const result = state.resultText || state.lastAssistantText;
    if (result) process.stdout.write(result.endsWith('\n') ? result : `${result}\n`);
  }
  process.exitCode = metrics.exitCode;
}

function demo() {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10 }, content: [
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/repo/cv.md' } },
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'sed -n 1,20p config/profile.yml' } },
      { type: 'tool_use', id: 'shared-1', name: 'Read', input: { file_path: '/tmp/repo/modes/_shared.md' } },
      { type: 'tool_use', id: 'clean-1', name: 'Read', input: { file_path: '/tmp/repo/jds/acme.md' } },
    ] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3,
      total_cost_usd: 0.12, usage: { input_tokens: 10, cache_read_input_tokens: 5 }, result: 'done' }),
  ];
  const state = analyzeLines(lines);
  assert.equal(state.toolCalls.length, 4);
  assert.equal(state.forbiddenAccesses.length, 3);
  assert.deepEqual(state.forbiddenAccesses[0].forbidden, ['cv.md']);
  assert.deepEqual(state.forbiddenAccesses[1].forbidden, ['config/profile.yml']);
  assert.deepEqual(state.forbiddenAccesses[2].forbidden, ['modes/_shared.md']);
  assert.equal(state.resultText, 'done');
  assert.equal(state.numTurns, 3);

  const errorLine = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true,
    result: 'Session limit reached; resets 1pm' });
  const errorState = analyzeLines([errorLine]);
  assert.deepEqual(errorState.errorEnvelopes, [errorLine]);
  assert.equal(errorState.resultText, '');
  const malformedState = analyzeLines(['not-json']);
  assert.equal(malformedState.parseErrors, 1);
  assert.equal(effectiveExitCode(0, malformedState.parseErrors), 1, 'malformed NDJSON fails a clean Claude exit');
  assert.equal(effectiveExitCode(7, malformedState.parseErrors), 7, 'the real Claude failure remains authoritative');

  assert.deepEqual(
    cliArgs(['-p', 'prompt', '--output-format', 'json', '--include-partial-messages',
      '--verbose', '--model', 'opus', '--verbose', '--output-format=stream-json']),
    ['--output-format', 'stream-json', '--verbose', '-p', 'prompt', '--model', 'opus'],
    'stream flags are replaced once and all other arguments keep their order',
  );
  const normalArgs = cliArgs(['-p', 'prompt', '--no-session-persistence', '--model', 'opus']);
  assert.deepEqual(normalArgs,
    ['--output-format', 'stream-json', '--verbose', '-p', 'prompt', '--no-session-persistence', '--model', 'opus'],
    'normal mode leaves runner arguments unchanged');
  const safeArgs = cliArgs([
    '-p', 'prompt', '--safe-mode', '--no-session-persistence', '--safe-mode', '--model', 'opus',
  ], true);
  assert.equal(safeArgs.filter(arg => arg === '--safe-mode').length, 1, 'safe mode is inserted exactly once');
  assert.deepEqual(safeArgs,
    ['--output-format', 'stream-json', '--verbose', '--safe-mode', '-p', 'prompt',
      '--no-session-persistence', '--model', 'opus'],
    'safe mode keeps all other runner arguments in order');
  console.log('claude-canary-shim self-check: all assertions passed');
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`Usage: node local/orchestration/claude-canary-shim.mjs [--demo | <claude arguments...>]

  --demo       Run the offline parser and argument self-checks.
  --help, -h   Show this help without creating metrics or launching Claude.

Worker invocations require CANARY_REAL_CLAUDE and CANARY_METRICS_DIR to be
absolute paths. Other arguments are forwarded to Claude with stream logging.`);
  } else if (args.includes('--demo')) demo();
  else run(args).catch(error => {
    console.error(`claude-canary-shim: ${error.message}`);
    process.exitCode = 1;
  });
}
