const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['config.gs', 'summary.gs']);

test('scopes the summary query to one label and the last day', () => {
  const query = app.buildSummaryQuery('pdf-failed');
  assert.match(query, /label:pdf-failed/);
  assert.match(query, /newer_than:1d/);
});

test('builds a query for the partial label too', () => {
  assert.match(app.buildSummaryQuery(app.LABELS.partial), /label:pdf-partial/);
});
