/**
 * Collects the `pd-result` attachment from every trial and prints one table per scenario, with raw
 * counts summed over trials. Also writes summary.md and results.json (every trial's timeline and
 * arrivals) into the output directory.
 *
 * Counting rules, used in every table:
 * - "fetch calls" are calls the page's fetch wrapper saw for the collector, split by keepalive flag. A
 *   transport resend of the same delivery is a second call with the same Idempotency-Key.
 * - "requests started" and "arrived" count distinct Idempotency-Keys.
 * - "waiting at end of hide" is the transport queue's admitted deliveries minus those in progress,
 *   read when the hidden visibilitychange event finished: queued behind the concurrency limit or
 *   still being prepared (compressed). They had not started by then.
 */
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { QueueState, StartEntry, TimelineEntry, TrialResult } from './types';

const BUDGET = 60_000;
const END_OF_HIDE = 'visibilitychange:hidden: after SDK';

const startsOf = (result: TrialResult) => result.timeline.filter(({ name }) => name === 'fetch:start') as StartEntry[];
const indexOf = (result: TrialResult, name: string) => result.timeline.findIndex((entry) => entry.name === name);
const find = (result: TrialResult, name: string): TimelineEntry | undefined =>
  result.timeline.find((entry) => entry.name === name);
const queueAt = (result: TrialResult, name: string) => find(result, name)?.['queue'] as QueueState | null | undefined;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function arrivedKey(result: TrialResult, key: string | null | undefined): boolean {
  return key != null && result.arrivals.some(({ idempotencyKey }) => idempotencyKey === key);
}

interface Delivery {
  calls: number;
  keepaliveCalls: number;
  requests: number;
  arrived: number;
  neverArrived: number;
  resends: number;
  duplicates: number;
  waitingAtEnd: number;
}

function delivery(result: TrialResult): Delivery {
  const starts = startsOf(result);
  const keys = new Set(starts.map(({ idempotencyKey }) => idempotencyKey));
  const arrivals = new Map<string | null, number>();
  for (const { idempotencyKey } of result.arrivals) {
    arrivals.set(idempotencyKey, (arrivals.get(idempotencyKey) ?? 0) + 1);
  }
  const end = queueAt(result, END_OF_HIDE);
  return {
    calls: starts.length,
    keepaliveCalls: starts.filter(({ keepalive }) => keepalive).length,
    requests: keys.size,
    arrived: [...keys].filter((key) => arrivals.has(key)).length,
    neverArrived: [...keys].filter((key) => !arrivals.has(key)).length,
    resends: starts.length - keys.size,
    duplicates: sum([...arrivals.values()].map((count) => count - 1)),
    waitingAtEnd: end ? end.admitted - end.inProgress : 0,
  };
}

const DELIVERY_HEADERS = [
  'fetch calls (keepalive true / false)',
  'requests started',
  'arrived',
  'started, never arrived',
  'resends',
  'duplicate arrivals',
  'waiting at end of hide',
];

function deliveryColumns(trials: TrialResult[]): string[] {
  const all = trials.map(delivery);
  const total = (key: keyof Delivery) => sum(all.map((entry) => entry[key]));
  return [
    `${total('calls')} (${total('keepaliveCalls')} / ${total('calls') - total('keepaliveCalls')})`,
    String(total('requests')),
    String(total('arrived')),
    String(total('neverArrived')),
    String(total('resends')),
    String(total('duplicates')),
    String(total('waitingAtEnd')),
  ];
}

function keepaliveCounts(starts: StartEntry[]): string {
  const on = starts.filter(({ keepalive }) => keepalive).length;
  return `true ${on} / false ${starts.length - on}`;
}

function tally(values: unknown[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => `${value} ×${count}`).join(', ') || '-';
}

