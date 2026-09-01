const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['config.gs']);

test('defines the four gmail labels', () => {
  assert.strictEqual(app.LABELS.processed, 'pdf-processed');
  assert.strictEqual(app.LABELS.partial, 'pdf-partial');
  assert.strictEqual(app.LABELS.failed, 'pdf-failed');
  assert.strictEqual(app.LABELS.ignored, 'pdf-ignored');
});

test('extracts an address from a display-name form', () => {
  assert.strictEqual(app.extractEmailAddress('Tops Ortho <bookings@example.com>'),
    'bookings@example.com');
});

test('accepts a bare address', () => {
  assert.strictEqual(app.extractEmailAddress('bookings@example.com'),
    'bookings@example.com');
});

test('lowercases and trims the extracted address', () => {
  assert.strictEqual(app.extractEmailAddress('  Bookings@Example.COM  '),
    'bookings@example.com');
});

test('returns empty string for missing input', () => {
  assert.strictEqual(app.extractEmailAddress(null), '');
  assert.strictEqual(app.extractEmailAddress(''), '');
});

test('allows an exactly matching address', () => {
  assert.strictEqual(
    app.isAllowedSender('Tops Ortho <bookings@example.com>', ['bookings@example.com']),
    true);
});

test('allows any address on an allowlisted domain', () => {
  assert.strictEqual(app.isAllowedSender('anyone@clinic.com.au', ['@clinic.com.au']), true);
});

test('rejects an address not on the allowlist', () => {
  assert.strictEqual(app.isAllowedSender('attacker@evil.com', ['bookings@example.com']), false);
});

test('rejects a domain that merely ends with an allowlisted one', () => {
  assert.strictEqual(app.isAllowedSender('someone@notclinic.com.au', ['@clinic.com.au']), false);
});

test('rejects everything when the allowlist is empty', () => {
  assert.strictEqual(app.isAllowedSender('bookings@example.com', []), false);
});

test('rejects a missing sender', () => {
  assert.strictEqual(app.isAllowedSender(null, ['bookings@example.com']), false);
});

test('a decoy address in a quoted display name does not win', () => {
  assert.strictEqual(
    app.extractEmailAddress('"Trusted <bookings@example.com>" <attacker@evil.com>'),
    'attacker@evil.com');
});

test('the last angle-addr wins when several are present', () => {
  assert.strictEqual(
    app.extractEmailAddress('Real Name <bookings@example.com> <attacker@evil.com>'),
    'attacker@evil.com');
});

test('a decoy display name does not pass the allowlist', () => {
  assert.strictEqual(
    app.isAllowedSender('"Trusted <bookings@example.com>" <attacker@evil.com>',
      ['bookings@example.com']),
    false);
});
