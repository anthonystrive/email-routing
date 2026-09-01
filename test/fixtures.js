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

const UNRELATED = [
  'Invoice #4471',
  'Amount due: $320.00',
  'Thank you for your business.',
].join('\n');

function withReferral(value) {
  return COMPLETE.replace('OPG + Lateral Cephalogram', value);
}

module.exports = {
  COMPLETE,
  RAW_ENCODING,
  MISSING_LABEL,
  BAD_DATE,
  WITH_ACCOUNT_HOLDER_B,
  UNRELATED,
  withReferral,
};
