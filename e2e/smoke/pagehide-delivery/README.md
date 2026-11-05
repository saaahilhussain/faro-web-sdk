# Page-unload delivery harness

Measures what Faro delivers when a page navigates away (issues #2315 and #2365). Each Playwright test is one trial: open
a test page in a fresh browser context, wait for the first batch to reach the collector, start a scenario, let the page
navigate itself to a same-origin landing page, then wait 3 seconds for requests to arrive.

The folder is self-contained and is not part of `yarn e2e`. It runs its own Node server (`server.ts`) with a collector
that records every request, and needs only the built bundles from `yarn build` and `@playwright/test` from `e2e/smoke`.

## Setup

From the repository root:

```sh
yarn install && yarn build
cd e2e/smoke
yarn playwright install chromium webkit firefox
```

The pages load `faro-web-sdk`, `faro-web-tracing` and `faro-instrumentation-replay` from `dist/bundle` in `packages/`
and `experimental/`, so run `yarn build` again after changing the SDK. `server.ts` runs with plain `node`, which strips
its types, so use the repository's Node version (`.nvmrc`).

## Running

From `e2e/smoke`. The commands set environment variables the POSIX shell way (bash, zsh, Git Bash on Windows).

```sh
# Every scenario, 10 trials each, in Chromium, WebKit and Firefox
yarn playwright test -c pagehide-delivery/playwright.config.ts

# Some scenarios
PD_SCENARIOS="D,C,R" yarn playwright test -c pagehide-delivery/playwright.config.ts

# One variant, one trial, one browser
PD_SCENARIOS="D:gzip" PD_TRIALS=1 yarn playwright test -c pagehide-delivery/playwright.config.ts --project webkit
```

To compare two builds, give each run its own output folder and point the second run at the first one's results:

```sh
PD_OUT=pd-baseline yarn playwright test -c pagehide-delivery/playwright.config.ts
# Change the SDK and run yarn build from the repository root, then:
PD_OUT=pd-fix PD_COMPARE=test-results/pd-baseline/results.json PD_COMPARE_LABEL=baseline PD_LABEL=fix \
  yarn playwright test -c pagehide-delivery/playwright.config.ts
```

## Reading the results

The tests only check that each trial ran: the page reached the landing page and, when observed, recorded its own
`pagehide`. They do not check what was delivered, so a passing run says nothing about delivery. Read the results from
the tables that `reporter.ts` prints at the end of the run, one per scenario, with counts summed over trials. The same
tables go to `summary.md`, next to `results.json` with every trial's timeline and arrivals, in
`e2e/smoke/test-results/<PD_OUT>/`. Trials that failed are listed under "Harness problems" at the top.

The keepalive budget in the tables is 60,000 bytes. Headless local runs against a collector on the same machine are not
field loss rates.

## Settings

| Variable            | Default             | Effect                                                                                       |
| ------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `PD_TRIALS`         | `10`                | Trials per variant and browser.                                                              |
| `PD_SCENARIOS`      | all                 | Comma list of scenarios (`D`) or single variants (`D:gzip`).                                 |
| `PD_C_FILLER_BYTES` | `56000`             | Size of scenario C's keepalive filler.                                                       |
| `PD_WORKERS`        | `4`                 | Playwright workers.                                                                          |
| `PD_PORT`           | `5180`              | Port for `server.ts`.                                                                        |
| `PD_OUT`            | `pagehide-delivery` | Output folder under `e2e/smoke/test-results`, so runs do not overwrite each other.           |
| `PD_COMPARE`        | none                | A `results.json` from another run. The reporter adds a side-by-side table for B, D, E and G. |
| `PD_COMPARE_LABEL`  | `other`             | Column label for the `PD_COMPARE` run.                                                       |
| `PD_LABEL`          | `this run`          | Column label for the current run.                                                            |

## Scenarios

| Scenario                  | Variants                                            | What it does                                                                                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Pending span           | `0ms`, `100ms`, `read`, `noread`, `0ms-unobserved`  | The page fetches a failing endpoint and navigates inside OpenTelemetry's 300 ms span-end delay: straight after the response (`0ms`, `noread`), 100 ms later (`100ms`), or after reading the body (`read`).                                                                      |
| B. Ended span             | `ended`                                             | Navigates as soon as the failing request's span has ended, long before the 1,000 ms batch export.                                                                                                                                                                               |
| C. Budget competition     | `compete`                                           | A keepalive log filler queued in `pagehide` is still in flight when the span's request starts, so the span competes for what is left of the budget. Needs a build with the #2315 fix: without it the span is never sent.                                                        |
| D. Over budget            | `plain`, `gzip`                                     | 68,000 bytes of logs queued in `pagehide`, so Faro's unload flush sends one body over the budget. `gzip` turns on `requestCompression`. Also counts "Permanent delivery failure" console messages.                                                                              |
| E. Queue concurrency      | `queue`, `queue-unobserved`, `delay100`, `delay500` | 11 flushes, more than the default concurrency of 5. `queue` holds every collector response for 5 s, so the rest wait in the queue at unload. `delay100` and `delay500` delay each response by 100 or 500 ms.                                                                    |
| F. Listener order         | `order`                                             | One flush from a `pagehide` listener registered before the transport, and one from a listener registered after it.                                                                                                                                                              |
| G. Realistic sizes        | `flow`                                              | An ordinary visit (fetches, a history change, console warnings and errors, an unhandled error), then navigation. Body sizes and in-flight totals against the budget.                                                                                                            |
| M. Keepalive without Faro | `hold`, `hold-signal`, `hold-listener`, `nohold`    | A page without Faro sends five keepalive POSTs and navigates while the server holds them (`nohold` answers at once). Each promise reports how it settled with `sendBeacon`. `hold-signal` adds an `AbortSignal` and `hold-listener` an empty `pagehide` listener, as Faro does. |
| R. Replay payload sizes   | `replay`                                            | Session replay records changes to a 300-row table, then the page navigates. Sizes of the requests that carry replay events.                                                                                                                                                     |

The `-unobserved` variants and all of M run without the page's observers (timeline, fetch wrapper, private queue reads).
Their only record is the collector, plus Playwright's console capture.

## Control scripts

`controls/` holds two plain Node scripts that check the console capture that scenario D's tables rely on. They are not
Playwright tests and the config does not run them.

- `console-control.mjs`: in each browser, whether Faro prints "Permanent delivery failure" for a 404 from the collector
  while the page is alive, and whether Playwright captures console messages written during unload. It serves its own
  pages through Playwright routing and reads the built `faro-web-sdk` bundle directly.
- `d-webkit-console.mjs`: in WebKit, scenario D plain, whether Faro calls `console.error` with "Permanent delivery
  failure" during unload and whether Playwright captures it. Takes the server's URL and a trial count (default 10).

After the setup above, start the server first, then run the scripts from a second terminal. `d-webkit-console.mjs`
loads its pages from the server. `console-control.mjs` does not use it.

```sh
cd e2e/smoke/pagehide-delivery
node server.ts # listens on http://127.0.0.1:5180, or PD_PORT

# In a second terminal, from e2e/smoke/pagehide-delivery:
node controls/d-webkit-console.mjs http://127.0.0.1:5180 10
node controls/console-control.mjs
```
