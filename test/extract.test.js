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
  assert.strictEqual(record.account_holder_a_name, 'Jamie R Sample');
  assert.strictEqual(record.account_holder_a_mobile, '+61-400-000-000');
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.account_holder_a_postal_address,
    '34 Sample Street, Sampleton, VIC 3000');
  assert.strictEqual(record.needs_referral_for, 'OPG (Item 57966) + Lateral Cephalogram');
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
  assert.strictEqual(record.account_holder_b_name, 'Chris Sample');
  assert.strictEqual(record.account_holder_b_mobile, '+61-400-000-001');
  assert.strictEqual(record.account_holder_b_email, 'chris@example.com');
  assert.strictEqual(record.account_holder_a_name, 'Jamie R Sample');
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

test('extracts an inline label/value pair on one line', () => {
  const record = app.extractFields(fx.INLINE_MIXED);
  assert.strictEqual(record.patient_surname, 'Sample');
  assert.strictEqual(record.patient_appointment_date, '2026-09-02');
  assert.strictEqual(record.account_holder_a_mobile, '+61-400-000-000');
  assert.strictEqual(record.needs_referral_for, 'OPG (Item 57966) + Lateral Cephalogram');
});

test('handles inline and next-line pairs in the same document', () => {
  const record = app.extractFields(fx.INLINE_MIXED);
  assert.strictEqual(record.patient_first_name, 'Alex');       // next-line
  assert.strictEqual(record.patient_gender, 'Male');           // next-line
  assert.strictEqual(record.patient_appointment_time, '8:50 am'); // next-line
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.account_holder_a_name, 'Jamie R Sample'); // inline
});

test('an inline transform still runs on the inline value', () => {
  const record = app.extractFields(fx.INLINE_MIXED);
  assert.strictEqual(record.patient_date_of_birth, '1988-04-05');
});

test('a blank value does not swallow an inline label that follows', () => {
  const record = app.extractFields(fx.BLANK_BEFORE_INLINE);
  assert.strictEqual(record.account_holder_a_email, null);
  assert.strictEqual(record.needs_referral_for, 'OPG (Item 57966)');
});

test('a label never matches a longer label that starts with it', () => {
  // 'Patient appointment date' must not be found inside a hypothetical
  // 'Patient appointment dates confirmed' line.
  const record = app.extractFields('Patient appointment dateX: 1/1/2020');
  assert.strictEqual(record.patient_appointment_date, null);
});

test('a label with no following line yields null', () => {
  const record = app.extractFields('Patient first name:');
  assert.strictEqual(record.patient_first_name, null);
});

test('a label with a blank value does not consume the next label', () => {
  const record = app.extractFields(fx.BLANK_VALUE);
  assert.strictEqual(record.account_holder_a_email, null);
  assert.strictEqual(record.needs_referral_for, 'OPG (Item 57966) + Lateral Cephalogram');
});

test('boilerplate taken as an email value is rejected, not delivered', () => {
  // isLabelLine only knows the 13 labels, so a footer following a blank label
  // slips through as a value. Delivering 'Page 1 of 1' as an email address
  // while reporting complete:true is worse than a null, because nothing
  // downstream can tell it is wrong.
  const record = app.extractFields(fx.BOILERPLATE_VALUE);
  assert.strictEqual(record.account_holder_a_email, null);
});

test('a legitimate email value passes the shape check', () => {
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
});

test('boilerplate taken as a mobile value is rejected', () => {
  const record = app.extractFields(fx.BOILERPLATE_MOBILE);
  assert.strictEqual(record.account_holder_a_mobile, null);
});

test('a legitimate mobile value passes the shape check', () => {
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.account_holder_a_mobile, '+61-400-000-000');
});

test('a rejected value does not disturb the rest of the record', () => {
  const record = app.extractFields(fx.BOILERPLATE_VALUE);
  assert.strictEqual(record.patient_first_name, 'Alex');
  assert.strictEqual(record.account_holder_a_mobile, '+61-400-000-000');
  assert.strictEqual(record.needs_referral_for, 'OPG (Item 57966) + Lateral Cephalogram');
});

