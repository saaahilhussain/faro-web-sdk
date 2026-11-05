// Control script, run separately from the Playwright scenarios.
// In WebKit scenario D plain, does Faro call
// console.error("... Permanent delivery failure ...") during unload, and does Playwright capture it?
// An init script (runs before Faro, so Faro's unpatched console copy includes it) also writes every
// console.error call to sessionStorage, which survives the navigation.
import { createRequire } from 'node:module';

// Relative to this file: controls/ -> e2e/smoke, where @playwright/test is installed.
const require = createRequire(new URL('../../package.json', import.meta.url));
const { webkit } = require('@playwright/test');
const base = process.argv[2];
const trials = Number(process.argv[3] ?? 10);

const browser = await webkit.launch();
let calledCount = 0;
let capturedCount = 0;
let rejectedCount = 0;
for (let trial = 1; trial <= trials; trial++) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const captured = [];
  page.on('console', (message) => captured.push(message.text()));
  await page.addInitScript(() => {
    const original = console.error.bind(console);
    console.error = (...args) => {
      const text = args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
      const list = JSON.parse(sessionStorage.getItem('ctl:console') || '[]');
      list.push(text.slice(0, 300));
      sessionStorage.setItem('ctl:console', JSON.stringify(list));
      original(...args);
    };
  });
  const run = `Dctl_${Date.now()}_${trial}`;
  await page.goto(`${base}/pd/app.html?run=${run}&scenario=D&variant=plain`);
  await page.waitForFunction(() => window.pdState.started >= 1);
  await page.waitForTimeout(1000);
  const landed = page.waitForURL('**/pd/landed.html**');
  await page.evaluate(() => window.pd.start());
  await landed;
  await page.waitForTimeout(2000);
  const called = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ctl:console') || '[]'));
  const timeline = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || '[]'), `pd:${run}`);
  const rejected = timeline.some((entry) => entry.name === 'fetch:settled' && entry.error === 'TypeError');
  const calledPermanent = called.some((text) => text.includes('Permanent delivery failure'));
  const capturedPermanent = captured.some((text) => text.includes('Permanent delivery failure'));
  calledCount += calledPermanent ? 1 : 0;
  capturedCount += capturedPermanent ? 1 : 0;
  rejectedCount += rejected ? 1 : 0;
  console.log(`trial ${trial}: fetch rejected ${rejected}; console.error calls ${JSON.stringify(called.map((t) => t.slice(0, 80)))}; captured by Playwright ${capturedPermanent}`);
  await context.close();
}
console.log(`webkit ${browser.version()}: rejected ${rejectedCount}/${trials}, Faro called console.error with "Permanent delivery failure" ${calledCount}/${trials}, Playwright captured it ${capturedCount}/${trials}`);
await browser.close();
