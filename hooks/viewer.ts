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
  viewerPort: 4317,
  viewerAutoOpen: true,
  viewerIdleMinutes: 30,
  viewerNodePath: 'node',
} as const;

/** Tool input is the most sensitive thing on the wire; send a bounded head. */
export const WIRE_INPUT_CHARS = 400;

const HEALTH_ATTEMPTS = 20;
const HEALTH_WAIT_MS = 150;

export interface ViewerConfig {
  enabled: boolean;
  port: number;
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
  const nodePath = options['viewerNodePath'];
  return {
    enabled: optionBoolean(options, 'viewerEnabled', VIEWER_DEFAULTS.viewerEnabled),
    port: port >= 1 && port <= 65535 ? port : VIEWER_DEFAULTS.viewerPort,
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
  readonly url: string;
  /** Starts the server when it is not already up; resolves once it answers. */
  ensure: () => Promise<void>;
  post: (events: readonly ViewerEvent[]) => Promise<void>;
  openInBrowser: () => Promise<void>;
}

async function healthy(host: ViewerHost, port: number, token: string): Promise<boolean> {
  try {
    const response = await host.fetch(`http://127.0.0.1:${port}/health?t=${token}`);
    return response.ok && response.text.includes('fast-jev-viewer');
  } catch {
    return false;
  }
}

/**
 * The token is kept in the plugin store so a server left running by an earlier
 * session is reused instead of fighting it for the port.
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
  const { port } = config;
  const url = viewerUrl(port, token);
  let ready = false;

  const ensure = async (): Promise<void> => {
    if (ready) return;
    if (await healthy(host, port, token)) {
      ready = true;
      return;
    }
    const server = `${host.pluginRoot}/viewer/server.mjs`;
    const command = [
      'nohup',
      shellQuote(config.nodePath),
      shellQuote(server),
      '--port',
      String(port),
      '--token',
      shellQuote(token),
      '--idle-ms',
      String(config.idleMinutes * 60_000),
      '>/dev/null 2>&1 &',
    ].join(' ');
    await host.run(['/bin/sh', '-c', command], { timeoutMs: 10_000 });
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
      await host.sleep(HEALTH_WAIT_MS);
      if (await healthy(host, port, token)) {
        ready = true;
        return;
      }
    }
    throw new Error(
      `viewer did not answer on 127.0.0.1:${port} (is '${config.nodePath}' on PATH, or is the port taken?)`,
    );
  };

  const post = async (events: readonly ViewerEvent[]): Promise<void> => {
    if (events.length === 0) return;
    await host.fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fast-jev-token': token },
      body: JSON.stringify(events),
    });
  };

  const openInBrowser = async (): Promise<void> => {
    for (const opener of ['open', 'xdg-open']) {
      try {
        const { exitCode } = await host.run([opener, url], { timeoutMs: 5_000 });
        if (exitCode === 0) return;
      } catch {
        /* try the next one */
      }
    }
  };

  return { url, ensure, post, openInBrowser };
}
