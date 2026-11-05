import { defineConfig } from '@playwright/test';

/**
 * Page-unload delivery measurements. Separate from the smoke suite: its own server, its own output,
 * and it is never part of `yarn e2e`. See pagehide-delivery.spec.ts.
 *
 * PD_OUT names the output folder under e2e/smoke/test-results, so runs do not overwrite each other.
 * PD_COMPARE is a results.json from another run; the reporter then prints the two side by side.
 */
const PORT = Number(process.env['PD_PORT'] ?? 5180);

export default defineConfig({
  testDir: '.',
  testMatch: 'pagehide-delivery.spec.ts',
  outputDir: `../test-results/${process.env['PD_OUT'] ?? 'pagehide-delivery'}`,
  timeout: 60_000,
  retries: 0,
  fullyParallel: true,
  workers: Number(process.env['PD_WORKERS'] ?? 4),
  reporter: [['dot'], ['./reporter.ts']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  webServer: {
    command: 'node server.ts',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    env: { PD_PORT: String(PORT) },
  },
});
