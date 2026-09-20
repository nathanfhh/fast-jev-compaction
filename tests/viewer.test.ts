import { describe, expect, it } from 'vitest';
import {
  WIRE_INPUT_CHARS,
  createViewer,
  newToken,
  portCandidates,
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
  port: 0,
  portBase: 41000,
  portSpan: 4,
  autoOpen: true,
  idleMinutes: 30,
  nodePath: 'node',
};

/** `port: 0` scans; a pinned port is the other mode. */
const pinned: ViewerConfig = { ...config, port: 41000 };

type Occupant = 'ours' | 'foreign';

/**
 * A `$` stand-in over a fake machine: `occupied` says what already listens on
 * which port, and `startable` which ports a launched server manages to bind.
 */
function host(options: { occupied?: Record<number, Occupant>; startable?: number[] } = {}) {
  const occupied: Record<number, Occupant> = { ...(options.occupied ?? {}) };
  const startable = options.startable;
  const calls = {
    probes: [] as number[],
    tokenedProbes: [] as number[],
    posts: [] as Array<{ url: string; body: string; token?: string }>,
    run: [] as string[][],
  };
  const store = new Map<string, unknown>();
  const portOf = (url: string): number => Number(/127\.0\.0\.1:(\d+)/.exec(url)?.[1] ?? 0);

  const fake: ViewerHost = {
    async fetch(url, init) {
      const port = portOf(url);
      if (url.includes('/whoami')) {
        calls.probes.push(port);
        const who = occupied[port];
        if (!who) throw new Error('ECONNREFUSED');
        return who === 'ours'
          ? { status: 200, ok: true, text: '{"name":"fast-jev-viewer","port":' + port + '}' }
          : { status: 404, ok: false, text: 'nope' };
      }
      if (url.includes('/health')) {
        calls.tokenedProbes.push(port);
        if (occupied[port] !== 'ours') throw new Error('ECONNREFUSED');
        return { status: 200, ok: true, text: '{"ok":true,"name":"fast-jev-viewer"}' };
      }
      calls.posts.push({ url, body: init?.body ?? '', token: init?.headers?.['x-fast-jev-token'] });
      return { status: 200, ok: true, text: '{"ok":true}' };
    },
    async run(argv) {
      calls.run.push([...argv]);
      const port = Number(/--port (\d+)/.exec(argv[2] ?? '')?.[1] ?? 0);
      // A launch only takes if nothing holds the port (and the test allows it).
      if (port && !occupied[port] && (!startable || startable.includes(port))) {
        occupied[port] = 'ours';
      }
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
  return { fake, calls, store, occupied };
}

describe('viewer config', () => {
  it('defaults, overrides and rejects impossible values', () => {
    expect(resolveViewerConfig({})).toEqual({ ...config, portSpan: 10 });
    expect(resolveViewerConfig({ viewerPort: 5000, viewerEnabled: false })).toMatchObject({
      port: 5000,
      enabled: false,
    });
    expect(resolveViewerConfig({ viewerPort: -1 }).port).toBe(0);
    expect(resolveViewerConfig({ viewerPortBase: 80 }).portBase).toBe(41000);
    expect(resolveViewerConfig({ viewerPortSpan: 0 }).portSpan).toBe(10);
    expect(resolveViewerConfig({ viewerIdleMinutes: 0 }).idleMinutes).toBe(1);
  });

  it('orders the ports it will try', () => {
    expect(portCandidates(config)).toEqual([41000, 41001, 41002, 41003]);
    expect(portCandidates(config, 41002)).toEqual([41002, 41000, 41001, 41003]);
    expect(portCandidates(config, 4317)[0]).toBe(4317);
    expect(portCandidates(pinned)).toEqual([41000]);
  });

  it('quotes shell arguments and builds a loopback url', () => {
    expect(shellQuote("/a/it's here")).toBe(`'/a/it'\\''s here'`);
    expect(viewerUrl(4317, 'abc')).toBe('http://127.0.0.1:4317/?t=abc');
    expect(newToken()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('viewer lifecycle', () => {
  it('reuses a viewer already listening rather than starting another', async () => {
    const { fake, calls } = host({ occupied: { 41000: 'ours' } });
    const viewer = await createViewer(fake, config);
    await viewer.ensure();
    await viewer.ensure();
    expect(calls.run).toHaveLength(0);
    expect(viewer.port()).toBe(41000);
    expect(viewer.url()).toMatch(/^http:\/\/127\.0\.0\.1:41000\/\?t=[0-9a-f]{32}$/);
  });

  it('walks past ports other services hold and starts on the first free one', async () => {
    const { fake, calls, store } = host({ occupied: { 41000: 'foreign', 41001: 'foreign' } });
    const viewer = await createViewer(fake, config);
    await viewer.ensure();
    expect(viewer.port()).toBe(41002);
    expect(store.get('viewerPort')).toBe(41002);
    expect(calls.run).toHaveLength(1);
    expect(calls.run[0]?.[2]).toContain('--port 41002');
  });

  it('never sends the token to a port before /whoami says it is ours', async () => {
    const { fake, calls } = host({ occupied: { 41000: 'foreign', 41001: 'ours' } });
    await (await createViewer(fake, config)).ensure();
    expect(calls.probes).toContain(41000);
    expect(calls.tokenedProbes).not.toContain(41000);
    expect(calls.tokenedProbes).toContain(41001);
  });

  it('prefers the port a previous session settled on', async () => {
    const { fake, store } = host({ occupied: { 41000: 'ours', 41003: 'ours' } });
    await store.set('viewerPort', 41003);
    const viewer = await createViewer(fake, config);
    await viewer.ensure();
    expect(viewer.port()).toBe(41003);
  });

  it('starts a detached server with quoted paths', async () => {
    const { fake, calls, store } = host();
    await (await createViewer(fake, config)).ensure();
    expect(calls.run[0]?.[0]).toBe('/bin/sh');
    const command = calls.run[0]?.[2] ?? '';
    expect(command).toContain("nohup 'node' '/plugins/fast jev/viewer/server.mjs'");
    expect(command).toContain('--port 41000');
    expect(command).toContain('--idle-ms 1800000');
    expect(command.endsWith('>/dev/null 2>&1 &')).toBe(true);
    expect(command).toContain(String(store.get('viewerToken')));
  });

  it('keeps one token across viewers and sends it as a header, never in the body', async () => {
    const { fake, calls, store } = host({ occupied: { 41000: 'ours' } });
    const first = await createViewer(fake, config);
    await first.ensure();
    await first.post([{ type: 'run.start', runId: 'r1' }]);
    const second = await createViewer(fake, config);
    await second.ensure();
    expect(second.url()).toBe(first.url());
    expect(calls.posts[0]?.token).toBe(store.get('viewerToken'));
    expect(calls.posts[0]?.body).toBe('[{"type":"run.start","runId":"r1"}]');
    expect(calls.posts[0]?.body).not.toContain(String(store.get('viewerToken')));
  });

  it('says so when the whole range is taken', async () => {
    const { fake } = host({ occupied: { 41000: 'foreign', 41001: 'foreign', 41002: 'foreign', 41003: 'foreign' } });
    const viewer = await createViewer(fake, config);
    await expect(viewer.ensure()).rejects.toThrow(/no free port .* 41000-41003 \(4 of 4 in use/);
  });

  it('keeps the pinned-port message when a port was asked for by name', async () => {
    const { fake } = host({ occupied: { 41000: 'foreign' } });
    const viewer = await createViewer(fake, pinned);
    await expect(viewer.ensure()).rejects.toThrow(/did not answer on 127\.0\.0\.1:41000/);
  });

  it('posts nothing before a port is settled, or for an empty batch', async () => {
    const { fake, calls } = host({ occupied: { 41000: 'ours' } });
    const viewer = await createViewer(fake, config);
    await viewer.post([{ type: 'run.start' }]);
    expect(calls.posts).toHaveLength(0);
    await viewer.ensure();
    await viewer.post([]);
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
