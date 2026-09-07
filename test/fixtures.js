// Synthesised fixtures. No real patient data — the source sample was deleted.
// Structure mirrors the "New Patient Booking Activation" template: each label
// on its own line, value on the next.

const COMPLETE = [
  'New Patient Booking Activation',
  'Patient first name:',
  'Alex',
  'Patient surname:',
  'Sample',
  'Patient gender:',
  'Male',
  'Patient date of birth:',
  '5/4/1988',
  'Patient appointment date:',
  '2/9/2026',
  'Patient appointment time:',
  '8:50 am',
  'Account holder A titled full name:',
  'Dr. Jamie R Sample',
  'Account holder A mobile number:',
  '+61-400-000-000',
  'Account holder A email:',
  'jamie@example.com',
  'Needs referral for:',
  'OPG + Lateral Cephalogram',
].join('\n');

// As delivered by the converter before normalisation: 'first' carries the
// MacRoman fi ligature, and the time uses a narrow no-break space.
const RAW_ENCODING = COMPLETE
  .replace('Patient first name:', 'Patient \ufb01rst name:')
  .replace('8:50 am', '8:50\u202fam');

const MISSING_LABEL = COMPLETE
  .replace('Patient gender:\nMale\n', '');

const BAD_DATE = COMPLETE
  .replace('5/4/1988', '05-04-88');

// A label the form emitted with no value, so the next label follows it
// directly. Without a guard, that label text becomes the field's value.
const BLANK_VALUE = COMPLETE
  .replace('Account holder A email:\njamie@example.com\n', 'Account holder A email:\n');

// A label emitted with a blank value, where the line that follows is document
// boilerplate rather than another known label — so isLabelLine cannot see it
// and the footer would be taken as the email address.
const BOILERPLATE_VALUE = COMPLETE
  .replace('jamie@example.com', 'Page 1 of 1');

// The same failure on a phone field: a title, not a number.
const BOILERPLATE_MOBILE = COMPLETE
  .replace('+61-400-000-000', 'New Patient Booking Activation');

const WITH_ACCOUNT_HOLDER_B = COMPLETE
  .replace('Needs referral for:', [
    'Account holder B titled full name:',
    'Mr. Chris Sample',
    'Account holder B mobile number:',
    '+61-400-000-001',
    'Account holder B email:',
    'chris@example.com',
    'Needs referral for:',
  ].join('\n'));

// Drive's converter merges some label/value pairs onto one line and leaves
// others on two, depending on their spacing in the source PDF. Real converted
// output contains both forms in the same document.
const INLINE_MIXED = [
  'New Patient Booking Activation',
  'Patient first name:',
  'Alex',
  'Patient surname: Sample',
  'Patient gender:',
  'Male',
  'Patient date of birth: 5/4/1988',
  'Patient appointment date: 2/9/2026',
  'Patient appointment time:',
  '8:50 am',
  'Account holder A titled full name: Dr. Jamie R Sample',
  'Account holder A mobile number: +61-400-000-000',
  'Account holder A email:',
  'jamie@example.com',
  'Needs referral for: OPG + Lateral Cephalogram',
].join('\n');

// A label whose value is blank, immediately followed by an INLINE label.
// The guard must not take 'Needs referral for: OPG' as the email's value.
const BLANK_BEFORE_INLINE = [
  'Account holder A email:',
  'Needs referral for: OPG',
].join('\n');

const UNRELATED = [
  'Invoice #4471',
  'Amount due: $320.00',
  'Thank you for your business.',
].join('\n');

function withReferral(value) {
  return COMPLETE.replace('OPG + Lateral Cephalogram', value);
}

// The template now lists every Account holder A address on its own line —
// one to three of them across the sample documents. The account holder's own
// address comes first, with the practice's copy trailing it.
const MULTI_EMAIL = COMPLETE
  .replace('jamie@example.com', [
    'jamie@example.com',
    'alex@example.com',
    'bookings@example.com',
  ].join('\n'));

// A non-address line inside the email block. The pattern check runs per line,
// so this is dropped and the two real addresses are kept — rather than the
// whole field nulling, or the footer travelling as an address.
const MULTI_EMAIL_WITH_BOILERPLATE = COMPLETE
  .replace('jamie@example.com', [
    'jamie@example.com',
    'Page 1 of 1',
    'bookings@example.com',
  ].join('\n'));

// Account holder B's addresses list exactly as A's do.
const MULTI_EMAIL_ACCOUNT_HOLDER_B = WITH_ACCOUNT_HOLDER_B
  .replace('chris@example.com', [
    'chris@example.com',
    'chris.alt@example.com',
  ].join('\n'));

// The new referral layout: one item per line, where the old template emitted
// a single '+'-joined string.
const MULTI_REFERRAL = COMPLETE
  .replace('OPG + Lateral Cephalogram', ['OPG', 'Lateral Cephalogram'].join('\n'));

// Two of the three sample documents leave an empty line between
// 'Needs referral for:' and its value. Confirmed against the content stream:
// nothing is drawn on that line, so it is a real blank, not whitespace text.
const BLANK_LINE_BEFORE_VALUE = COMPLETE
  .replace('Needs referral for:\n', 'Needs referral for:\n\n');

module.exports = {
  COMPLETE,
  RAW_ENCODING,
  MISSING_LABEL,
  BAD_DATE,
  WITH_ACCOUNT_HOLDER_B,
  BLANK_VALUE,
  INLINE_MIXED,
  BLANK_BEFORE_INLINE,
  BOILERPLATE_VALUE,
  BOILERPLATE_MOBILE,
  MULTI_EMAIL,
  MULTI_EMAIL_WITH_BOILERPLATE,
  MULTI_EMAIL_ACCOUNT_HOLDER_B,
  MULTI_REFERRAL,
  BLANK_LINE_BEFORE_VALUE,
  UNRELATED,
  withReferral,
};