function range(values: Array<number | null | undefined>): string {
  const numbers = values.filter((value): value is number => typeof value === 'number');
  if (numbers.length === 0) {
    return '-';
  }
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return min === max ? String(min) : `${min}-${max}`;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function table(headers: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/** Trials of one scenario grouped by browser and variant. Observed trials only, unless `observed` is false. */
function groups(results: TrialResult[], scenario: string, observed = true): Array<[string, string, TrialResult[]]> {
  const byKey = new Map<string, TrialResult[]>();
  for (const result of results.filter(
    (candidate) => candidate.scenario === scenario && (candidate.observed !== false) === observed
  )) {
    const key = `${result.browserName}\u0000${result.variant}`;
    byKey.set(key, [...(byKey.get(key) ?? []), result]);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, trials]) => {
      const [browser = '', variant = ''] = key.split('\u0000');
      return [browser, variant, trials.sort((left, right) => left.trial - right.trial)];
    });
}

/** Whether `name` was recorded, and before `marker`. */
const before = (result: TrialResult, name: string, marker: string) => {
  const at = indexOf(result, name);
  return at !== -1 && at < indexOf(result, marker);
};
const afterPagehide = (result: TrialResult, entry: TimelineEntry) =>
  result.timeline.indexOf(entry) > indexOf(result, 'pagehide');

/** A, B and C: what happened to the failing request's span and event. */
function spanTable(results: TrialResult[], scenario: string): string {
  const rows = groups(results, scenario).map(([browser, variant, trials]) => {
    const spanStarts = trials.map((trial) => startsOf(trial).find(({ items }) => (items?.failSpans ?? 0) > 0));
    return [
      browser,
      variant,
      trials.length,
      tally(trials.map((trial) => find(trial, 'pagehide')?.['failSpan'])),
      trials.filter((trial) => before(trial, 'faro: fail span exported into Faro', 'pagehide')).length,
      trials.filter((trial) => before(trial, 'pagehide', 'faro: fail span exported into Faro')).length,
      ...deliveryColumns(trials),
      spanStarts.filter(Boolean).length,
      tally(spanStarts.filter(Boolean).map((start) => start!.keepalive)),
      trials.filter((trial) => trial.arrivals.some(({ items }) => (items?.failSpans ?? 0) > 0)).length,
      trials.filter((trial) => trial.arrivals.some(({ items }) => (items?.failFetchEvents ?? 0) > 0)).length,
    ];
  });
  return table(
    [
      'browser',
      'variant',
      'trials',
      'fail span at pagehide',
      'trials: span exported into Faro before pagehide',
      'exported after pagehide',
      ...DELIVERY_HEADERS,
      'trials: a request carrying the span started',
      'its keepalive',
      'trials: client span arrived',
      'trials: faro.tracing.fetch arrived',
    ],
    rows
  );
}

/** D: the unload flush with a body over the budget. */
function overBudgetTable(results: TrialResult[]): string {
  const rows = groups(results, 'D').map(([browser, variant, trials]) => {
    // The largest request that started after pagehide is the flush that carried the filler.
    const flushes = trials.map(
      (trial) =>
        startsOf(trial)
          .filter((start) => afterPagehide(trial, start))
          .sort((left, right) => (right.bodyBytes ?? 0) - (left.bodyBytes ?? 0))[0]
    );
    const flushArrivals = trials.map((trial, index) =>
      trial.arrivals.find(({ idempotencyKey }) => idempotencyKey === flushes[index]?.idempotencyKey)
    );
    const pushed = trials.map((trial) => Number(find(trial, 'app: pushed filler')?.['items'] ?? 0));
    const fillerArrived = trials.map((trial) =>
      sum(trial.arrivals.map(({ items }) => items?.logTags['D-filler'] ?? 0))
    );
    return [
      browser,
      variant,
      trials.length,
      trials.filter((trial) => before(trial, 'pagehide', 'app: pushed filler')).length,
      flushes.filter(Boolean).length,
      flushArrivals.filter(Boolean).length,
      tally(flushes.filter(Boolean).map((start) => start!.keepalive)),
      range([
        ...flushArrivals.map((arrival) => arrival?.decodedBytes),
        ...flushes.map((start) => (start?.contentEncoding ? null : start?.bodyBytes)),
      ]),
      range(flushes.map((start) => start?.bodyBytes)),
      `${sum(fillerArrived)} / ${sum(pushed)}`,
      ...deliveryColumns(trials),
    ];
  });
  return table(
    [
      'browser',
      'variant',
      'trials',
      'trials: filler queued in pagehide',
      'trials: unload flush started',
      'arrived',
      'its keepalive',
      'its body bytes (uncompressed)',
      'its body bytes (sent)',
      'filler logs arrived / pushed',
      ...DELIVERY_HEADERS,
    ],
    rows
  );
}

