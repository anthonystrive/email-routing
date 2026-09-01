const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript, host } = require('./load');

const app = loadAppsScript(['text.gs']);

test('folds the fi ligature to plain ascii', () => {
  assert.strictEqual(app.normaliseText('Patient ﬁrst name'), 'Patient first name');
});

test('collapses narrow no-break space to ascii space', () => {
  assert.strictEqual(app.normaliseText('8:50 am'), '8:50 am');
});

test('collapses non-breaking space to ascii space', () => {
  assert.strictEqual(app.normaliseText('Dr. Sample'), 'Dr. Sample');
});

test('collapses a zero-width space to an ascii space', () => {
  // U+200B is not folded by NFKC and is invisible in every log and editor, so
  // one sitting inside a label breaks the field match with nothing to see.
  assert.strictEqual(app.normaliseText('Patient​name'), 'Patient name');
});

test('collapses a byte order mark to an ascii space', () => {
  // U+FEFF, same story: invisible, unfolded by NFKC, silently fatal to a match.
  assert.strictEqual(app.normaliseText('Patient﻿name'), 'Patient name');
});

test('a zero-width space inside a label is trimmed away by toLines', () => {
  assert.deepStrictEqual(
    host(app.toLines('﻿Patient first name:\nAlex​')),
    ['Patient first name:', 'Alex'],
  );
});

test('normalises CRLF and CR line endings to LF', () => {
  assert.strictEqual(app.normaliseText('a\r\nb\rc'), 'a\nb\nc');
});

test('handles null and undefined without throwing', () => {
  assert.strictEqual(app.normaliseText(null), '');
  assert.strictEqual(app.normaliseText(undefined), '');
});

test('toLines trims each line and drops empty ones', () => {
  assert.deepStrictEqual(host(app.toLines('  a  \n\n\n  b\n   \nc  ')), ['a', 'b', 'c']);
});

test('toLines applies normalisation', () => {
  assert.deepStrictEqual(host(app.toLines('Patient ﬁrst name:\nAlex')), ['Patient first name:', 'Alex']);
});
