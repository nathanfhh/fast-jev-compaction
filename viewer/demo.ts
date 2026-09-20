/**
 * Drives the live viewer with a scripted compaction, so the page can be worked
 * on (and the wiring checked) without spending Jev calls.
 *
 * `npm run demo:viewer` — starts the server if it is not up, replays a
 * realistic transcript through the real `compact()` and the real event mapping,
 * and prints the URL.
 */
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compact, type JevQuestions, type Message } from '../src/index.js';
import { toViewerEvents, type ViewerEvent } from '../hooks/viewer.ts';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env['FJV_PORT'] ?? 4317);
const token = process.env['FJV_TOKEN'] ?? randomBytes(16).toString('hex');
const base = `http://127.0.0.1:${port}`;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${base}/health?t=${token}`);
    return response.ok && (await response.text()).includes('fast-jev-viewer');
  } catch {
    return false;
  }
}

async function ensureServer(): Promise<void> {
  if (await healthy()) return;
  const child = spawn(
    process.execPath,
    [join(here, 'server.mjs'), '--port', String(port), '--token', token],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    if (await healthy()) return;
  }
  throw new Error(`viewer did not start on ${base}`);
}

async function post(events: readonly ViewerEvent[]): Promise<void> {
  await fetch(`${base}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fast-jev-token': token },
    body: JSON.stringify(events),
  }).catch(() => undefined);
}

let n = 0;
function pair(tool: string, input: Record<string, unknown>, output: string, isError = false): Message[] {
  const tool_use_id = `toolu_${++n}`;
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id, tool, input, text: output, isError }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id, text: output, isError }] },
  ];
}

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing parser test in the checkout service. Do not touch legacy/.', toolUses: [] },
  ...pair('Glob', { pattern: 'src/**/*.ts' }, 'src/parser.ts\nsrc/parser.test.ts\nsrc/legacy/parser.ts'),
  ...pair('Read', { file_path: 'src/legacy/parser.ts' }, `// legacy\n${'export const legacy = true;\n'.repeat(90)}`),
  { role: 'assistant', text: 'The legacy parser is unrelated; looking at the public one.', toolUses: [] },
  ...pair('Read', { file_path: 'src/parser.ts' }, `export function parse(t: Token[]) {\n${'  // …\n'.repeat(140)}}`),
  ...pair('Bash', { command: 'npx vitest run src/parser.test.ts' },
    'FAIL src/parser.test.ts\n  parser > accepts a trailing comma\n    Expected: true\n    Received: false', true),
  ...pair('Grep', { pattern: 'COMMA', path: 'src' }, 'src/parser.ts:41:  if (token === COMMA) advance();'),
  { role: 'assistant', text: 'The token loop stops too early before a closing brace. Adding one transition.', toolUses: [] },
  ...pair('Edit', {
    file_path: 'src/parser.ts',
    old_string: 'if (token === COMMA) advance();',
    new_string: 'if (token === COMMA) {\n  if (next === CLOSE_BRACE) continue;\n  advance();\n}',
  }, 'The file src/parser.ts has been updated.'),
  ...pair('Bash', { command: 'npx vitest run src/parser.test.ts' }, 'PASS src/parser.test.ts\n  ✓ accepts a trailing comma (4 ms)'),
  ...pair('Bash', { command: 'npm test' }, 'PASS src/parser.test.ts\nPASS src/checkout.test.ts\nTest Suites: 2 passed'),
  { role: 'assistant', text: 'Everything passes; the public API is unchanged.', toolUses: [] },
  { role: 'user', text: 'Great. Now add a changelog entry.', toolUses: [] },
];

/** Plausible scores: the stale reads go, the failing run and the edit stay. */
const SCORES: Record<string, [number, number]> = {
  Glob: [0.28, 0.11],
  Read: [0.41, 0.17],
  Grep: [0.35, 0.22],
  Edit: [0.94, 0.88],
  Bash: [0.78, 0.63],
};

const runId = randomUUID();

const asker = {
  async ask(_state: unknown, questions: JevQuestions) {
    await sleep(700);
    const answers: Record<string, { type: 'noul'; noul: number }> = {};
    for (const [name, question] of Object.entries(questions)) {
      const tool = /\((\w+)[,)]/.exec(question.instructions)?.[1] ?? 'Read';
      const [call, result] = SCORES[tool] ?? [0.5, 0.5];
      answers[name] = { type: 'noul', noul: name.startsWith('call_') ? call! : result! };
    }
    return { answers };
  },
};

await ensureServer();
console.log(`viewer: ${base}/?t=${token}`);
await post([{ type: 'run.start', runId, at: Date.now(), trigger: 'demo', messagesBefore: transcript.length }]);

const result = await compact(transcript, asker, {
  preserveRecentMessages: 2,
  maxRequestTokens: 7000,
  onProgress: (progress) => void post(toViewerEvents(runId, progress)),
});

await sleep(250);
await post([{ type: 'run.done', runId, outcome: 'replaced', messagesAfter: result.messages.length }]);
console.log(
  `replayed: ${result.stats.messagesBefore} → ${result.stats.messagesAfter} messages, ` +
    `${result.stats.requests} request(s), ${result.stats.kept} kept / ` +
    `${result.stats.resultsDropped} truncated / ${result.stats.callsDropped} dropped`,
);