/** E: requests waiting behind the concurrency limit at pagehide. */
function queueTable(results: TrialResult[]): string {
  const rows = groups(results, 'E').map(([browser, variant, trials]) => {
    const atPagehide = trials.map((trial) => queueAt(trial, 'pagehide'));
    const batchKeys = trials.map(
      (trial) =>
        new Set(
          startsOf(trial)
            .filter(({ items }) => (items?.logTags['E-batch'] ?? 0) > 0)
            .map(({ idempotencyKey }) => idempotencyKey)
        )
    );
    const firstStartedAfterPagehide = trials.map(
      (trial) =>
        new Set(
          startsOf(trial)
            .filter((start) => afterPagehide(trial, start))
            .filter(
              (start) =>
                !startsOf(trial).some(
                  (other) => other.idempotencyKey === start.idempotencyKey && !afterPagehide(trial, other)
                )
            )
            .map(({ idempotencyKey }) => idempotencyKey)
        ).size
    );
    return [
      browser,
      variant,
      trials.length,
      sum(trials.map((trial) => Number(find(trial, 'app: generated flushes')?.['generated'] ?? 0))),
      sum(atPagehide.map((queue) => queue?.inProgress ?? 0)),
      sum(atPagehide.map((queue) => queue?.queued ?? 0)),
      sum(firstStartedAfterPagehide),
      sum(trials.map((trial, index) => [...batchKeys[index]!].filter((key) => arrivedKey(trial, key)).length)),
      ...deliveryColumns(trials),
    ];
  });
  return table(
    [
      'browser',
      'variant',
      'trials',
      'E flushes generated',
      'in flight at pagehide',
      'queued at pagehide',
      'new requests started after pagehide',
      'E requests arrived',
      ...DELIVERY_HEADERS,
    ],
    rows
  );
}

/** F: a flush from a pagehide listener registered before the transport, and one registered after. */
function orderTable(results: TrialResult[]): string {
  const rows = groups(results, 'F').flatMap(([browser, , trials]) =>
    (['F-before', 'F-after'] as const).map((tag) => {
      const marker = tag === 'F-before' ? 'F: listener before transport' : 'F: listener after transport';
      const flushes = trials.map((trial) => {
        const from = indexOf(trial, marker);
        return startsOf(trial).find(
          (start) => trial.timeline.indexOf(start) > from && (start.items?.logTags[tag] ?? 0) > 0
        );
      });
      return [
        browser,
        tag === 'F-before' ? 'registered before the transport' : 'registered after the transport',
        trials.length,
        trials.filter((trial) => indexOf(trial, marker) !== -1).length,
        flushes.filter(Boolean).length,
        trials.filter((trial, index) => arrivedKey(trial, flushes[index]?.idempotencyKey)).length,
        tally(flushes.filter(Boolean).map((start) => start!.keepalive)),
        tally(flushes.filter(Boolean).map((start) => start!.transportUnloading)),
        range(flushes.map((start) => start?.bodyBytes)),
      ];
    })
  );
  return table(
    [
      'browser',
      'pagehide listener',
      'trials',
      'listener ran',
      'its flush request started',
      'arrived',
      'keepalive',
      'transport unloading when it started',
      'body bytes',
    ],
    rows
  );
}

/** F: every collector request in the trial, for context. */
function orderDeliveryTable(results: TrialResult[]): string {
  return table(
    ['browser', 'trials', ...DELIVERY_HEADERS],
    groups(results, 'F').map(([browser, , trials]) => [browser, trials.length, ...deliveryColumns(trials)])
  );
}