test('the shape check stays loose enough for unusual real values', () => {
  // Deliberately not address or phone validation — only enough to reject
  // obvious boilerplate. These are odd but plausible, and must survive.
  const odd = fx.COMPLETE
    .replace('jamie@example.com', 'jamie+bookings@sub.example.museum')
    .replace('+61-400-000-000', '(07) 4000 0000 ext. 12');
  const record = app.extractFields(odd);
  assert.strictEqual(record.account_holder_a_email, 'jamie+bookings@sub.example.museum');
  assert.strictEqual(record.account_holder_a_mobile, '(07) 4000 0000 ext. 12');
});

test('a rejected value is reported as missing, not as complete', () => {
  const app2 = loadAppsScript(['text.gs', 'transforms.gs', 'extract.gs', 'validate.gs']);
  const assessment = app2.assessExtraction(app2.extractFields(fx.BOILERPLATE_VALUE));
  assert.strictEqual(assessment.complete, false);
  assert.ok(assessment.missing_fields.includes('account_holder_a_email'));
});

// --- multi-line values: the September 2026 template revision ---

test('the additional addresses exclude the primary', () => {
  // The first address is delivered on its own as account_holder_a_email.
  // Repeating it here made a Zap send to the same person twice.
  const record = app.extractFields(fx.MULTI_EMAIL);
  assert.strictEqual(record.account_holder_a_emails,
    'alex@example.com, bookings@example.com');
});

test('the scalar email field keeps the first address', () => {
  // Existing Zap steps read account_holder_a_email as a string. The list is
  // additive; this key must not change type or value for them.
  const record = app.extractFields(fx.MULTI_EMAIL);
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
});

test('a single address leaves the additional field empty', () => {
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.account_holder_a_emails, null);
});

test('a non-address line inside the email block is dropped', () => {
  const record = app.extractFields(fx.MULTI_EMAIL_WITH_BOILERPLATE);
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.account_holder_a_emails, 'bookings@example.com');
});

test('no address at all yields nulls in both fields', () => {
  const record = app.extractFields(fx.BLANK_VALUE);
  assert.strictEqual(record.account_holder_a_email, null);
  assert.strictEqual(record.account_holder_a_emails, null);
});

test('account holder B addresses collect the same way', () => {
  const record = app.extractFields(fx.MULTI_EMAIL_ACCOUNT_HOLDER_B);
  assert.strictEqual(record.account_holder_b_email, 'chris@example.com');
  assert.strictEqual(record.account_holder_b_emails, 'chris.alt@example.com');
});

test('an absent account holder B yields nulls, like every other field', () => {
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.account_holder_b_email, null);
  assert.strictEqual(record.account_holder_b_emails, null);
});

test('a referral listed one item per line joins into the single-line form', () => {
  // The old template emitted 'OPG + Lateral Cephalogram' on one line. The
  // new one lists each item separately; downstream must not be able to tell.
  const record = app.extractFields(fx.MULTI_REFERRAL);
  assert.strictEqual(record.needs_referral_for, 'OPG (Item 57966) + Lateral Cephalogram');
});

test('booleans are derived from a referral spanning several lines', () => {
  const record = app.extractFields(fx.MULTI_REFERRAL);
  assert.strictEqual(record.needs_opg, true);
  assert.strictEqual(record.needs_lateral_ceph, true);
});

test('a blank line between a label and its value does not break extraction', () => {
  const record = app.extractFields(fx.BLANK_LINE_BEFORE_VALUE);
  assert.strictEqual(record.needs_referral_for, 'OPG (Item 57966) + Lateral Cephalogram');
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
});

test('an inline label followed by more lines collects the whole list', () => {
  // Drive merges some label/value pairs onto one line. When it merges the
  // label with the FIRST of several addresses, the rest still follow on their
  // own lines, and all of them belong to the field.
  const text = fx.COMPLETE.replace(
    'Account holder A email:\njamie@example.com',
    'Account holder A email: jamie@example.com\nalex@example.com'
  );
  const record = app.extractFields(text);
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.account_holder_a_emails, 'alex@example.com');
});

test('addresses merged onto one line by the converter are split apart', () => {
  // Drive merges lines. Collected as one value, both addresses travel in a
  // single field and the receiving system rejects it as not an email — which
  // is exactly what reached Zapier.
  const record = app.extractFields(fx.MERGED_EMAILS);
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.account_holder_a_emails, 'alex@example.com');
});

