/**
 * Test server for the page-unload delivery measurements: serves the test page, the built Faro bundles,
 * a small API, and a collector that records every request it receives.
 *
 * It is a plain Node server rather than the smoke harness's Vite dev server for two reasons. The
 * collector must be a real network endpoint, since the smoke specs intercept `/collect` inside the
 * browser with `page.route`, which cannot show what reaches a server while a page unloads. And Vite
 * serves every module as its own request, which would inflate the performance telemetry that the
 * payload size measurements depend on. The page loads the same `/bundles/<name>.iife.js` files that
 * the content delivery network smoke page uses.
 *
 * Run with `node server.ts`. Node strips the types.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import type { Arrival, BodySummary, SideRecords } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const PAGE_DIR = join(HERE, 'page');
const PORT = Number(process.env['PD_PORT'] ?? 5180);
const BUNDLE_DIRECTORIES = ['packages', 'experimental'];

interface Run extends SideRecords {
  /** Delay before the collector (and scenario M's held endpoint) answers. */
  holdMs: number;
  arrivals: Arrival[];
}

const runs = new Map<string, Run>();

function getRun(id: string): Run {
  let run = runs.get(id);
  if (!run) {
    run = { holdMs: 0, arrivals: [], held: [], beacons: [] };
    runs.set(id, run);
  }
  return run;
}

interface TransportBodyShape {
  logs?: Array<{ message?: string }>;
  events?: Array<{ name?: string; attributes?: Record<string, string> }>;
  exceptions?: unknown[];
  measurements?: unknown[];
  traces?: { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ attributes?: unknown }> }> }> };
}

/** Kept in step with `summarizeBody` in page/app.js. */
function summarizeBody(body: TransportBodyShape, run: string): BodySummary {
  const failUrl = `/pd/api/fail/${run}`;
  const counts: Record<string, number> = {};
  for (const key of ['logs', 'events', 'exceptions', 'measurements'] as const) {
    const list = body[key];
    if (Array.isArray(list) && list.length > 0) {
      counts[key] = list.length;
    }
  }
  const spans = (body.traces?.resourceSpans ?? [])
    .flatMap((resourceSpans) => resourceSpans.scopeSpans ?? [])
    .flatMap((scopeSpans) => scopeSpans.spans ?? []);
  if (spans.length > 0) {
    counts['spans'] = spans.length;
  }

  const eventNames: Record<string, number> = {};
  for (const event of body.events ?? []) {
    const name = event.name ?? '?';
    eventNames[name] = (eventNames[name] ?? 0) + 1;
  }

  const logTags: Record<string, number> = {};
  for (const log of body.logs ?? []) {
    const tag = /^\[([A-Za-z]+(?:-[A-Za-z]+)*)-\d+\]/.exec(log.message ?? '')?.[1];
    if (tag) {
      logTags[tag] = (logTags[tag] ?? 0) + 1;
    }
  }

  return {
    counts,
    eventNames,
    failSpans: spans.filter((span) => JSON.stringify(span.attributes ?? []).includes(failUrl)).length,
    failFetchEvents: (body.events ?? []).filter(
      (event) => event.name === 'faro.tracing.fetch' && JSON.stringify(event.attributes ?? {}).includes(failUrl)
    ).length,
    logTags,
  };
}

function findBundle(name: string): string | undefined {
  return BUNDLE_DIRECTORIES.flatMap((group) => {
    const groupRoot = join(REPO_ROOT, group);
    if (!existsSync(groupRoot)) {
      return [];
    }
    return readdirSync(groupRoot).map((entry) => join(groupRoot, entry, 'dist/bundle', `${name}.iife.js`));
  }).find((candidate) => existsSync(candidate));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string | Buffer, contentType = 'application/json'): void {
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', contentType);
  res.end(body);
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};

