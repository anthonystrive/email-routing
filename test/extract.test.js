const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');
const fx = require('./fixtures');

const app = loadAppsScript(['text.gs', 'transforms.gs', 'extract.gs']);

test('extracts every field from a complete document', () => {
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.patient_first_name, 'Alex');
  assert.strictEqual(record.patient_surname, 'Sample');
  assert.strictEqual(record.patient_gender, 'Male');
  assert.strictEqual(record.patient_date_of_birth, '1988-04-05');
  assert.strictEqual(record.patient_appointment_date, '2026-09-02');
  assert.strictEqual(record.patient_appointment_time, '8:50 am');
  assert.strictEqual(record.account_holder_a_name, 'Dr. Jamie R Sample');
  assert.strictEqual(record.account_holder_a_mobile, '+61-400-000-000');
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.needs_referral_for, 'OPG + Lateral Cephalogram');
});

test('extracts correctly from raw converter encoding', () => {
  const record = app.extractFields(fx.RAW_ENCODING);
  assert.strictEqual(record.patient_first_name, 'Alex');
  assert.strictEqual(record.patient_appointment_time, '8:50 am');
});

test('account holder B is null when absent', () => {
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.account_holder_b_name, null);
  assert.strictEqual(record.account_holder_b_mobile, null);
  assert.strictEqual(record.account_holder_b_email, null);
});

test('account holder B is extracted when present', () => {
  const record = app.extractFields(fx.WITH_ACCOUNT_HOLDER_B);
  assert.strictEqual(record.account_holder_b_name, 'Mr. Chris Sample');
  assert.strictEqual(record.account_holder_b_mobile, '+61-400-000-001');
  assert.strictEqual(record.account_holder_b_email, 'chris@example.com');
  assert.strictEqual(record.account_holder_a_name, 'Dr. Jamie R Sample');
});

test('a missing label yields null without disturbing other fields', () => {
  const record = app.extractFields(fx.MISSING_LABEL);
  assert.strictEqual(record.patient_gender, null);
  assert.strictEqual(record.patient_first_name, 'Alex');
  assert.strictEqual(record.patient_date_of_birth, '1988-04-05');
});

test('a failed transform nulls only its own field', () => {
  const record = app.extractFields(fx.BAD_DATE);
  assert.strictEqual(record.patient_date_of_birth, null);
  assert.strictEqual(record.patient_appointment_date, '2026-09-02');
  assert.strictEqual(record.patient_first_name, 'Alex');
});

test('every FIELDS key is present even when nothing matches', () => {
  const record = app.extractFields(fx.UNRELATED);
  for (const field of app.FIELDS) {
    assert.ok(field.key in record, 'missing key: ' + field.key);
    assert.strictEqual(record[field.key], null);
  }
});

test('derives both referral booleans from a compound value', () => {
  const record = app.extractFields(fx.withReferral('OPG + Lateral Cephalogram'));
  assert.strictEqual(record.needs_opg, true);
  assert.strictEqual(record.needs_lateral_ceph, true);
});

test('derives referral booleans from OPG alone', () => {
  const record = app.extractFields(fx.withReferral('OPG'));
  assert.strictEqual(record.needs_opg, true);
  assert.strictEqual(record.needs_lateral_ceph, false);
});

test('derives referral booleans from Lateral Cephalogram alone', () => {
  const record = app.extractFields(fx.withReferral('Lateral Cephalogram'));
  assert.strictEqual(record.needs_opg, false);
  assert.strictEqual(record.needs_lateral_ceph, true);
});

test('an unrecognised referral value still passes through raw', () => {
  const record = app.extractFields(fx.withReferral('Bitewing X-ray'));
  assert.strictEqual(record.needs_referral_for, 'Bitewing X-ray');
  assert.strictEqual(record.needs_opg, false);
  assert.strictEqual(record.needs_lateral_ceph, false);
});

test('referral booleans are false, not null, when the field is absent', () => {
  const record = app.extractFields(fx.UNRELATED);
  assert.strictEqual(record.needs_opg, false);
  assert.strictEqual(record.needs_lateral_ceph, false);
});

test('label matching ignores case and a missing trailing colon', () => {
  const record = app.extractFields('PATIENT FIRST NAME\nAlex');
  assert.strictEqual(record.patient_first_name, 'Alex');
});

test('a label with no following line yields null', () => {
  const record = app.extractFields('Patient first name:');
  assert.strictEqual(record.patient_first_name, null);
});
