#!/usr/bin/env node
/**
 * Live viewer for fast-jev-compaction.
 *
 * A loopback-only HTTP server the Claude Code hook pushes compaction events to
 * and a browser reads over Server-Sent Events. Everything lives in memory:
 * nothing is written to disk, and the whole run is gone when this process
 * exits. The hook cannot host this itself — a hooks module runs with no Node
 * and no sockets, so it starts this as a sibling process and talks to it over
 * `$.http.fetch`.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOST = '127.0.0.1';
const MAX_EVENTS = 4000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PING_MS = 15_000;
const IDLE_SWEEP_MS = 60_000;

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

const port = Number(arg('--port', '4317'));
const token = arg('--token', '');
const idleMs = Number(arg('--idle-ms', String(30 * 60_000)));

if (!token) {
  console.error('fast-jev viewer: --token is required');
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`fast-jev viewer: --port ${arg('--port', '')} is not a port`);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, 'page.html');

/** @type {{ seq: number, at: number, data: unknown }[]} */
let events = [];
/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();
let seq = 0;
let lastActivity = Date.now();

/** Constant-time token comparison that tolerates a length mismatch. */
function tokenOk(given) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/**
 * A browser sends `Origin`; our hook does not. A page on another origin is
 * refused outright, which — together with the `Host` check — is what stops a
 * malicious page (or a DNS-rebinding host) from reaching this port.
 */
function originOk(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function hostOk(req) {
  const host = req.headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function record(data) {
  const entry = { seq: ++seq, at: Date.now(), data };
  events.push(entry);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  const frame = `id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const client of clients) client.write(frame);
  lastActivity = Date.now();
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  if (!hostOk(req)) return send(res, 421, 'text/plain; charset=utf-8', 'bad host');
  if (!originOk(req)) return send(res, 403, 'text/plain; charset=utf-8', 'bad origin');

  const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
  const given = url.searchParams.get('t') ?? req.headers['x-fast-jev-token'];
  if (!tokenOk(typeof given === 'string' ? given : '')) {
    return send(res, 401, 'text/plain; charset=utf-8', 'bad token');
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, name: 'fast-jev-viewer', events: events.length });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    let page;
    try {
      page = await readFile(templatePath, 'utf8');
    } catch (error) {
      return send(res, 500, 'text/plain; charset=utf-8', `cannot read page.html: ${error.message}`);
    }
    return send(res, 200, 'text/html; charset=utf-8', page, {
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; base-uri 'none'",
    });
  }

  // The page fetches its own source to build the standalone download.
  if (req.method === 'GET' && url.pathname === '/template') {
    try {
      return send(res, 200, 'text/plain; charset=utf-8', await readFile(templatePath, 'utf8'));
    } catch (error) {
      return send(res, 500, 'text/plain; charset=utf-8', error.message);
    }
  }

  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    res.write(`retry: 2000\n\n`);
    for (const entry of events) res.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`);
    clients.add(res);
    lastActivity = Date.now();
    const ping = setInterval(() => res.write(`: ping\n\n`), PING_MS);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
      lastActivity = Date.now();
    });
    return undefined;
  }

  if (req.method === 'POST' && url.pathname === '/event') {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return send(res, 413, 'text/plain; charset=utf-8', error.message);
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(res, 400, 'text/plain; charset=utf-8', 'malformed JSON');
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) record(item);
    return sendJson(res, 200, { ok: true, seq, clients: clients.size });
  }

  if (req.method === 'POST' && url.pathname === '/reset') {
    events = [];
    record({ type: 'reset' });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/shutdown') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 20);
    return undefined;
  }

  return send(res, 404, 'text/plain; charset=utf-8', 'not found');
});

server.on('error', (error) => {
  console.error(`fast-jev viewer: ${error.message}`);
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`fast-jev viewer on http://${HOST}:${port}/?t=${token}`);
});

// Nothing to serve and nobody watching: stop rather than linger for the session.
setInterval(() => {
  if (clients.size === 0 && Date.now() - lastActivity > idleMs) process.exit(0);
}, IDLE_SWEEP_MS).unref?.();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.exit(0));
}
