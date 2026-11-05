/**
 * The test app. Runs after the built Faro bundles have loaded.
 *
 * Faro uses its default setup: `getWebInstrumentations()` plus `TracingInstrumentation`, default
 * transport, batching and concurrency. Scenario D's `gzip` variant adds `requestCompression: true`.
 *
 * The observers below only record, into the timeline that early.js keeps in sessionStorage:
 * - a fetch `requestHook` finds the failing request's span and notes when OpenTelemetry ends it;
 * - a fetch `applyCustomAttributesOnSpan` notes when OpenTelemetry has read the response body, which
 *   is when it schedules the span's end 300 ms later;
 * - a wrapper around `faro.api.pushTraces` notes when OpenTelemetry exports that span into Faro;
 * - a pass-through wrapper around `window.fetch` records each collector request as it starts: its
 *   keepalive flag, Idempotency-Key, Content-Encoding, body size, the item counts of an uncompressed
 *   body, and the transport's private `deliveryQueue.unloading` flag (read only).
 * Faro composes both fetch hooks with its own. With `observe=0` none of these observers is installed
 * and `TracingInstrumentation` gets no options.
 *
 * Scenario R adds `ReplayInstrumentation` with its default options.
 *
 * Query parameters: `run` (id), `scenario` (A to G, R), `variant`, `observe`, `fillerBytes` (C).
 */
