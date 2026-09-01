const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['deliver.gs']);

/** Returns a transport that yields the given statuses in order. */
function transportReturning(statuses) {
  const calls = [];
  const fetchJson = (url, payload) => {
    calls.push({ url, payload });
    const next = statuses[calls.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchJson, calls };
}

function recordingSleep() {
  const delays = [];
  return { sleep: (ms) => delays.push(ms), delays };
}

test('succeeds on the first attempt', () => {
  const t = transportReturning([200]);
  const result = app.deliverPayload({ a: 1 }, 'https://hook.example', { fetchJson: t.fetchJson });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.attempts, 1);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(t.calls.length, 1);
});

test('passes the url and payload to the transport', () => {
  const t = transportReturning([200]);
  app.deliverPayload({ a: 1 }, 'https://hook.example', { fetchJson: t.fetchJson });
  assert.strictEqual(t.calls[0].url, 'https://hook.example');
  assert.deepStrictEqual(t.calls[0].payload, { a: 1 });
});

test('accepts any 2xx status', () => {
  const t = transportReturning([204]);
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson });
  assert.strictEqual(result.ok, true);
});

test('retries a 5xx and succeeds', () => {
  const t = transportReturning([500, 200]);
  const s = recordingSleep();
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson, sleep: s.sleep });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(t.calls.length, 2);
});

test('gives up after three 5xx attempts', () => {
  const t = transportReturning([500, 502, 503]);
  const s = recordingSleep();
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson, sleep: s.sleep });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.attempts, 3);
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.permanent, false);
});

test('backs off exponentially between retries', () => {
  const t = transportReturning([500, 500, 500]);
  const s = recordingSleep();
  app.deliverPayload({}, 'u', { fetchJson: t.fetchJson, sleep: s.sleep });
  assert.deepStrictEqual(s.delays, [1000, 2000]);
});

test('does not retry a 4xx', () => {
  const t = transportReturning([400, 200]);
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.attempts, 1);
  assert.strictEqual(result.permanent, true);
  assert.strictEqual(t.calls.length, 1);
});

test('retries a thrown network error', () => {
  const t = transportReturning([new Error('DNS failure'), 200]);
  const s = recordingSleep();
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson, sleep: s.sleep });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.attempts, 2);
});

test('reports the last error when every attempt throws', () => {
  const t = transportReturning([new Error('a'), new Error('b'), new Error('c')]);
  const s = recordingSleep();
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson, sleep: s.sleep });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /c/);
});

test('honours a custom attempt limit', () => {
  const t = transportReturning([500, 500, 500, 500, 500]);
  const s = recordingSleep();
  const result = app.deliverPayload({}, 'u',
    { fetchJson: t.fetchJson, sleep: s.sleep, maxAttempts: 5 });
  assert.strictEqual(result.attempts, 5);
  assert.strictEqual(t.calls.length, 5);
});
