const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript, host } = require('./load');
const fx = require('./fixtures');

// config.gs is loaded because buildPayload normalises _meta.from through
// extractEmailAddress, which lives there.
const app = loadAppsScript(['config.gs', 'text.gs', 'transforms.gs', 'extract.gs', 'validate.gs']);

const CONTEXT = {
  messageId: 'msg-123',
  from: 'bookings@example.com',
  receivedAt: '2026-09-01T04:31:00.000Z',
};

test('a full document with no account holder B is complete', () => {
  const assessment = app.assessExtraction(app.extractFields(fx.COMPLETE));
  assert.strictEqual(assessment.complete, true);
  assert.deepStrictEqual(host(assessment.missing_fields), []);
  assert.strictEqual(assessment.empty, false);
});

test('optional fields are excluded from missing_fields', () => {
  const assessment = app.assessExtraction(app.extractFields(fx.COMPLETE));
  assert.ok(!assessment.missing_fields.includes('account_holder_b_name'));
});

test('a missing expected field is reported and marks the record incomplete', () => {
  const assessment = app.assessExtraction(app.extractFields(fx.MISSING_LABEL));
  assert.strictEqual(assessment.complete, false);
  assert.deepStrictEqual(host(assessment.missing_fields), ['patient_gender']);
  assert.strictEqual(assessment.empty, false);
});

test('a failed transform is reported as missing', () => {
  const assessment = app.assessExtraction(app.extractFields(fx.BAD_DATE));
  assert.deepStrictEqual(host(assessment.missing_fields), ['patient_date_of_birth']);
  assert.strictEqual(assessment.complete, false);
});

test('a document matching nothing is flagged empty', () => {
  const assessment = app.assessExtraction(app.extractFields(fx.UNRELATED));
  assert.strictEqual(assessment.empty, true);
  assert.strictEqual(assessment.complete, false);
});

test('a document with one field is not empty', () => {
  const assessment = app.assessExtraction(app.extractFields('Patient surname:\nSample'));
  assert.strictEqual(assessment.empty, false);
  assert.strictEqual(assessment.complete, false);
});

test('buildPayload carries every extracted field through unchanged', () => {
  const payload = app.buildPayload(app.extractFields(fx.COMPLETE), CONTEXT);
  assert.strictEqual(payload.patient_first_name, 'Alex');
  assert.strictEqual(payload.patient_date_of_birth, '1988-04-05');
  assert.strictEqual(payload.needs_opg, true);
});

test('buildPayload keeps missing fields as explicit nulls', () => {
  const payload = app.buildPayload(app.extractFields(fx.MISSING_LABEL), CONTEXT);
  assert.ok('patient_gender' in payload);
  assert.strictEqual(payload.patient_gender, null);
});

test('buildPayload attaches complete metadata', () => {
  const payload = app.buildPayload(app.extractFields(fx.COMPLETE), CONTEXT);
  assert.strictEqual(payload._meta.message_id, 'msg-123');
  assert.strictEqual(payload._meta.from, 'bookings@example.com');
  assert.strictEqual(payload._meta.received_at, '2026-09-01T04:31:00.000Z');
  assert.strictEqual(payload._meta.extractor_version, app.EXTRACTOR_VERSION);
  assert.strictEqual(payload._meta.complete, true);
  assert.deepStrictEqual(host(payload._meta.missing_fields), []);
});

test('_meta.from is the bare address, not the raw header', () => {
  // The data contract specifies 'sender@example.com'. A Zap filtering on the
  // sender should not have to parse a display name out of it.
  const payload = app.buildPayload(app.extractFields(fx.COMPLETE), {
    messageId: 'msg-123',
    from: 'Tops Ortho <bookings@example.com>',
    receivedAt: '2026-09-01T04:31:00.000Z',
  });
  assert.strictEqual(payload._meta.from, 'bookings@example.com');
});

test('buildPayload reports incompleteness in metadata', () => {
  const payload = app.buildPayload(app.extractFields(fx.MISSING_LABEL), CONTEXT);
  assert.strictEqual(payload._meta.complete, false);
  assert.deepStrictEqual(host(payload._meta.missing_fields), ['patient_gender']);
});

test('the payload is flat apart from _meta', () => {
  // Arrays of primitives are the one exception, for a field whose value is
  // genuinely a list — the account holder email addresses. Nested objects
  // stay banned: a Zap step maps a string or a line item, not a structure.
  const payload = app.buildPayload(app.extractFields(fx.COMPLETE), CONTEXT);
  for (const key of Object.keys(payload)) {
    if (key === '_meta') continue;
    const value = payload[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        assert.ok(item === null || typeof item !== 'object',
          'nested value inside the array at key: ' + key);
      }
      continue;
    }
    assert.ok(value === null || typeof value !== 'object',
      'nested value at key: ' + key);
  }
});

test('every email address reaches the payload', () => {
  const payload = app.buildPayload(app.extractFields(fx.MULTI_EMAIL), CONTEXT);
  assert.strictEqual(payload.account_holder_a_email, 'jamie@example.com');
  assert.deepStrictEqual(host(payload.account_holder_a_emails), [
    'jamie@example.com',
    'alex@example.com',
    'bookings@example.com',
  ]);
});
