import { describe, expect, it } from 'vitest';
import {
  WIRE_INPUT_CHARS,
  createViewer,
  newToken,
  resolveViewerConfig,
  shellQuote,
  toViewerEvents,
  viewerUrl,
  type ViewerConfig,
  type ViewerHost,
} from '../hooks/viewer.ts';
import { compact, type CompactProgress, type Message } from '../src/index.js';

const config: ViewerConfig = {
  enabled: true,
  port: 4317,
  autoOpen: true,
  idleMinutes: 30,
  nodePath: 'node',
};

/** A `$` stand-in that records what the hook asked the host to do. */
function host(options: { healthyAfter?: number } = {}) {
  const healthyAfter = options.healthyAfter ?? 0;
  const calls = { health: 0, posts: [] as Array<{ url: string; body: string; token?: string }>, run: [] as string[][] };
  const store = new Map<string, unknown>();
  const fake: ViewerHost = {
    async fetch(url, init) {
      if (url.includes('/health')) {
        calls.health += 1;
        if (calls.health <= healthyAfter) throw new Error('ECONNREFUSED');
        return { status: 200, ok: true, text: '{"ok":true,"name":"fast-jev-viewer"}' };
      }
      calls.posts.push({ url, body: init?.body ?? '', token: init?.headers?.['x-fast-jev-token'] });
      return { status: 200, ok: true, text: '{"ok":true}' };
    },
    async run(argv) {
      calls.run.push([...argv]);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async storeGet(key) {
      return store.get(key);
    },
    async storeSet(key, value) {
      store.set(key, value);
    },
    async sleep() {},
    pluginRoot: '/plugins/fast jev',
  };
  return { fake, calls, store };
}

describe('viewer config', () => {
  it('defaults, overrides and rejects an impossible port', () => {
    expect(resolveViewerConfig({})).toEqual(config);
    expect(resolveViewerConfig({ viewerPort: 5000, viewerEnabled: false })).toMatchObject({
      port: 5000,
      enabled: false,
    });
    expect(resolveViewerConfig({ viewerPort: -1 }).port).toBe(4317);
    expect(resolveViewerConfig({ viewerIdleMinutes: 0 }).idleMinutes).toBe(1);
  });

  it('quotes shell arguments and builds a loopback url', () => {
    expect(shellQuote("/a/it's here")).toBe(`'/a/it'\\''s here'`);
    expect(viewerUrl(4317, 'abc')).toBe('http://127.0.0.1:4317/?t=abc');
    expect(newToken()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('viewer lifecycle', () => {
  it('reuses a server that already answers', async () => {
    const { fake, calls } = host();
    const viewer = await createViewer(fake, config);
    await viewer.ensure();
    await viewer.ensure();
    expect(calls.run).toHaveLength(0);
    expect(calls.health).toBe(1);
  });

  it('starts a detached server with quoted paths when nothing answers', async () => {
    const { fake, calls, store } = host({ healthyAfter: 2 });
    const viewer = await createViewer(fake, config);
    await viewer.ensure();
    expect(calls.run[0]?.[0]).toBe('/bin/sh');
    const command = calls.run[0]?.[2] ?? '';
    expect(command).toContain("nohup 'node' '/plugins/fast jev/viewer/server.mjs'");
    expect(command).toContain('--port 4317');
    expect(command).toContain('--idle-ms 1800000');
    expect(command.endsWith('>/dev/null 2>&1 &')).toBe(true);
    expect(command).toContain(String(store.get('viewerToken')));
  });

  it('keeps one token across viewers and sends it as a header, never in the body', async () => {
    const { fake, calls, store } = host();
    const first = await createViewer(fake, config);
    await first.post([{ type: 'run.start', runId: 'r1' }]);
    const second = await createViewer(fake, config);
    expect(second.url).toBe(first.url);
    expect(store.size).toBe(1);
    expect(calls.posts[0]?.token).toBe(store.get('viewerToken'));
    expect(calls.posts[0]?.body).toBe('[{"type":"run.start","runId":"r1"}]');
    expect(calls.posts[0]?.body).not.toContain(String(store.get('viewerToken')));
  });

  it('gives up with a usable message when the server never answers', async () => {
    const { fake } = host({ healthyAfter: Number.MAX_SAFE_INTEGER });
    const viewer = await createViewer(fake, config);
    await expect(viewer.ensure()).rejects.toThrow(/did not answer on 127\.0\.0\.1:4317/);
  });

  it('posts nothing for an empty batch', async () => {
    const { fake, calls } = host();
    await (await createViewer(fake, config)).post([]);
    expect(calls.posts).toHaveLength(0);
  });
});

describe('wire events', () => {
  const call = {
    id: 't1',
    tool_use_id: 'toolu_1',
    tool: 'Read',
    input: { file_path: 'src/a.ts', body: 'x'.repeat(2000) },
    callIndex: 1,
    resultIndex: 2,
    resultChars: 4213,
    isError: false,
    pinned: false,
  };

  it('bounds the tool input it puts on the wire', () => {
    const [event] = toViewerEvents('r1', { phase: 'calls', calls: [call], candidates: 1 });
    const wired = (event as { calls: Array<{ input: string }> }).calls[0]!;
    expect(wired.input.length).toBe(WIRE_INPUT_CHARS + 1);
    expect(wired.input.endsWith('…')).toBe(true);
    expect(event).toMatchObject({ type: 'run.calls', runId: 'r1', candidates: 1 });
  });

  it('maps every phase to exactly one event', () => {
    const phases: CompactProgress[] = [
      { phase: 'calls', calls: [call], candidates: 1 },
      { phase: 'state', tokens: 18400, stage: 'texts abridged' },
      { phase: 'batches', batches: 2, sizes: [8, 3] },
      { phase: 'batch-start', index: 1, total: 2, ids: ['t1'] },
      { phase: 'batch-done', index: 1, total: 2, ms: 640, answers: [{ id: 't1', keepCall: 0.9, keepResult: 0.2 }] },
      {
        phase: 'decisions',
        decisions: [
          { id: 't1', tool: 'Read', action: 'drop_result', reason: 'result_dropped', keepCall: 0.9, keepResult: 0.2 },
        ],
      },
      { phase: 'applied', stats: { charsBefore: 10, charsAfter: 4 } as never },
    ];
    expect(phases.flatMap((phase) => toViewerEvents('r1', phase)).map((event) => event.type)).toEqual([
      'run.calls',
      'run.state',
      'run.batches',
      'run.batch.start',
      'run.batch.done',
      'run.decisions',
      'run.applied',
    ]);
  });
});

describe('compact progress', () => {
  const transcript: Message[] = [
    { role: 'user', text: 'fix the parser', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'z'.repeat(900) }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b', text: 'PASS' }] },
    { role: 'user', text: 'thanks', toolUses: [] },
  ];

  const asker = {
    async ask(_state: unknown, questions: Record<string, unknown>) {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((name) => [name, { type: 'noul' as const, noul: 0.1 }]),
        ),
      };
    },
  };

  it('reports every phase in order, ending with the applied stats', async () => {
    const seen: CompactProgress[] = [];
    const result = await compact(transcript, asker, {
      preserveRecentMessages: 1,
      onProgress: (event) => seen.push(event),
    });
    expect(seen.map((event) => event.phase)).toEqual([
      'calls',
      'state',
      'batches',
      'batch-start',
      'batch-done',
      'decisions',
      'applied',
    ]);
    const applied = seen.at(-1);
    expect(applied?.phase === 'applied' && applied.stats).toBe(result.stats);
    const done = seen.find((event) => event.phase === 'batch-done');
    expect(done?.phase === 'batch-done' && done.answers).toEqual([
      { id: 't1', keepCall: 0.1, keepResult: 0.1 },
      { id: 't2', keepCall: 0.1, keepResult: 0.1 },
    ]);
  });

  it('never lets a listener break a compaction', async () => {
    await expect(
      compact(transcript, asker, {
        preserveRecentMessages: 1,
        onProgress: () => {
          throw new Error('viewer exploded');
        },
      }),
    ).resolves.toMatchObject({ stats: { calls: 2 } });
  });
});