test('merged addresses split on commas and semicolons too', () => {
  const record = app.extractFields(fx.MERGED_EMAILS_PUNCTUATED);
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.account_holder_a_emails,
    'alex@example.com, bookings@example.com');
});

test('splitting is confined to the address fields', () => {
  // A name and a mobile number both contain spaces and must survive whole.
  // Only a field that declares a separator is split.
  const record = app.extractFields(fx.MERGED_EMAILS);
  assert.strictEqual(record.account_holder_a_name, 'Jamie R Sample');
  assert.strictEqual(record.account_holder_a_mobile, '+61-400-000-000');
  assert.strictEqual(record.needs_referral_for, 'OPG (Item 57966) + Lateral Cephalogram');
});

test('a label merged inline with several addresses is still split', () => {
  // Both of Drive's merges at once: the label joined to its value, and the
  // addresses joined to each other.
  const text = fx.COMPLETE.replace(
    'Account holder A email:\njamie@example.com',
    'Account holder A email: jamie@example.com alex@example.com'
  );
  const record = app.extractFields(text);
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.account_holder_a_emails, 'alex@example.com');
});

// --- postal address: the September 2026 template's newest field ---

test('the postal address survives its commas intact', () => {
  // The email fields declare a separator because the converter merges one
  // address per line onto a single line. An address is the opposite case:
  // its commas are structure, and splitting on them yields three fragments
  // no delivery system can use.
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.account_holder_a_postal_address,
    '34 Sample Street, Sampleton, VIC 3000');
});

test('a postal address merged inline with its label is read', () => {
  const record = app.extractFields(fx.INLINE_MIXED);
  assert.strictEqual(record.account_holder_a_postal_address,
    '34 Sample Street, Sampleton, VIC 3000');
});

test('an absent postal address label yields null', () => {
  const record = app.extractFields(fx.NO_POSTAL_ADDRESS);
  assert.strictEqual(record.account_holder_a_postal_address, null);
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.needs_referral_for, 'OPG (Item 57966) + Lateral Cephalogram');
});

test('a blank postal address does not swallow the next label', () => {
  const record = app.extractFields(fx.BLANK_POSTAL_ADDRESS);
  assert.strictEqual(record.account_holder_a_postal_address, null);
  assert.strictEqual(record.needs_referral_for, 'OPG (Item 57966) + Lateral Cephalogram');
});

test('boilerplate taken as a postal address is rejected', () => {
  const record = app.extractFields(fx.BOILERPLATE_POSTAL_ADDRESS);
  assert.strictEqual(record.account_holder_a_postal_address, null);
});

test('the postal address shape check stays loose', () => {
  // Only enough to reject an obvious title. A PO box, a unit number and a
  // rural address are all plausible and must survive.
  const odd = fx.COMPLETE
    .replace('34 Sample Street, Sampleton, VIC 3000', 'PO Box 7, Sampleton VIC 3000');
  const record = app.extractFields(odd);
  assert.strictEqual(record.account_holder_a_postal_address,
    'PO Box 7, Sampleton VIC 3000');
});

// --- referral item numbers, end to end ---

test('the delivered referral carries the OPG item number', () => {
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.needs_referral_for,
    'OPG (Item 57966) + Lateral Cephalogram');
});

test('both template layouts yield an identical referral string', () => {
  // MULTI_REFERRAL lists one item per line; COMPLETE merges them onto one.
  // The transform runs per line, so the two must not diverge.
  assert.strictEqual(
    app.extractFields(fx.MULTI_REFERRAL).needs_referral_for,
    app.extractFields(fx.COMPLETE).needs_referral_for);
});

test('the derived booleans survive the appended item number', () => {
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.needs_opg, true);
  assert.strictEqual(record.needs_lateral_ceph, true);
});

test('a referral without OPG is delivered unchanged', () => {
  const record = app.extractFields(fx.withReferral('Lateral Cephalogram'));
  assert.strictEqual(record.needs_referral_for, 'Lateral Cephalogram');
  assert.strictEqual(record.needs_opg, false);
});