/** G: body sizes and in-flight totals in a usage flow. */
function sizeTable(results: TrialResult[]): string {
  const rows = groups(results, 'G').map(([browser, variant, trials]) => {
    const sizes: number[] = [];
    const inFlightTotals: number[] = [];
    for (const trial of trials) {
      const starts = startsOf(trial);
      const settledAt = new Map(
        trial.timeline.filter(({ name }) => name === 'fetch:settled').map((entry) => [entry['id'], entry.atMs])
      );
      for (const start of starts) {
        sizes.push(start.bodyBytes ?? 0);
        inFlightTotals.push(
          sum(
            starts
              .filter((other) => other.atMs <= start.atMs && (settledAt.get(other.id) ?? Infinity) > start.atMs)
              .map((other) => other.bodyBytes ?? 0)
          )
        );
      }
    }
    const sorted = [...sizes].sort((left, right) => left - right);
    return [
      browser,
      variant,
      trials.length,
      `${sorted[0] ?? 0} / ${percentile(sorted, 0.5)} / ${percentile(sorted, 0.9)} / ${sorted.at(-1) ?? 0}`,
      `${sizes.filter((size) => size > BUDGET).length} of ${sizes.length}`,
      `${inFlightTotals.filter((total) => total > BUDGET).length} of ${inFlightTotals.length}`,
      Math.max(0, ...inFlightTotals),
      `${sum(trials.map((trial) => trial.timeline.filter(({ name }) => name === 'otel: fail span started').length))} / ${sum(
        trials.map((trial) => sum(trial.arrivals.map(({ items }) => items?.failSpans ?? 0)))
      )} / ${sum(trials.map((trial) => sum(trial.arrivals.map(({ items }) => items?.failFetchEvents ?? 0))))}`,
      ...deliveryColumns(trials),
    ];
  });
  return table(
    [
      'browser',
      'variant',
      'trials',
      'body bytes per fetch call min / p50 / p90 / max',
      'bodies over 60,000',
      'calls whose in-flight total (incl. itself) is over 60,000',
      'max in-flight total',
      'failing-request spans created / spans arrived / faro.tracing.fetch arrived',
      ...DELIVERY_HEADERS,
    ],
    rows
  );
}

function stats(values: Array<number | null | undefined>): string {
  const sorted = values.filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) {
    return '-';
  }
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return `${sorted[0]!.toFixed(0)} / ${median.toFixed(0)} / ${sorted.at(-1)!.toFixed(0)}`;
}

const spanArrived = (trial: TrialResult) => trial.arrivals.some(({ items }) => (items?.failSpans ?? 0) > 0);
const eventArrived = (trial: TrialResult) => trial.arrivals.some(({ items }) => (items?.failFetchEvents ?? 0) > 0);

/** Trials whose page console printed `needle`, and how many times in total. */
function consoleCount(trials: TrialResult[], needle: string): string {
  const per = trials.map((trial) => (trial.console ?? []).filter(({ text }) => text.includes(needle)).length);
  return `${per.filter((count) => count > 0).length} trials (${sum(per)} messages)`;
}

/** A: how long before pagehide the response body had been read, by OpenTelemetry and by the app. */
function pendingTable(results: TrialResult[]): string {
  const rows = groups(results, 'A').map(([browser, variant, trials]) => {
    const since = (name: string) =>
      trials.map((trial) => {
        const at = find(trial, name)?.atMs;
        const pagehide = find(trial, 'pagehide')?.atMs;
        return at !== undefined && pagehide !== undefined && before(trial, name, 'pagehide') ? pagehide - at : null;
      });
    return [
      browser,
      variant,
      trials.length,
      tally(trials.map((trial) => find(trial, 'pagehide')?.['failSpan'])),
      trials.filter((trial) => before(trial, 'otel: fail span body read, end scheduled', 'pagehide')).length,
      stats(since('otel: fail span body read, end scheduled')),
      stats(since('app: body read')),
      stats(since('app: response')),
      trials.filter(spanArrived).length,
      trials.filter(eventArrived).length,
    ];
  });
  return table(
    [
      'browser',
      'variant',
      'trials',
      'fail span at pagehide',
      'trials: OpenTelemetry had read the body before pagehide',
      'ms from OpenTelemetry body read to pagehide (min / median / max)',
      'ms from app body read to pagehide',
      'ms from response headers to pagehide',
      'trials: client span arrived',
      'trials: faro.tracing.fetch arrived',
    ],
    rows
  );
}

