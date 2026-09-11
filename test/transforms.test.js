const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['transforms.gs']);

test('parses day-first Australian dates', () => {
  assert.strictEqual(app.auDateToIso('2/9/2026'), '2026-09-02');
});

test('day-first, not month-first: 2/9/2026 is September, not February', () => {
  assert.notStrictEqual(app.auDateToIso('2/9/2026'), '2026-02-09');
});

test('handles unpadded single-digit day and month', () => {
  assert.strictEqual(app.auDateToIso('5/4/1988'), '1988-04-05');
});

test('handles zero-padded input', () => {
  assert.strictEqual(app.auDateToIso('05/04/1988'), '1988-04-05');
});

test('rejects an impossible month', () => {
  assert.strictEqual(app.auDateToIso('5/13/1988'), null);
});

test('rejects a day that does not exist in that month', () => {
  assert.strictEqual(app.auDateToIso('31/2/2026'), null);
});

test('rejects malformed and empty date input', () => {
  assert.strictEqual(app.auDateToIso('not a date'), null);
  assert.strictEqual(app.auDateToIso('2026-09-02'), null);
  assert.strictEqual(app.auDateToIso(''), null);
  assert.strictEqual(app.auDateToIso(null), null);
});

test('normalises a 12-hour time with meridiem', () => {
  assert.strictEqual(app.normaliseTime('8:50 am'), '8:50 am');
});

test('normalises meridiem case and dotted forms', () => {
  assert.strictEqual(app.normaliseTime('8:50 AM'), '8:50 am');
  assert.strictEqual(app.normaliseTime('8:50 p.m.'), '8:50 pm');
});

test('normalises a time with no space before the meridiem', () => {
  assert.strictEqual(app.normaliseTime('8:50am'), '8:50 am');
});

test('rejects malformed and empty time input', () => {
  assert.strictEqual(app.normaliseTime('25:00 am'), null);
  assert.strictEqual(app.normaliseTime('8:70 am'), null);
  assert.strictEqual(app.normaliseTime('sometime'), null);
  assert.strictEqual(app.normaliseTime(''), null);
  assert.strictEqual(app.normaliseTime(null), null);
});

// --- referral item numbers ---

test('appends the MBS item number to OPG', () => {
  assert.strictEqual(app.appendReferralItemNumbers('OPG'), 'OPG (Item 57966)');
});

test('appends within a merged line, not only to a whole value', () => {
  // The old template emitted every item on one line. Both layouts still
  // reach this transform, and both must come out the same.
  assert.strictEqual(
    app.appendReferralItemNumbers('OPG + Lateral Cephalogram'),
    'OPG (Item 57966) + Lateral Cephalogram');
});

test('leaves an unmapped referral item untouched', () => {
  assert.strictEqual(app.appendReferralItemNumbers('Lateral Cephalogram'),
    'Lateral Cephalogram');
  assert.strictEqual(app.appendReferralItemNumbers('Bitewing X-ray'),
    'Bitewing X-ray');
});

test('does not append twice to a value that already carries the number', () => {
  // Guards against a document that already names the item, and against the
  // transform running over its own output.
  assert.strictEqual(app.appendReferralItemNumbers('OPG (Item 57966)'),
    'OPG (Item 57966)');
});

test('matches OPG on a word boundary only', () => {
  assert.strictEqual(app.appendReferralItemNumbers('OPGX'), 'OPGX');
});

test('passes empty and absent values through as every transform does', () => {
  assert.strictEqual(app.appendReferralItemNumbers(null), null);
  assert.strictEqual(app.appendReferralItemNumbers(undefined), null);
});