/* global Element, Headers, TextEncoder, URL, URLSearchParams */
(function () {
  const params = new URLSearchParams(window.location.search);
  const run = params.get('run') || 'manual';
  const scenario = params.get('scenario') || '';
  const variant = params.get('variant') || '';
  const observe = window.pdObserve;
  const record = window.pdRecord;
  const state = window.pdState;
  const failUrl = '/pd/api/fail/' + run;
  const okUrl = '/pd/api/ok/' + run;
  const landedUrl = '/pd/landed.html?run=' + run;

  // Scenario C keeps a keepalive filler in flight when the span is sent. Scenario D sends a body over
  // the 60,000 byte budget.
  const FILLER_ITEM_BYTES = 4000;
  const C_FILLER_BYTES = Number(params.get('fillerBytes') || 0);
  const D_FILLER_BYTES = 68000;
  // Scenario E: more flushes than the default concurrency of 5, so the rest wait in the queue.
  const E_FLUSHES = 11;

  const sdk = window.GrafanaFaroWebSdk;
  const tracingSdk = window.GrafanaFaroWebTracing;

  let resolveSpanEnded;
  const spanEnded = new Promise(function (resolve) {
    resolveSpanEnded = resolve;
  });

  const tracingOptions = {
    instrumentationOptions: {
      fetchInstrumentationOptions: {
        // Faro composes this with its own hook. It only records.
        requestHook: function (span) {
          const attributes = span.attributes || {};
          const isFailingRequest = Object.keys(attributes).some(function (key) {
            return String(attributes[key]).indexOf(failUrl) !== -1;
          });
          if (!isFailingRequest) {
            return;
          }
          state.failSpan = span;
          const end = span.end.bind(span);
          span.end = function (endTime) {
            end(endTime);
            record('otel: fail span ended');
            resolveSpanEnded();
          };
          record('otel: fail span started');
        },
        // OpenTelemetry calls this once it has read the response body, then ends the span 300 ms
        // later. Faro composes this with its own. It only records.
        applyCustomAttributesOnSpan: function (span) {
          if (span === state.failSpan) {
            record('otel: fail span body read, end scheduled', { failSpan: window.pdFailSpanState() });
          }
        },
      },
    },
  };
  const tracing = new tracingSdk.TracingInstrumentation(observe ? tracingOptions : undefined);

  const instrumentations = sdk.getWebInstrumentations().concat([tracing]);
  if (scenario === 'R') {
    instrumentations.push(new window.GrafanaFaroInstrumentationReplay.ReplayInstrumentation());
  }
  const config = {
    url: '/collect/' + run,
    app: { name: 'pagehide-delivery', version: '1.0.0', environment: 'test' },
    instrumentations: instrumentations,
  };
  if (scenario === 'D' && variant === 'gzip') {
    config.requestCompression = true;
  }
  const faro = sdk.initializeFaro(config);

  if (observe) {
    const pushTraces = faro.api.pushTraces;
    faro.api.pushTraces = function (payload) {
      if (JSON.stringify(payload).indexOf(failUrl) !== -1) {
        record('faro: fail span exported into Faro', { failSpan: window.pdFailSpanState() });
      }
      return pushTraces(payload);
    };
  }

  /** Kept in step with `summarizeBody` in server.ts. */
  function summarizeBody(body) {
    const counts = {};
    ['logs', 'events', 'exceptions', 'measurements'].forEach(function (key) {
      if (Array.isArray(body[key]) && body[key].length > 0) {
        counts[key] = body[key].length;
      }
    });
    const spans = [];
    ((body.traces && body.traces.resourceSpans) || []).forEach(function (resourceSpans) {
      (resourceSpans.scopeSpans || []).forEach(function (scopeSpans) {
        (scopeSpans.spans || []).forEach(function (span) {
          spans.push(span);
        });
      });
    });
    if (spans.length > 0) {
      counts.spans = spans.length;
    }
    const eventNames = {};
    (body.events || []).forEach(function (event) {
      eventNames[event.name] = (eventNames[event.name] || 0) + 1;
    });
    const logTags = {};
    (body.logs || []).forEach(function (log) {
      const match = /^\[([A-Za-z]+(?:-[A-Za-z]+)*)-\d+\]/.exec(log.message || '');
      if (match) {
        logTags[match[1]] = (logTags[match[1]] || 0) + 1;
      }
    });
    return {
      counts: counts,
      eventNames: eventNames,
      failSpans: spans.filter(function (span) {
        return JSON.stringify(span.attributes || []).indexOf(failUrl) !== -1;
      }).length,
      failFetchEvents: (body.events || []).filter(function (event) {
        return event.name === 'faro.tracing.fetch' && JSON.stringify(event.attributes || {}).indexOf(failUrl) !== -1;
      }).length,
      logTags: logTags,
    };
  }

  function readHeader(headers, name) {
    if (!headers) {
      return null;
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      return headers.get(name);
    }
    const key = Object.keys(headers).find(function (candidate) {
      return candidate.toLowerCase() === name.toLowerCase();
    });
    return key === undefined ? null : headers[key];
  }

  function byteSize(body) {
    if (typeof body === 'string') {
      return new TextEncoder().encode(body).byteLength;
    }
    if (body && typeof body.size === 'number') {
      return body.size;
    }
    if (body && typeof body.byteLength === 'number') {
      return body.byteLength;
    }
    return null;
  }

  const transport = faro.transports.transports.find(function (candidate) {
    return candidate.name === '@grafana/faro-web-sdk:transport-fetch';
  });

  // Read-only view of the transport's private delivery queue.
  if (observe) {
    window.pdQueueState = function () {
      const queue = transport && transport.deliveryQueue;
      if (!queue) {
        return null;
      }
      return {
        inProgress: queue.inProgress,
        queued: queue.attemptQueue.length,
        admitted: queue.admitted,
        waitingRetry: queue.waiting.length,
        unloading: queue.unloading,
      };
    };
  }

  // Installed after the tracing instrumentation, so it wraps the traced fetch and sees every call the
  // transport makes. It passes every call through unchanged.
  const tracedFetch = window.fetch;
  let requestId = 0;
  function observingFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.indexOf('/collect/') === -1) {
      return Reflect.apply(tracedFetch, this, arguments);
    }
    const id = ++requestId;
    state.started++;
    let items = null;
    if (init && typeof init.body === 'string') {
      try {
        items = summarizeBody(JSON.parse(init.body));
      } catch {
        items = null;
      }
    }
    record('fetch:start', {
      id: id,
      keepalive: Boolean(init && init.keepalive),
      idempotencyKey: readHeader(init && init.headers, 'Idempotency-Key'),
      contentEncoding: readHeader(init && init.headers, 'Content-Encoding'),
      bodyBytes: byteSize(init && init.body),
      transportUnloading: transport && transport.deliveryQueue ? transport.deliveryQueue.unloading : null,
      items: items,
      failSpan: window.pdFailSpanState(),
    });
    const result = Reflect.apply(tracedFetch, this, arguments);
    result.then(
      function (response) {
        record('fetch:settled', { id: id, status: response.status });
      },
      function (error) {
        record('fetch:settled', { id: id, error: (error && error.name) || String(error) });
      }
    );
    return result;
  }
  if (observe) {
    window.fetch = observingFetch;
  }

  // Deterministic text with roughly the variety of real log lines, so compression has work to do.
  const WORDS = [
    'request',
    'session',
    'render',
    'cache',
    'timeout',
    'retry',
    'payload',
    'component',
    'handler',
    'route',
    'token',
    'value',
    'config',
    'widget',
    'update',
    'state',
    'event',
    'metric',
    'user',
    'order',
  ];
  function seededRandom(seed) {
    let value = seed >>> 0;
    return function () {
      value = (value + 0x6d2b79f5) >>> 0;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fillerMessage(tag, index) {
    let seed = 0;
    const key = run + tag + index;
    for (let i = 0; i < key.length; i++) {
      seed = (Math.imul(seed, 31) + key.charCodeAt(i)) | 0;
    }
    const random = seededRandom(seed);
    let text = '[' + tag + '-' + index + '] ';
    while (text.length < FILLER_ITEM_BYTES) {
      text += WORDS[Math.floor(random() * WORDS.length)] + '=' + Math.floor(random() * 0xffffffff).toString(16) + ' ';
    }
    return text.slice(0, FILLER_ITEM_BYTES);
  }

  /**
   * Push other telemetry: log messages totalling exactly `totalBytes`, in items of up to 4,000 bytes.
   * Fewer than 50 items, so this alone never triggers a flush.
   */
  function pushFiller(tag, totalBytes) {
    const count = Math.ceil(totalBytes / FILLER_ITEM_BYTES);
    for (let i = 0; i < count; i++) {
      const bytes = i === count - 1 ? totalBytes - FILLER_ITEM_BYTES * (count - 1) : FILLER_ITEM_BYTES;
      faro.api.pushLog([fillerMessage(tag, i).slice(0, bytes)]);
    }
    record('app: pushed filler', { tag: tag, items: count, messageBytes: totalBytes });
  }

  // Faro has no public flush. Its batch flushes synchronously as soon as it holds `itemLimit` items
  // (50 by default), so 50 pushes cause exactly one flush inside this call.
  window.pdFlushViaItemLimit = function (tag) {
    for (let i = 0; i < 50; i++) {
      faro.api.pushLog(['[' + tag + '-' + i + '] item ' + i]);
    }
    state.generated++;
  };

  function navigate(reason) {
    record('app: navigate', { reason: reason, failSpan: window.pdFailSpanState() });
    window.location.assign(landedUrl);
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function failingFetch() {
    record('app: fetch');
    const response = await fetch(failUrl);
    record('app: response', { status: response.status, failSpan: window.pdFailSpanState() });
    return response;
  }

  if (scenario === 'F') {
    // Registered after initializeFaro, so after the transport's own pagehide listener.
    window.addEventListener('pagehide', function () {
      record('F: listener after transport');
      window.pdFlushViaItemLimit('F-after');
    });
  }

  // Bubbling window listeners registered after Faro and OpenTelemetry run after their listeners.
  if (observe) {
    window.addEventListener('pagehide', function () {
      record('pagehide: after SDK', { queue: window.pdQueueState(), started: state.started });
    });
    window.addEventListener('visibilitychange', function () {
      record('visibilitychange:' + document.visibilityState + ': after SDK', {
        queue: window.pdQueueState(),
        started: state.started,
        failSpan: window.pdFailSpanState(),
      });
    });
  }

  const scenarios = {
    // Pending span: navigate inside OpenTelemetry's 300 ms span-end delay. `read` reads the response
    // body first; `noread`, `0ms` and `100ms` do not.
    A: async function () {
      const response = await failingFetch();
      if (variant === 'read') {
        await response.text();
        record('app: body read', { failSpan: window.pdFailSpanState() });
      }
      if (variant === '100ms') {
        await sleep(100);
      }
      navigate('A ' + variant + ' after the response');
    },
    // Ended span: navigate as soon as the span has ended, long before the 1000 ms batch export.
    B: async function () {
      await failingFetch();
      await spanEnded;
      navigate('B span ended');
    },
    // Budget competition: the filler is queued in pagehide, so Faro's unload flush sends it with
    // keepalive just before the span's own request, and it is still in flight when the span is sent.
    C: async function () {
      window.addEventListener('pagehide', function () {
        pushFiller('C-filler', C_FILLER_BYTES);
      });
      await failingFetch();
      await spanEnded;
      navigate('C span ended');
    },
    // One flush over 60,000 bytes during unload: the filler is queued in pagehide and Faro's
    // visibilitychange flush sends it.
    D: async function () {
      window.addEventListener('pagehide', function () {
        pushFiller('D-filler', D_FILLER_BYTES);
      });
      await sleep(0);
      navigate('D');
    },
    // More requests than the default concurrency: the collector holds every response, so five stay in
    // flight and the rest wait in the delivery queue when the page unloads.
    E: async function () {
      for (let i = 0; i < E_FLUSHES; i++) {
        window.pdFlushViaItemLimit('E-batch');
      }
      record('app: generated flushes', { generated: state.generated, started: state.started });
      await sleep(300);
      navigate('E');
    },
    // Listener order: the pagehide listeners from early.js and from above do the flushing.
    F: async function () {
      await sleep(0);
      navigate('F');
    },
  };

  // Scenario G is a usage flow that the spec drives by clicking the page's buttons. This script runs in
  // the head, before the buttons exist, so it listens on the document.
  function show(text) {
    const status = document.getElementById('status');
    if (status) {
      status.textContent = text;
    }
  }
  const actions = {
    load: async function () {
      show('loading');
      await Promise.all([fetch(okUrl), fetch(okUrl + 'b'), fetch(failUrl)]).catch(function () {});
      show('loaded');
    },
    details: function () {
      window.history.pushState({}, '', window.location.pathname + window.location.search + '#details');
      show('details');
    },
    warn: function () {
      console.warn('G: inventory is running low', { sku: 'A-1', remaining: 3 });
      console.error('G: could not save preferences', new Error('quota exceeded'));
      show('warned');
    },
    error: function () {
      show('error thrown');
      setTimeout(function () {
        throw new Error('G: unhandled error from a timer');
      }, 0);
    },
    next: function () {
      show('leaving');
      navigate(scenario + ' next page');
    },
    // Scenario R (replay.html): DOM changes for the recorder to capture.
    shuffle: function () {
      const body = document.querySelector('#grid tbody');
      if (body) {
        const rows = Array.prototype.slice.call(body.children);
        rows.reverse().forEach(function (row) {
          body.appendChild(row);
        });
      }
      show('shuffled');
    },
    toggle: function () {
      const details = document.getElementById('details-panel');
      if (details) {
        details.hidden = !details.hidden;
      }
      show('toggled');
    },
  };
  document.addEventListener('click', function (event) {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (button && Object.prototype.hasOwnProperty.call(actions, button.id)) {
      void actions[button.id]();
    }
  });

  window.pd = {
    start: function () {
      const runScenario = scenarios[scenario];
      if (runScenario) {
        record('app: start', { scenario: scenario, variant: variant });
        void runScenario();
      }
    },
  };
  record('app: ready', { scenario: scenario, variant: variant });
})();