/** C: the span's request competes with a keepalive filler still in flight. */
function competeTable(results: TrialResult[]): string {
  const rows = groups(results, 'C').map(([browser, variant, trials]) => {
    const parts = trials.map((trial) => {
      const starts = startsOf(trial);
      const span = starts.find(({ items }) => (items?.failSpans ?? 0) > 0);
      const filler = starts.find(({ items }) => (items?.logTags['C-filler'] ?? 0) > 0);
      const fillerSettled = trial.timeline.find(({ name, id }) => name === 'fetch:settled' && id === filler?.id);
      const fillerInFlight =
        filler !== undefined &&
        span !== undefined &&
        trial.timeline.indexOf(filler) < trial.timeline.indexOf(span) &&
        (fillerSettled === undefined || trial.timeline.indexOf(fillerSettled) > trial.timeline.indexOf(span));
      const left = filler?.keepalive && fillerInFlight ? BUDGET - (filler.bodyBytes ?? 0) : null;
      return { span, filler, left, met: left !== null && span !== undefined && left < (span.bodyBytes ?? 0) };
    });
    return [
      browser,
      variant,
      trials.length,
      parts.filter(({ met }) => met).length,
      `${parts.filter(({ filler }) => filler).length} / ${trials.filter((trial, index) => arrivedKey(trial, parts[index]!.filler?.idempotencyKey)).length}`,
      tally(parts.filter(({ filler }) => filler).map(({ filler }) => filler!.keepalive)),
      range(parts.map(({ filler }) => filler?.bodyBytes)),
      range(parts.map(({ left }) => left)),
      `${parts.filter(({ span }) => span).length} / ${trials.filter((trial, index) => arrivedKey(trial, parts[index]!.span?.idempotencyKey)).length}`,
      tally(parts.filter(({ span }) => span).map(({ span }) => span!.keepalive)),
      range(parts.map(({ span }) => span?.bodyBytes)),
      trials.filter(spanArrived).length,
      trials.filter(eventArrived).length,
      ...deliveryColumns(trials),
    ];
  });
  return table(
    [
      'browser',
      'variant',
      'trials',
      'trials: budget left < span request (precondition)',
      'filler started / arrived',
      'filler keepalive',
      'filler bytes',
      'budget left when span request started',
      'span request started / arrived',
      'span request keepalive',
      'span request bytes',
      'trials: client span arrived',
      'trials: faro.tracing.fetch arrived',
      ...DELIVERY_HEADERS,
    ],
    rows
  );
}

/** Trials run without observers: the collector is the only record. */
function unobservedTable(results: TrialResult[]): string {
  const rows = ['A', 'E'].flatMap((scenario) =>
    groups(results, scenario, false).map(([browser, variant, trials]) => {
      const perTrial = trials.map((trial) => {
        const counts = new Map<string | null, number>();
        for (const { idempotencyKey } of trial.arrivals) {
          counts.set(idempotencyKey, (counts.get(idempotencyKey) ?? 0) + 1);
        }
        return { keys: counts.size, duplicates: sum([...counts.values()].map((count) => count - 1)) };
      });
      return [
        browser,
        `${scenario} ${variant}`,
        trials.length,
        sum(trials.map((trial) => trial.arrivals.length)),
        sum(perTrial.map(({ keys }) => keys)),
        sum(perTrial.map(({ duplicates }) => duplicates)),
        perTrial.filter(({ duplicates }) => duplicates > 0).length,
        trials.filter(spanArrived).length,
        trials.filter(eventArrived).length,
        scenario === 'E'
          ? sum(
              trials.map((trial) => trial.arrivals.filter(({ items }) => (items?.logTags['E-batch'] ?? 0) > 0).length)
            )
          : '-',
      ];
    })
  );
  return table(
    [
      'browser',
      'scenario',
      'trials',
      'arrivals',
      'distinct Idempotency-Keys',
      'duplicate arrivals',
      'trials with a duplicate',
      'trials: client span arrived',
      'trials: faro.tracing.fetch arrived',
      'arrivals carrying E batches',
    ],
    rows
  );
}

