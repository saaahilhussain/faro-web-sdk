/**
 * Scenario M: does the browser itself reject in-flight keepalive fetches when the page navigates?
 *
 * No Faro, no lifecycle listeners, no fetch wrapper. `start` sends five keepalive POSTs to an endpoint
 * the collector can hold open. Each promise reports how it settled with one small sendBeacon from its
 * own handler, which is the only thing the page records. The spec navigates with `navigate` once the
 * collector has received all five.
 *
 * Two control variants change one thing each: `hold-signal` passes an AbortSignal with each fetch,
 * as Faro's transport does for its request timeout, and `hold-listener` registers an empty pagehide
 * listener, as Faro's transport does.
 */
/* global AbortController, URLSearchParams */
(function () {
  const params = new URLSearchParams(window.location.search);
  const run = params.get('run') || 'manual';
  const variant = params.get('variant') || '';
  const COUNT = 5;

  function report(detail) {
    navigator.sendBeacon('/pd/beacon/' + run, JSON.stringify(detail));
  }

  if (variant === 'hold-listener') {
    window.addEventListener('pagehide', function () {});
  }

  window.pdMinimal = {
    start: function () {
      for (let i = 0; i < COUNT; i++) {
        const init = { method: 'POST', body: 'keepalive request ' + i, keepalive: true };
        if (variant === 'hold-signal') {
          init.signal = new AbortController().signal;
        }
        fetch('/pd/held/' + run + '/' + i, init).then(
          function (response) {
            report({ index: i, outcome: 'resolved', status: response.status });
          },
          function (error) {
            report({ index: i, outcome: 'rejected', error: (error && error.name) || String(error) });
          }
        );
      }
    },
    navigate: function () {
      window.location.assign('/pd/landed.html?run=' + run);
    },
  };
})();
