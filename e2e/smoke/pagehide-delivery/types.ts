/** Item types and counts in a Faro transport body. */
export interface BodySummary {
  counts: Record<string, number>;
  eventNames: Record<string, number>;
  /** Client spans for this run's failing request. */
  failSpans: number;
  /** `faro.tracing.fetch` events for this run's failing request. */
  failFetchEvents: number;
  /** Log messages written by the page start with `[tag-n]`. Counts per tag. */
  logTags: Record<string, number>;
}

/** What the collector saw for one request. */
export interface Arrival {
  /** `Date.now()` when the whole body had arrived. */
  receivedAtMs: number;
  /** Bytes on the wire, so compressed bytes for a compressed body. */
  bodyBytes: number;
  /** Bytes after decompression. */
  decodedBytes: number;
  contentEncoding: string | null;
  idempotencyKey: string | null;
  items: BodySummary | null;
  parseError?: string;
}

/** The transport's private delivery queue, read at a lifecycle event. */
export interface QueueState {
  inProgress: number;
  queued: number;
  admitted: number;
  waitingRetry: number;
  unloading: boolean;
}

export interface TimelineEntry {
  /** `performance.timeOrigin + performance.now()`. */
  atMs: number;
  name: string;
  [detail: string]: unknown;
}

/** A collector request as the page's fetch wrapper saw it start. */
export interface StartEntry extends TimelineEntry {
  id: number;
  keepalive: boolean;
  idempotencyKey: string | null;
  contentEncoding: string | null;
  bodyBytes: number | null;
  transportUnloading: boolean | null;
  items: BodySummary | null;
  failSpan: string;
}

/** Scenario M: what reached the held endpoint, and the page's beacons. */
export interface SideRecords {
  held: Array<{ receivedAtMs: number; index: number }>;
  beacons: Array<{ receivedAtMs: number; detail: unknown }>;
}

export interface ConsoleEntry {
  /** `Date.now()` in the test process when Playwright reported the message. */
  atMs: number;
  type: string;
  text: string;
}

export interface TrialResult {
  scenario: string;
  variant: string;
  trial: number;
  browserName: string;
  browserVersion: string;
  run: string;
  /** False when the page ran without observers (`observe=0`). The timeline is then empty. */
  observed: boolean;
  /** Collector hold or delay for this trial, in ms. */
  holdMs: number;
  /** How long the spec waited for arrivals after the landing page loaded. */
  settleMs: number;
  timeline: TimelineEntry[];
  arrivals: Arrival[];
  /** Page console messages, as Playwright reported them. */
  console: ConsoleEntry[];
  side?: SideRecords;
}