/** M: keepalive fetches from a page without Faro, and how each promise settled. */
function minimalTable(results: TrialResult[]): string {
  const rows = groups(results, 'M', false).map(([browser, variant, trials]) => {
    const beacons = trials.flatMap((trial) => trial.side?.beacons ?? []);
    const outcome = (detail: unknown) => {
      const { outcome: kind, error, status } = (detail ?? {}) as { outcome?: string; error?: string; status?: number };
      return kind === 'rejected' ? `rejected ${error}` : `${kind} ${status}`;
    };
    return [
      browser,
      variant,
      trials.length,
      `${sum(trials.map((trial) => trial.side?.held.length ?? 0))} / ${trials.length * 5}`,
      tally(beacons.map(({ detail }) => outcome(detail))),
      trials.length * 5 - beacons.length,
    ];
  });
  return table(
    ['browser', 'collector', 'trials', 'fetches arrived / sent', 'beacons by outcome', 'promises with no beacon'],
    rows
  );
}

/** R: what replay sends through the fetch transport. */
function replayTable(results: TrialResult[]): string {
  const replayEvents = (summary: { eventNames: Record<string, number> } | null | undefined) =>
    summary?.eventNames['faro.session_recording.event'] ?? 0;
  const rows = groups(results, 'R').map(([browser, variant, trials]) => {
    const starts = trials.flatMap(startsOf);
    const withReplay = starts.filter(({ items }) => replayEvents(items) > 0);
    const unload = trials.flatMap((trial) => startsOf(trial).filter((start) => afterPagehide(trial, start)));
    const sorted = withReplay.map(({ bodyBytes }) => bodyBytes ?? 0).sort((a, b) => a - b);
    return [
      browser,
      variant,
      trials.length,
      starts.length,
      `${withReplay.length}: ${sorted[0] ?? 0} / ${percentile(sorted, 0.5)} / ${sorted.at(-1) ?? 0}`,
      `${starts.filter(({ bodyBytes }) => (bodyBytes ?? 0) > BUDGET).length} of ${starts.length}`,
      keepaliveCounts(starts),
      `${unload.length}: ${range(unload.map(({ bodyBytes }) => bodyBytes))}, ${keepaliveCounts(unload)}, arrived ${trials
        .map(
          (trial) =>
            startsOf(trial).filter((start) => afterPagehide(trial, start) && arrivedKey(trial, start.idempotencyKey))
              .length
        )
        .reduce((a, b) => a + b, 0)}`,
      `${sum(starts.map(({ items }) => replayEvents(items)))} / ${sum(
        trials.flatMap((trial) => trial.arrivals.map(({ items }) => replayEvents(items)))
      )}`,
      ...deliveryColumns(trials),
    ];
  });
  return table(
    [
      'browser',
      'variant',
      'trials',
      'fetch calls',
      'calls carrying replay events: count: bytes min / p50 / max',
      'bodies over 60,000',
      'keepalive (all calls)',
      'calls after pagehide: count: bytes, keepalive, arrived',
      'replay events sent / arrived',
      ...DELIVERY_HEADERS,
    ],
    rows
  );
}

