const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['config.gs', 'gmail.gs']);

test('the query requires a pdf attachment', () => {
  const query = app.buildSearchQuery();
  assert.match(query, /has:attachment/);
  assert.match(query, /filename:pdf/);
});

test('the query excludes every terminal label', () => {
  const query = app.buildSearchQuery();
  assert.match(query, /-label:pdf-processed/);
  assert.match(query, /-label:pdf-partial/);
  assert.match(query, /-label:pdf-failed/);
  assert.match(query, /-label:pdf-ignored/);
});

test('the query is bounded in time', () => {
  assert.match(app.buildSearchQuery(), /newer_than:7d/);
});