// Roughly the size of a small JSON API response.
const OK_BODY = JSON.stringify({
  items: Array.from({ length: 20 }, (_, index) => ({ id: index, name: `item ${index}` })),
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [path = ''] = (req.url ?? '').split('?');

  if (path === '/health') {
    send(res, 200, '{}');
    return;
  }

  const collect = /^\/collect\/(\w+)$/.exec(path);
  if (collect && req.method === 'POST') {
    const id = collect[1]!;
    const run = getRun(id);
    const raw = await readBody(req);
    const contentEncoding = req.headers['content-encoding'] ?? null;
    const arrival: Arrival = {
      receivedAtMs: Date.now(),
      bodyBytes: raw.byteLength,
      decodedBytes: raw.byteLength,
      contentEncoding,
      idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
      items: null,
    };
    try {
      const decoded = contentEncoding === 'gzip' ? gunzipSync(raw) : raw;
      arrival.decodedBytes = decoded.byteLength;
      arrival.items = summarizeBody(JSON.parse(decoded.toString('utf8')) as TransportBodyShape, id);
    } catch (error) {
      arrival.parseError = String(error);
    }
    run.arrivals.push(arrival);

    const respond = () => send(res, 202, '{}');
    if (run.holdMs > 0) {
      setTimeout(respond, run.holdMs);
    } else {
      respond();
    }
    return;
  }

  const config = /^\/pd\/config\/(\w+)$/.exec(path);
  if (config && req.method === 'POST') {
    const { holdMs = 0 } = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { holdMs?: number };
    getRun(config[1]!).holdMs = holdMs;
    send(res, 204, '');
    return;
  }

  const collected = /^\/pd\/collected\/(\w+)$/.exec(path);
  if (collected) {
    send(res, 200, JSON.stringify(getRun(collected[1]!).arrivals));
    return;
  }

  // Scenario M: keepalive requests from a page without Faro, held like the collector.
  const held = /^\/pd\/held\/(\w+)\/(\d+)$/.exec(path);
  if (held && req.method === 'POST') {
    const run = getRun(held[1]!);
    await readBody(req);
    run.held.push({ receivedAtMs: Date.now(), index: Number(held[2]) });
    const respond = () => send(res, 200, '{}');
    if (run.holdMs > 0) {
      setTimeout(respond, run.holdMs);
    } else {
      respond();
    }
    return;
  }

  const beacon = /^\/pd\/beacon\/(\w+)$/.exec(path);
  if (beacon && req.method === 'POST') {
    const text = (await readBody(req)).toString('utf8');
    let detail: unknown = text;
    try {
      detail = JSON.parse(text);
    } catch {
      // Keep the raw text.
    }
    getRun(beacon[1]!).beacons.push({ receivedAtMs: Date.now(), detail });
    send(res, 204, '');
    return;
  }

  const side = /^\/pd\/side\/(\w+)$/.exec(path);
  if (side) {
    const { held: heldRequests, beacons } = getRun(side[1]!);
    send(res, 200, JSON.stringify({ held: heldRequests, beacons }));
    return;
  }

  if (/^\/pd\/api\/fail\/\w+$/.test(path)) {
    send(res, 500, '{"error":"failing on purpose"}');
    return;
  }

  if (/^\/pd\/api\/ok\/\w+$/.test(path)) {
    send(res, 200, OK_BODY);
    return;
  }

  const bundle = /^\/bundles\/([\w-]+)\.iife\.js$/.exec(path);
  if (bundle) {
    const file = findBundle(bundle[1]!);
    if (!file) {
      send(res, 404, `No built bundle for "${bundle[1]}". Run "yarn build" from the repository root.`, 'text/plain');
      return;
    }
    send(res, 200, readFileSync(file), CONTENT_TYPES['js']);
    return;
  }

  const page = /^\/pd\/([\w-]+)\.(html|js)$/.exec(path);
  if (page && existsSync(join(PAGE_DIR, `${page[1]}.${page[2]}`))) {
    send(res, 200, readFileSync(join(PAGE_DIR, `${page[1]}.${page[2]}`)), CONTENT_TYPES[page[2]!]);
    return;
  }

  if (path === '/favicon.ico') {
    send(res, 204, '');
    return;
  }

  send(res, 404, 'not found', 'text/plain');
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => send(res, 500, String(error), 'text/plain'));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`pagehide-delivery server on http://127.0.0.1:${PORT}`);
});
