/**
 * Measures what Faro delivers when a page navigates away (issues #2315 and #2365). Measurement only:
 * the specs assert that each trial ran, not what it delivered. reporter.ts turns the attached results
 * into tables.
 *
 * Each test is one trial: open the page with a fresh browser context, wait until the first batch has
 * reached the collector plus a quiet period, start the scenario, let the page navigate itself to a
 * same-origin landing page, then wait a fixed settle window for requests to arrive. "Started" comes from
 * the page's pass-through fetch wrapper. "Arrived" comes from the collector in server.ts. Page console
 * messages are captured through Playwright in every trial.
 *
 * Variants marked `observe: false` run the page without any observer (see early.js). Their only record
 * is the collector, plus Playwright's console capture, which does not touch the page.
 *
 * Environment: PD_TRIALS (default 10), PD_SCENARIOS (comma list of `X` or `X:variant`, default all),
 * PD_C_FILLER_BYTES (scenario C's filler, default below).
 *
 * Headless local runs against a collector on the same machine are not field loss rates.
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import type { Arrival, ConsoleEntry, SideRecords, TimelineEntry, TrialResult } from './types';

const TRIALS = Number(process.env['PD_TRIALS'] ?? 10);
/** After the first collector request, before the scenario starts. */
const QUIET_MS = 1_000;
/** After the landing page loads, before reading what arrived. */
const SETTLE_MS = 3_000;
/**
 * Scenario C's filler. Sized from scenario B's measured span request on the fix build, so that the
 * budget left after the filler is smaller than the span's request. See the report for the numbers.
 */
const C_FILLER_BYTES = Number(process.env['PD_C_FILLER_BYTES'] ?? 56_000);

interface Scenario {
  scenario: string;
  /** Label in results and tables. */
  variant: string;
  /** Variant the page runs, when it differs from the label. */
  appVariant?: string;
  /** Collector delay for every response in the trial, in ms. */
  holdMs?: number;
  observe?: boolean;
  page?: 'app' | 'minimal' | 'replay';
}

const SCENARIOS: Scenario[] = [
  { scenario: 'A', variant: '0ms' },
  { scenario: 'A', variant: '100ms' },
  { scenario: 'A', variant: 'read' },
  { scenario: 'A', variant: 'noread' },
  { scenario: 'A', variant: '0ms-unobserved', appVariant: '0ms', observe: false },
  { scenario: 'B', variant: 'ended' },
  { scenario: 'C', variant: 'compete' },
  { scenario: 'D', variant: 'plain' },
  { scenario: 'D', variant: 'gzip' },
  { scenario: 'E', variant: 'queue', holdMs: 5_000 },
  { scenario: 'E', variant: 'queue-unobserved', appVariant: 'queue', holdMs: 5_000, observe: false },
  { scenario: 'E', variant: 'delay100', holdMs: 100 },
  { scenario: 'E', variant: 'delay500', holdMs: 500 },
  { scenario: 'F', variant: 'order' },
  { scenario: 'G', variant: 'flow' },
  { scenario: 'M', variant: 'hold', holdMs: 5_000, observe: false, page: 'minimal' },
  { scenario: 'M', variant: 'hold-signal', holdMs: 5_000, observe: false, page: 'minimal' },
  { scenario: 'M', variant: 'hold-listener', holdMs: 5_000, observe: false, page: 'minimal' },
  { scenario: 'M', variant: 'nohold', observe: false, page: 'minimal' },
  { scenario: 'R', variant: 'replay', page: 'replay' },
];

function selected({ scenario, variant }: Scenario): boolean {
  const filter = process.env['PD_SCENARIOS'];
  if (!filter) {
    return true;
  }
  return filter
    .split(',')
    .map((entry) => entry.trim())
    .some((entry) => entry === scenario || entry === `${scenario}:${variant}`);
}

interface PageGlobals {
  pd: { start: () => void };
  pdState: { started: number };
  pdMinimal: { start: () => void; navigate: () => void };
}

/** Scenario G: an ordinary visit, ending with the page navigating itself. */
async function usageFlow(page: Page): Promise<void> {
  await page.click('#load');
  await page.waitForTimeout(600);
  await page.click('#details');
  await page.waitForTimeout(300);
  await page.click('#warn');
  await page.waitForTimeout(300);
  await page.click('#error');
  await page.waitForTimeout(500);
  await page.click('#load');
  await page.waitForTimeout(400);
  await page.click('#next');
}

