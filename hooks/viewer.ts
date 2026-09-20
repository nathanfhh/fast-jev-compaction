/**
 * The bridge between the compaction hook and the live viewer.
 *
 * A hooks module has no Node and no sockets, so it cannot host the viewer
 * itself. It starts `viewer/server.mjs` as a sibling process through
 * `$.process.run` and pushes events to it over loopback HTTP. Everything here
 * is best-effort: a viewer that will not start, or will not answer, must never
 * cost the user a compaction.
 */
import type { CompactProgress, ToolCall } from '../src/types.js';

export const VIEWER_DEFAULTS = {
  viewerEnabled: true,
  /** 0 walks `viewerPortBase` upwards for a free slot; a number pins that port. */
  viewerPort: 0,
  viewerPortBase: 41000,
  viewerPortSpan: 10,
  viewerAutoOpen: true,
  viewerIdleMinutes: 30,
  viewerNodePath: 'node',
} as const;

/** Tool input is the most sensitive thing on the wire; send a bounded head. */
export const WIRE_INPUT_CHARS = 400;

const HEALTH_ATTEMPTS = 20;
const HEALTH_WAIT_MS = 150;
/**
 * `$.http.fetch` takes no abort signal, and a port that accepts a connection
 * without ever answering (a bare TCP listener) would otherwise hang the probe
 * forever — and with it the compaction that awaited the viewer. Every probe
 * therefore stops waiting on its own.
 */
const PROBE_TIMEOUT_MS = 800;
/** Discovery is on the compaction path: bound the whole walk, not just a hop. */
const DISCOVERY_BUDGET_MS = 6000;

export interface ViewerConfig {
  enabled: boolean;
  /** 0 means "find a free port"; anything else pins that exact port. */
  port: number;
  portBase: number;
  portSpan: number;
  autoOpen: boolean;
  idleMinutes: number;
  nodePath: string;
}

export interface ViewerEvent {
  type: string;
  [key: string]: unknown;
}

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface FetchResponse {
  status: number;
  ok: boolean;
  text: string;
}

/**
 * The host capabilities the viewer needs, as plain functions.
 *
 * Deliberately not `$` itself: `claude plugin validate` refuses to let the
 * engine interface cross an import, so the hook binds each call at its own
 * call site and hands the bound functions over.
 */