/** Metrics for the baseline-against-fix comparison. */
const COMPARE: Record<string, Array<[string, (trials: TrialResult[]) => string]>> = {
  B: [
    ['client span arrived', (trials) => `${trials.filter(spanArrived).length}/${trials.length}`],
    ['faro.tracing.fetch arrived', (trials) => `${trials.filter(eventArrived).length}/${trials.length}`],
    [
      'span request keepalive',
      (trials) =>
        tally(
          trials.map(
            (trial) => startsOf(trial).find(({ items }) => (items?.failSpans ?? 0) > 0)?.keepalive ?? 'not sent'
          )
        ),
    ],
    [
      'requests started / arrived',
      (trials) => `${sum(trials.map((t) => delivery(t).requests))} / ${sum(trials.map((t) => delivery(t).arrived))}`,
    ],
    ['duplicate arrivals', (trials) => String(sum(trials.map((t) => delivery(t).duplicates)))],
  ],
  G: [
    [
      'failing spans created / arrived',
      (trials) =>
        `${sum(trials.map((t) => t.timeline.filter(({ name }) => name === 'otel: fail span started').length))} / ${sum(
          trials.map((t) => sum(t.arrivals.map(({ items }) => items?.failSpans ?? 0)))
        )}`,
    ],
    [
      'all spans arrived',
      (trials) => String(sum(trials.map((t) => sum(t.arrivals.map(({ items }) => items?.counts['spans'] ?? 0))))),
    ],
    [
      'faro.tracing.fetch events arrived',
      (trials) =>
        String(
          sum(trials.map((t) => sum(t.arrivals.map(({ items }) => items?.eventNames['faro.tracing.fetch'] ?? 0))))
        ),
    ],
    [
      'requests started / arrived',
      (trials) => `${sum(trials.map((t) => delivery(t).requests))} / ${sum(trials.map((t) => delivery(t).arrived))}`,
    ],
    [
      'keepalive false calls',
      (trials) => String(sum(trials.map((t) => delivery(t).calls - delivery(t).keepaliveCalls))),
    ],
    ['duplicate arrivals', (trials) => String(sum(trials.map((t) => delivery(t).duplicates)))],
  ],
  D: [
    [
      'filler logs arrived / pushed',
      (trials) =>
        `${sum(trials.map((t) => sum(t.arrivals.map(({ items }) => items?.logTags['D-filler'] ?? 0))))} / ${sum(
          trials.map((t) => Number(find(t, 'app: pushed filler')?.['items'] ?? 0))
        )}`,
    ],
    [
      'requests started / arrived',
      (trials) => `${sum(trials.map((t) => delivery(t).requests))} / ${sum(trials.map((t) => delivery(t).arrived))}`,
    ],
    ['keepalive (all calls)', (trials) => keepaliveCounts(trials.flatMap(startsOf))],
    ['"Permanent delivery failure" in console', (trials) => consoleCount(trials, 'Permanent delivery failure')],
    ['duplicate arrivals', (trials) => String(sum(trials.map((t) => delivery(t).duplicates)))],
  ],
  E: [
    [
      'in flight / queued at pagehide',
      (trials) =>
        `${sum(trials.map((t) => queueAt(t, 'pagehide')?.inProgress ?? 0))} / ${sum(trials.map((t) => queueAt(t, 'pagehide')?.queued ?? 0))}`,
    ],
    ['waiting at end of hide', (trials) => String(sum(trials.map((t) => delivery(t).waitingAtEnd)))],
    [
      'E batches arrived',
      (trials) =>
        String(
          sum(
            trials.map(
              (t) =>
                new Set(
                  t.arrivals
                    .filter(({ items }) => (items?.logTags['E-batch'] ?? 0) > 0)
                    .map(({ idempotencyKey }) => idempotencyKey)
                ).size
            )
          )
        ),
    ],
    ['resends', (trials) => String(sum(trials.map((t) => delivery(t).resends)))],
    ['duplicate arrivals', (trials) => String(sum(trials.map((t) => delivery(t).duplicates)))],
  ],
};

function comparison(other: TrialResult[], current: TrialResult[], otherLabel: string, currentLabel: string): string {
  const sections: string[] = [`# ${otherLabel} against ${currentLabel}`];
  for (const [scenario, metrics] of Object.entries(COMPARE)) {
    const left = new Map(
      groups(other, scenario).map(([browser, variant, trials]) => [`${browser}|${variant}`, trials])
    );
    const right = new Map(
      groups(current, scenario).map(([browser, variant, trials]) => [`${browser}|${variant}`, trials])
    );
    const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
    if (keys.length === 0) {
      continue;
    }
    sections.push(
      `\n## ${scenario}\n`,
      table(
        [
          'browser',
          'variant',
          ...metrics.flatMap(([label]) => [`${label}: ${otherLabel}`, `${label}: ${currentLabel}`]),
        ],
        keys.map((key) => {
          const [browser = '', variant = ''] = key.split('|');
          return [
            browser,
            variant,
            ...metrics.flatMap(([, metric]) => [
              left.has(key) ? metric(left.get(key)!) : '-',
              right.has(key) ? metric(right.get(key)!) : '-',
            ]),
          ];
        })
      )
    );
  }
  return sections.join('\n');
}

