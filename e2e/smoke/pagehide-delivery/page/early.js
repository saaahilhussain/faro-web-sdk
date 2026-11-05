/**
 * Runs before the Faro bundles load, so everything registered here precedes Faro's own listeners.
 *
 * - `window.pdRecord` appends to a timeline in sessionStorage. sessionStorage survives the same-origin
 *   navigation, so the spec reads the timeline from the landing page.
 * - Capturing listeners on the window mark the lifecycle events before any SDK listener runs.
 * - Scenario F registers its first pagehide listener here, before the fetch transport exists.
 *
 * With `observe=0` none of that is installed: no timeline, no lifecycle listeners, no private reads.
 * The collector is then the only record of the trial.
 */
/* global URLSearchParams */
(function () {
  const params = new URLSearchParams(window.location.search);
  const run = params.get('run') || 'manual';
  const scenario = params.get('scenario') || '';
  const observe = params.get('observe') !== '0';
  const key = 'pd:' + run;

  function record(name, detail) {
    if (!observe) {
      return;
    }
    const timeline = JSON.parse(window.sessionStorage.getItem(key) || '[]');
    timeline.push(Object.assign({ atMs: performance.timeOrigin + performance.now(), name: name }, detail || {}));
    window.sessionStorage.setItem(key, JSON.stringify(timeline));
  }

  // Values the app script fills in. Read at event time, after the app script has run.
  window.pdState = { failSpan: undefined, generated: 0, started: 0 };
  window.pdObserve = observe;

  function failSpanState() {
    const span = window.pdState.failSpan;
    if (!span) {
      return 'not-started';
    }
    return span.isRecording() ? 'recording' : 'ended';
  }

  // The transport's private delivery queue, read only. app.js defines the reader once Faro exists.
  function queueState() {
    return window.pdQueueState ? window.pdQueueState() : null;
  }

  window.pdRecord = record;
  window.pdFailSpanState = failSpanState;

  if (observe) {
    window.addEventListener(
      'pagehide',
      function (event) {
        record('pagehide', {
          persisted: event.persisted,
          failSpan: failSpanState(),
          generated: window.pdState.generated,
          started: window.pdState.started,
          queue: queueState(),
        });
      },
      true
    );
    window.addEventListener(
      'visibilitychange',
      function () {
        record('visibilitychange:' + document.visibilityState, { failSpan: failSpanState(), queue: queueState() });
      },
      true
    );
  }

  if (scenario === 'F') {
    window.addEventListener('pagehide', function () {
      record('F: listener before transport');
      window.pdFlushViaItemLimit('F-before');
    });
  }
})();
