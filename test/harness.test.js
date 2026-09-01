const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

test('loadAppsScript exposes top-level functions from a .gs file', () => {
  const app = loadAppsScript(['text.gs']);
  assert.strictEqual(typeof app.normaliseText, 'function');
});

test('loaded files share one global scope', () => {
  const app = loadAppsScript(['text.gs']);
  assert.strictEqual(app.normaliseText('a'), 'a');
});