function render(results: TrialResult[], problems: string[]): string {
  const versions = [...new Set(results.map(({ browserName, browserVersion }) => `${browserName} ${browserVersion}`))]
    .sort()
    .join(', ');
  const persisted = results.filter((result) => find(result, 'pagehide')?.['persisted'] === true).length;
  const has = (scenario: string, observed = true) =>
    results.some((result) => result.scenario === scenario && (result.observed !== false) === observed);
  const sections: Array<[boolean, string, string[]]> = [
    [has('A'), 'A. Pending span', [spanTable(results, 'A'), '', pendingTable(results)]],
    [has('B'), 'B. Ended span', [spanTable(results, 'B')]],
    [has('C'), 'C. Budget competition', [competeTable(results)]],
    [
      has('D'),
      'D. Over budget',
      [
        overBudgetTable(results),
        '',
        table(
          ['browser', 'variant', 'trials', '"Permanent delivery failure" in page console'],
          groups(results, 'D').map(([browser, variant, trials]) => [
            browser,
            variant,
            trials.length,
            consoleCount(trials, 'Permanent delivery failure'),
          ])
        ),
      ],
    ],
    [has('E'), 'E. Queue concurrency', [queueTable(results)]],
    [has('A', false) || has('E', false), 'Without observers (collector only)', [unobservedTable(results)]],
    [has('F'), 'F. Listener order', [orderTable(results), '', orderDeliveryTable(results)]],
    [has('G'), 'G. Realistic sizes', [sizeTable(results)]],
    [has('M', false), 'M. Keepalive fetches without Faro', [minimalTable(results)]],
    [has('R'), 'R. Replay payload sizes', [replayTable(results)]],
  ];
  return [
    '# Page-unload delivery',
    '',
    `Browsers: ${versions}. Trials: ${results.length}. pagehide with persisted=true: ${persisted}.`,
    problems.length ? `\nHarness problems:\n${problems.map((problem) => `- ${problem}`).join('\n')}` : '',
    ...sections.filter(([present]) => present).flatMap(([, title, parts]) => [`\n## ${title}\n`, ...parts]),
    '',
  ].join('\n');
}

export default class PagehideDeliveryReporter implements Reporter {
  private readonly results: TrialResult[] = [];
  private readonly problems: string[] = [];
  private outputDir = '.';

  onBegin(config: FullConfig): void {
    this.outputDir = config.projects[0]?.outputDir ?? '.';
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find(({ name }) => name === 'pd-result');
    if (attachment?.body) {
      this.results.push(JSON.parse(attachment.body.toString('utf8')) as TrialResult);
    }
    if (result.status !== 'passed') {
      const project = test.parent.project()?.name ?? '?';
      this.problems.push(`${project} ${test.title}: ${result.status} ${result.error?.message?.split('\n')[0] ?? ''}`);
    }
  }

  onEnd(): void {
    let summary = render(this.results, this.problems);
    const comparePath = process.env['PD_COMPARE'];
    if (comparePath) {
      const other = JSON.parse(readFileSync(comparePath, 'utf8')) as TrialResult[];
      summary += `\n${comparison(other, this.results, process.env['PD_COMPARE_LABEL'] ?? 'other', process.env['PD_LABEL'] ?? 'this run')}\n`;
    }
    mkdirSync(this.outputDir, { recursive: true });
    writeFileSync(join(this.outputDir, 'summary.md'), summary);
    writeFileSync(join(this.outputDir, 'results.json'), JSON.stringify(this.results));
    console.log(`\n${summary}\nWrote ${join(this.outputDir, 'summary.md')} and results.json`);
  }
}
