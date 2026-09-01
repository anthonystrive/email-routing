const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

/**
 * The seen store is the only thing preventing both consequential failure
 * modes — a record delivered twice, and a record silently lost — now that the
 * search query carries no label exclusions at all. So it is tested directly.
 *
 * dedupe.gs touches exactly one Apps Script service, PropertiesService, so a
 * fake backed by a plain object is a complete stand-in.
 */
function fakeProperties(initial) {
  const store = Object.assign({}, initial);
  const service = {
    getProperty: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setProperty: (key, value) => { store[key] = String(value); return service; },
    deleteProperty: (key) => { delete store[key]; return service; },
    getProperties: () => Object.assign({}, store),
  };
  return { store, service };
}

/** dedupe.gs loaded against a fresh fake store; returns both. */
function load(initial) {
  const { store, service } = fakeProperties(initial);
  const app = loadAppsScript(['dedupe.gs'], {
    PropertiesService: { getScriptProperties: () => service },
  });
  return { app, store };
}

test('getSeenOutcome returns null for a message never processed', () => {
  const { app } = load();
  assert.strictEqual(app.getSeenOutcome('msg-unknown'), null);
});

test('getSeenOutcome returns the outcome recorded by markSeen', () => {
  const { app } = load();
  app.markSeen('msg-1', 'pdf-processed');
  assert.strictEqual(app.getSeenOutcome('msg-1'), 'pdf-processed');
});

test('a round trip preserves the exact outcome string', () => {
  // The stored outcome is what the message is relabelled with on a rerun.
  // Collapsing pdf-partial to pdf-processed would quietly mark an incomplete
  // extraction as a clean one, and the daily summary would stop counting it.
  const { app } = load();
  app.markSeen('msg-partial', 'pdf-partial');
  app.markSeen('msg-failed', 'pdf-failed');
  app.markSeen('msg-ignored', 'pdf-ignored');
  assert.strictEqual(app.getSeenOutcome('msg-partial'), 'pdf-partial');
  assert.strictEqual(app.getSeenOutcome('msg-failed'), 'pdf-failed');
  assert.strictEqual(app.getSeenOutcome('msg-ignored'), 'pdf-ignored');
});

test('an outcome can be overwritten by a later, more final one', () => {
  const { app } = load();
  app.markSeen('msg-1', 'pdf-partial');
  app.markSeen('msg-1', 'pdf-processed');
  assert.strictEqual(app.getSeenOutcome('msg-1'), 'pdf-processed');
});

test('the stored value carries a timestamp before the outcome', () => {
  const { app, store } = load();
  const before = Date.now();
  app.markSeen('msg-1', 'pdf-processed');
  const value = store['seen:msg-1'];
  const [stamp, outcome] = value.split('|');
  assert.strictEqual(outcome, 'pdf-processed');
  assert.ok(Number(stamp) >= before, 'timestamp should be the time of writing');
});

test('pruneSeen deletes an entry older than the TTL and keeps a fresh one', () => {
  const { app, store } = load();
  const ttl = 8 * 24 * 60 * 60 * 1000;
  store['seen:old'] = String(Date.now() - ttl - 60000) + '|pdf-processed';
  store['seen:fresh'] = String(Date.now()) + '|pdf-processed';

  app.pruneSeen();

  assert.strictEqual(app.getSeenOutcome('old'), null, 'expired entry should be gone');
  assert.strictEqual(app.getSeenOutcome('fresh'), 'pdf-processed', 'fresh entry should survive');
});

test('pruneSeen keeps an entry exactly at the edge of the window', () => {
  const { app, store } = load();
  store['seen:edge'] = String(Date.now()) + '|pdf-partial';
  app.pruneSeen();
  assert.strictEqual(app.getSeenOutcome('edge'), 'pdf-partial');
});

test('pruneSeen never touches the live configuration properties', () => {
  // The seen records share one script-property store with the configuration.
  // The `indexOf(SEEN_PREFIX) !== 0` guard in pruneSeen is the ONLY thing
  // keeping this sweep away from them. Invert that guard and this test must
  // fail: without it a single scheduled run deletes the hook URL, the sender
  // allowlist and the summary address, and the deploy takes itself down.
  const { app, store } = load({
    ZAPIER_HOOK_URL: 'https://hooks.zapier.com/hooks/catch/1/abc/',
    SENDER_ALLOWLIST: 'bookings@clinic.com.au,@clinic.com.au',
    SUMMARY_TO: 'owner@clinic.com.au',
  });

  app.pruneSeen();

  assert.strictEqual(store.ZAPIER_HOOK_URL, 'https://hooks.zapier.com/hooks/catch/1/abc/');
  assert.strictEqual(store.SENDER_ALLOWLIST, 'bookings@clinic.com.au,@clinic.com.au');
  assert.strictEqual(store.SUMMARY_TO, 'owner@clinic.com.au');
});

test('pruneSeen leaves configuration alone even when it looks stale', () => {
  // A numeric-looking config value must not be read as a timestamp.
  const { app, store } = load({ SOME_EPOCH_SETTING: '0' });
  app.pruneSeen();
  assert.strictEqual(store.SOME_EPOCH_SETTING, '0');
});

test('pruneSeen drops a malformed record rather than retaining it forever', () => {
  // A value with no '|' has no readable timestamp, so it can never age out on
  // its own. Left in place it would occupy the store permanently.
  const { app, store } = load({
    'seen:empty': '',
    'seen:no-separator': '1700000000000',
    'seen:not-a-number': 'garbage|pdf-processed',
  });

  app.pruneSeen();

  assert.ok(!('seen:empty' in store), 'empty value should be pruned');
  assert.ok(!('seen:no-separator' in store), 'value with no separator should be pruned');
  assert.ok(!('seen:not-a-number' in store), 'unparseable timestamp should be pruned');
});

test('getSeenOutcome treats a malformed record as never processed', () => {
  const { app } = load({ 'seen:broken': '', 'seen:half': '1700000000000' });
  assert.strictEqual(app.getSeenOutcome('broken'), null);
  assert.strictEqual(app.getSeenOutcome('half'), null);
});

test('an outcome containing a pipe still round trips its first segment intact', () => {
  // Defensive: outcomes come from LABELS and contain no pipe today. The split
  // must be on the FIRST separator so the timestamp is never confused with
  // part of the outcome.
  const { app } = load();
  app.markSeen('msg-1', 'pdf-processed|extra');
  assert.strictEqual(app.getSeenOutcome('msg-1'), 'pdf-processed|extra');
});
