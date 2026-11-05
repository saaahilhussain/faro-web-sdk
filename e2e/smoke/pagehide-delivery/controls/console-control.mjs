// Control for the D console capture, per browser:
//  (a) Does Faro print "Permanent delivery failure" at the default log level, and does Playwright
//      capture it, while the page is alive? The collector answers 404 (not retryable).
//  (b) Does Playwright capture console messages written while the page unloads: one from a pagehide
//      listener, one from the rejection handler of a keepalive:false fetch that is in flight?
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Paths are relative to this file: controls/ -> e2e/smoke for Playwright, the repository root for the bundle.
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium, webkit, firefox } = require('@playwright/test');
const bundle = (name) => readFileSync(new URL(`../../../../packages/${name}/dist/bundle/faro-${name}.iife.js`, import.meta.url), 'utf8');
const sdk = bundle('web-sdk');

const pageA = `<!doctype html><script>${sdk}</script><script>
  GrafanaFaroWebSdk.initializeFaro({ url: '/collect404', app: { name: 'control' }, instrumentations: [] });
  GrafanaFaroWebSdk.faro.api.pushLog(['hello']);
</script>`;
const pageB = `<!doctype html><script>
  window.addEventListener('pagehide', () => console.error('control: from pagehide'));
  window.go = () => {
    fetch('/held', { method: 'POST', body: 'x'.repeat(70000), keepalive: false }).catch((e) => console.error('control: fetch rejected ' + e.name));
    setTimeout(() => location.assign('/landed'), 50);
  };
</script>`;

for (const browserType of [chromium, webkit, firefox]) {
  const browser = await browserType.launch();
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text().replace(/\s+/g, ' ').slice(0, 90)}`));
  await page.route('http://ctl.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/a') return route.fulfill({ contentType: 'text/html', body: pageA });
    if (path === '/b') return route.fulfill({ contentType: 'text/html', body: pageB });
    if (path === '/collect404') return route.fulfill({ status: 404, body: 'no' });
    if (path === '/landed') return route.fulfill({ contentType: 'text/html', body: '<p>landed</p>' });
    if (path === '/held') return; // never answered: stays in flight
    return route.fulfill({ status: 404 });
  });
  await page.goto('http://ctl.test/a');
  await page.waitForTimeout(1500);
  const a = messages.filter((m) => m.includes('Permanent delivery failure')).length;
  messages.length = 0;
  await page.goto('http://ctl.test/b');
  await page.evaluate(() => window.go());
  await page.waitForURL('**/landed');
  await page.waitForTimeout(1000);
  console.log(`${browserType.name()} ${browser.version()}: (a) "Permanent delivery failure" captured ${a}x | (b) during unload: ${JSON.stringify(messages)}`);
  await browser.close();
}