/** Scenario R: changes to a large DOM while replay records, then the page navigates itself. */
async function replayFlow(page: Page): Promise<void> {
  await page.click('#toggle');
  await page.waitForTimeout(300);
  await page.fill('#search', 'ORD-1002');
  await page.waitForTimeout(300);
  await page.click('#shuffle');
  await page.waitForTimeout(300);
  await page.click('#load');
  await page.waitForTimeout(500);
  await page.click('#toggle');
  await page.waitForTimeout(200);
  await page.click('#shuffle');
  await page.waitForTimeout(200);
  await page.click('#next');
}

async function arrivals(request: APIRequestContext, run: string): Promise<Arrival[]> {
  return (await (await request.get(`/pd/collected/${run}`)).json()) as Arrival[];
}

async function sideRecords(request: APIRequestContext, run: string): Promise<SideRecords> {
  return (await (await request.get(`/pd/side/${run}`)).json()) as SideRecords;
}

test.describe.configure({ mode: 'parallel' });

for (const definition of SCENARIOS.filter(selected)) {
  const { scenario, variant, holdMs = 0, observe = true, page: pageName = 'app' } = definition;
  for (let trial = 1; trial <= TRIALS; trial++) {
    test(`${scenario} ${variant} #${trial}`, async ({ page, request, browser, browserName }, testInfo) => {
      const run = `${scenario}${variant.replaceAll('-', '')}_${randomUUID().replaceAll('-', '')}`;
      if (holdMs > 0) {
        expect((await request.post(`/pd/config/${run}`, { data: { holdMs } })).status()).toBe(204);
      }
      const consoleMessages: ConsoleEntry[] = [];
      page.on('console', (message) =>
        consoleMessages.push({ atMs: Date.now(), type: message.type(), text: message.text() })
      );

      const query = new URLSearchParams({ run, scenario, variant: definition.appVariant ?? variant });
      if (!observe) {
        query.set('observe', '0');
      }
      if (scenario === 'C') {
        query.set('fillerBytes', String(C_FILLER_BYTES));
      }
      await page.goto(`/pd/${pageName}.html?${query}`);

      const landed = page.waitForURL('**/pd/landed.html**', { timeout: 20_000 });
      if (pageName === 'minimal') {
        await page.evaluate(() => (window as unknown as PageGlobals).pdMinimal.start());
        await expect.poll(async () => (await sideRecords(request, run)).held.length).toBe(5);
        await page.evaluate(() => (window as unknown as PageGlobals).pdMinimal.navigate());
      } else {
        if (observe) {
          await page.waitForFunction(() => (window as unknown as PageGlobals).pdState.started >= 1);
        } else {
          await expect.poll(async () => (await arrivals(request, run)).length).toBeGreaterThan(0);
        }
        await page.waitForTimeout(QUIET_MS);
        if (scenario === 'G') {
          await usageFlow(page);
        } else if (scenario === 'R') {
          await replayFlow(page);
        } else {
          await page.evaluate(() => (window as unknown as PageGlobals).pd.start());
        }
      }
      await landed;
      await page.waitForTimeout(SETTLE_MS + holdMs);

      const result: TrialResult = {
        scenario,
        variant,
        trial,
        browserName,
        browserVersion: browser.version(),
        run,
        observed: observe,
        holdMs,
        settleMs: SETTLE_MS + holdMs,
        timeline: observe
          ? await page.evaluate(
              (key) => JSON.parse(window.sessionStorage.getItem(key) ?? '[]') as TimelineEntry[],
              `pd:${run}`
            )
          : [],
        arrivals: await arrivals(request, run),
        console: consoleMessages,
        ...(pageName === 'minimal' && { side: await sideRecords(request, run) }),
      };
      if (observe) {
        expect(
          result.timeline.some(({ name }) => name === 'pagehide'),
          'the page recorded its own pagehide'
        ).toBe(true);
      }
      await testInfo.attach('pd-result', { body: JSON.stringify(result), contentType: 'application/json' });
    });
  }
}
