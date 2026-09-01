const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

test('loadAppsScript exposes top-level functions from a .gs file', () => {
  const app = loadAppsScript(['text.gs']);
  assert.strictEqual(typeof app.normaliseText, 'function');
});

test('loaded files share one global scope', () => {
  // Deliberately the hostile alphabetical order: extract.gs first, before the
  // files defining the names it uses. Only a genuinely shared global scope
  // lets that work — and only lazily resolved references let it survive.
  // Loading a single file and calling one of its own functions would pass
  // even if this harness gave every file a scope of its own, which is why
  // this asserts across a file boundary instead.
  const app = loadAppsScript(['extract.gs', 'transforms.gs', 'text.gs']);
  assert.strictEqual(typeof app.FIELDS[3].transform, 'function');
  assert.strictEqual(app.FIELDS[3].transform('5/4/1988'), '1988-04-05');
  assert.strictEqual(app.normaliseText('a'), 'a');
});
