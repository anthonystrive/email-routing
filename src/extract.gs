/**
 * Bumped by hand whenever FIELDS changes, so a downstream consumer can tell
 * which ruleset produced a given record.
 */
var EXTRACTOR_VERSION = '1.0.0';

/**
 * The only place in this system that knows anything about the source
 * document. When the template changes, this table is what changes.
 *
 * `optional: true` means absence is expected and does not count against the
 * record's completeness. Account holder B is a safeguard — most bookings
 * have only one account holder, and without `optional` every single record
 * would report as incomplete.
 */
var FIELDS = [
  { key: 'patient_first_name',       label: 'Patient first name' },
  { key: 'patient_surname',          label: 'Patient surname' },
  { key: 'patient_gender',           label: 'Patient gender' },
  { key: 'patient_date_of_birth',    label: 'Patient date of birth',
    transform: auDateToIso },
  { key: 'patient_appointment_date', label: 'Patient appointment date',
    transform: auDateToIso },
  { key: 'patient_appointment_time', label: 'Patient appointment time',
    transform: normaliseTime },

  { key: 'account_holder_a_name',    label: 'Account holder A titled full name' },
  { key: 'account_holder_a_mobile',  label: 'Account holder A mobile number' },
  { key: 'account_holder_a_email',   label: 'Account holder A email' },

  { key: 'account_holder_b_name',    label: 'Account holder B titled full name',
    optional: true },
  { key: 'account_holder_b_mobile',  label: 'Account holder B mobile number',
    optional: true },
  { key: 'account_holder_b_email',   label: 'Account holder B email',
    optional: true },

  { key: 'needs_referral_for',       label: 'Needs referral for' },
];

/**
 * True when a line is itself one of the document's labels.
 *
 * The form emits a label even when its value is blank, and toLines has
 * already dropped the empty line — so without this check the NEXT label
 * would be consumed as this field's value, writing plausible-looking
 * garbage ('Needs referral for:') into an email or phone field.
 */
function isLabelLine(line) {
  var candidate = line.toLowerCase().replace(/:$/, '').trim();
  return FIELDS.some(function (field) {
    return field.label.toLowerCase().replace(/:$/, '').trim() === candidate;
  });
}

/**
 * Finds a label line and returns the next line, which is its value.
 * Comparison is case-insensitive and tolerates a missing trailing colon.
 */
function findValueForLabel(lines, label) {
  const target = label.toLowerCase().replace(/:$/, '').trim();
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines[i].toLowerCase().replace(/:$/, '').trim();
    if (candidate === target) {
      if (i + 1 >= lines.length) return null;
      return isLabelLine(lines[i + 1]) ? null : lines[i + 1];
    }
  }
  return null;
}

/**
 * Document text to a flat record. Every FIELDS key is always present;
 * anything not found is null. Never throws — a document this cannot read
 * yields an all-null record, which validate.gs recognises as a failure.
 */
function extractFields(rawText) {
  const lines = toLines(rawText);
  const record = {};

  FIELDS.forEach(function (field) {
    const raw = findValueForLabel(lines, field.label);
    let value = raw;
    if (value !== null && field.transform) {
      value = field.transform(value);
    }
    record[field.key] = (value === '' || value === undefined) ? null : value;
  });

  // Derived by substring rather than by matching the three known values
  // exactly, so a fourth combination appearing later still yields correct
  // booleans. The raw string always passes through unchanged alongside them.
  const referral = record.needs_referral_for;
  record.needs_opg = referral ? /OPG/i.test(referral) : false;
  record.needs_lateral_ceph = referral ? /lateral\s+cephalogram/i.test(referral) : false;

  return record;
}