export interface ViewerHost {
  fetch: (url: string, init?: FetchInit) => Promise<FetchResponse>;
  run: (
    argv: readonly string[],
    init?: { timeoutMs?: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  storeGet: (key: string) => Promise<unknown>;
  storeSet: (key: string, value: unknown) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  pluginRoot: string;
}

function optionNumber(options: Record<string, unknown>, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionBoolean(options: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function resolveViewerConfig(options: Record<string, unknown>): ViewerConfig {
  const port = Math.floor(optionNumber(options, 'viewerPort', VIEWER_DEFAULTS.viewerPort));
  const base = Math.floor(optionNumber(options, 'viewerPortBase', VIEWER_DEFAULTS.viewerPortBase));
  const span = Math.floor(optionNumber(options, 'viewerPortSpan', VIEWER_DEFAULTS.viewerPortSpan));
  const nodePath = options['viewerNodePath'];
  return {
    enabled: optionBoolean(options, 'viewerEnabled', VIEWER_DEFAULTS.viewerEnabled),
    port: port >= 1 && port <= 65535 ? port : VIEWER_DEFAULTS.viewerPort,
    portBase: base >= 1024 && base <= 65535 ? base : VIEWER_DEFAULTS.viewerPortBase,
    portSpan: span >= 1 && span <= 200 ? span : VIEWER_DEFAULTS.viewerPortSpan,
    autoOpen: optionBoolean(options, 'viewerAutoOpen', VIEWER_DEFAULTS.viewerAutoOpen),
    idleMinutes: Math.max(
      1,
      Math.floor(optionNumber(options, 'viewerIdleMinutes', VIEWER_DEFAULTS.viewerIdleMinutes)),
    ),
    nodePath:
      typeof nodePath === 'string' && nodePath.length > 0 ? nodePath : VIEWER_DEFAULTS.viewerNodePath,
  };
}

/** Single-quotes one argument for `sh -c`. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function viewerUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?t=${token}`;
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function head(input: Record<string, unknown>, limit: number): string {
  let json: string;
  try {
    json = JSON.stringify(input) ?? '';
  } catch {
    json = '[unserializable input]';
  }
  return json.length <= limit ? json : `${json.slice(0, limit)}…`;
}

function wireCall(call: ToolCall): Record<string, unknown> {
  return {
    id: call.id,
    tool: call.tool,
    input: head(call.input, WIRE_INPUT_CHARS),
    resultChars: call.resultChars,
    isError: call.isError,
    pinned: call.pinned,
  };
}

/** Maps one library progress event onto the events the page understands. */
export function toViewerEvents(runId: string, progress: CompactProgress): ViewerEvent[] {
  switch (progress.phase) {
    case 'calls':
      return [
        {
          type: 'run.calls',
          runId,
          candidates: progress.candidates,
          calls: progress.calls.map(wireCall),
        },
      ];
    case 'state':
      return [{ type: 'run.state', runId, tokens: progress.tokens, stage: progress.stage }];
    case 'batches':
      return [{ type: 'run.batches', runId, batches: progress.batches, sizes: [...progress.sizes] }];
    case 'batch-start':
      return [
        {
          type: 'run.batch.start',
          runId,
          index: progress.index,
          total: progress.total,
          ids: [...progress.ids],
        },
      ];
    case 'batch-done':
      return [
        {
          type: 'run.batch.done',
          runId,
          index: progress.index,
          total: progress.total,
          ms: progress.ms,
          answers: progress.answers.map((answer) => ({ ...answer })),
        },
      ];
    case 'decisions':
      return [
        {
          type: 'run.decisions',
          runId,
          decisions: progress.decisions.map((decision) => ({
            id: decision.id,
            tool: decision.tool,
            action: decision.action,
            reason: decision.reason,
            keepCall: decision.keepCall,
            keepResult: decision.keepResult,
          })),
        },
      ];
    case 'applied':
      return [{ type: 'run.applied', runId, stats: { ...progress.stats } }];
    default:
      return [];
  }
}

export interface Viewer {
  /** The page's address; empty until `ensure` has settled on a port. */
  url: () => string;
  port: () => number | null;
  /** Finds a running viewer or starts one; resolves once it answers. */
  ensure: () => Promise<void>;
  post: (events: readonly ViewerEvent[]) => Promise<void>;
  openInBrowser: () => Promise<void>;
}

type Slot = 'ours' | 'foreign' | 'free';

/**
 * What is on a port, asked without the token.
 *
 * `/whoami` needs no credential and reveals only that a viewer is there, so a
 * scan never hands the token to whatever happens to be listening.
 */
async function probe(host: ViewerHost, port: number): Promise<Slot> {
  let settled: Slot | null = null;
  const asked = host.fetch(`http://127.0.0.1:${port}/whoami`).then(
    (response) => {
      settled = response.ok && response.text.includes('fast-jev-viewer') ? 'ours' : 'foreign';
    },
    () => {
      settled = 'free';
    },
  );
  await Promise.race([asked, host.sleep(PROBE_TIMEOUT_MS)]);
  // Silence is not an invitation: a port that will not answer is somebody's.
  return settled ?? 'foreign';
}

/** A viewer of ours on this port that also accepts our token. */
async function healthy(host: ViewerHost, port: number, token: string): Promise<boolean> {
  if ((await probe(host, port)) !== 'ours') return false;
  let ok = false;
  const asked = host.fetch(`http://127.0.0.1:${port}/health?t=${token}`).then(
    (response) => {
      ok = response.ok && response.text.includes('fast-jev-viewer');
    },
    () => undefined,
  );
  await Promise.race([asked, host.sleep(PROBE_TIMEOUT_MS)]);
  return ok;
}

/**
 * The ports to consider, best first: a pinned `port` alone, otherwise the one
 * a previous session settled on, then the range walked upwards.
 */
export function portCandidates(config: ViewerConfig, remembered?: number): number[] {
  if (config.port !== 0) return [config.port];
  const range = Array.from({ length: config.portSpan }, (_, at) => config.portBase + at).filter(
    (port) => port <= 65535,
  );
  if (!remembered) return range;
  return [remembered, ...range.filter((port) => port !== remembered)];
}

/**
 * The token is kept in the plugin store so a server left running by an earlier
 * session is reused instead of fought with for the port.
 */
async function storedToken(host: ViewerHost): Promise<string> {
  const saved = await host.storeGet('viewerToken');
  if (typeof saved === 'string' && /^[0-9a-f]{32}$/.test(saved)) return saved;
  const token = newToken();
  await host.storeSet('viewerToken', token);
  return token;
}

export async function createViewer(host: ViewerHost, config: ViewerConfig): Promise<Viewer> {
  const token = await storedToken(host);
  let port: number | null = null;

  const url = (): string => (port === null ? '' : viewerUrl(port, token));

  const startOn = async (candidate: number): Promise<boolean> => {
    const command = [
      'nohup',
      shellQuote(config.nodePath),
      shellQuote(`${host.pluginRoot}/viewer/server.mjs`),
      '--port',
      String(candidate),
      '--token',
      shellQuote(token),
      '--idle-ms',
      String(config.idleMinutes * 60_000),
      '>/dev/null 2>&1 &',
    ].join(' ');
    await host.run(['/bin/sh', '-c', command], { timeoutMs: 10_000 });
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
      await host.sleep(HEALTH_WAIT_MS);
      if (await healthy(host, candidate, token)) return true;
    }
    return false;
  };

  const ensure = async (): Promise<void> => {
    if (port !== null) return;
    const deadline = Date.now() + DISCOVERY_BUDGET_MS;
    const outOfTime = (): boolean => Date.now() > deadline;
    const saved = await host.storeGet('viewerPort');
    const remembered = typeof saved === 'number' && Number.isInteger(saved) ? saved : undefined;
    const candidates = portCandidates(config, remembered);

    // Reusing a live viewer beats starting another, so every candidate is
    // asked before any is claimed.
    const slots = new Map<number, Slot>();
    for (const candidate of candidates) {
      if (outOfTime()) break;
      if (await healthy(host, candidate, token)) {
        port = candidate;
        await host.storeSet('viewerPort', candidate);
        return;
      }
      slots.set(candidate, await probe(host, candidate));
    }

    for (const candidate of candidates) {
      if (slots.get(candidate) !== 'free') continue;
      if (await startOn(candidate)) {
        port = candidate;
        await host.storeSet('viewerPort', candidate);
        return;
      }
    }

    if (outOfTime()) {
      throw new Error(
        `gave up looking for a viewer port after ${DISCOVERY_BUDGET_MS} ms (ports slow to answer)`,
      );
    }
    const taken = candidates.filter((candidate) => slots.get(candidate) !== 'free').length;
    throw new Error(
      config.port !== 0
        ? `viewer did not answer on 127.0.0.1:${config.port} (is '${config.nodePath}' on PATH, or is the port taken?)`
        : `no free port for the viewer in ${config.portBase}-${
            config.portBase + config.portSpan - 1
          } (${taken} of ${candidates.length} in use; is '${config.nodePath}' on PATH?)`,
    );
  };

  const post = async (events: readonly ViewerEvent[]): Promise<void> => {
    if (events.length === 0 || port === null) return;
    await host.fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fast-jev-token': token },
      body: JSON.stringify(events),
    });
  };

  const openInBrowser = async (): Promise<void> => {
    if (port === null) return;
    for (const opener of ['open', 'xdg-open']) {
      try {
        const { exitCode } = await host.run([opener, url()], { timeoutMs: 5_000 });
        if (exitCode === 0) return;
      } catch {
        /* try the next one */
      }
    }
  };

  return { url, port: () => port, ensure, post, openInBrowser };
}
