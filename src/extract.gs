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
 *
 * `pattern` is a shape check, not a format validator. isLabelLine only knows
 * the 13 labels below, so a label emitted with a blank value followed by
 * document boilerplate (a footer, a title, 'Page 1 of 1') would take that
 * line as its value and still report complete — a wrong value is worse than
 * a null, because downstream cannot detect it. A value failing its pattern is
 * nulled, which routes it into missing_fields and pdf-partial exactly as a
 * failed transform does. Kept deliberately loose: the goal is rejecting
 * obvious boilerplate, not validating addresses or phone numbers.
 *
 * Every `transform` is wrapped in a function literal rather than named
 * directly. A bare reference is dereferenced when this array is BUILT, which
 * depends on the order Apps Script evaluates project files — alphabetical by
 * clasp default, so extract.gs would load before transforms.gs and throw
 * ReferenceError at load time, killing every execution. File order is not
 * version-controlled, so the reference must be resolved at call time instead.
 */
var FIELDS = [
  { key: 'patient_first_name',       label: 'Patient first name' },
  { key: 'patient_surname',          label: 'Patient surname' },
  { key: 'patient_gender',           label: 'Patient gender' },
  { key: 'patient_date_of_birth',    label: 'Patient date of birth',
    transform: function (v) { return auDateToIso(v); } },
  { key: 'patient_appointment_date', label: 'Patient appointment date',
    transform: function (v) { return auDateToIso(v); } },
  { key: 'patient_appointment_time', label: 'Patient appointment time',
    transform: function (v) { return normaliseTime(v); } },

  { key: 'account_holder_a_name',    label: 'Account holder A titled full name' },
  { key: 'account_holder_a_mobile',  label: 'Account holder A mobile number',
    pattern: /\d/ },
  { key: 'account_holder_a_email',   label: 'Account holder A email',
    pattern: /@/ },

  { key: 'account_holder_b_name',    label: 'Account holder B titled full name',
    optional: true },
  { key: 'account_holder_b_mobile',  label: 'Account holder B mobile number',
    optional: true, pattern: /\d/ },
  { key: 'account_holder_b_email',   label: 'Account holder B email',
    optional: true, pattern: /@/ },

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
  return matchedLabel(line) !== null;
}

/**
 * The FIELDS label a line begins with, or null.
 *
 * A line counts as a label line whether it stands alone ('Patient gender:')
 * or carries its value inline ('Patient gender: Male'). Drive's PDF
 * conversion merges some label/value pairs onto one line and leaves others
 * on two, depending on their spacing in the source document, so both forms
 * occur within the same converted file.
 *
 * The character after the label must be a colon, a space, or nothing, so a
 * short label can never match a longer one that merely starts with it.
 */
function matchedLabel(line) {
  var normalised = String(line).toLowerCase().trim();
  var found = null;
  FIELDS.forEach(function (field) {
    if (found !== null) return;
    var target = field.label.toLowerCase().replace(/:$/, '').trim();
    if (normalised.indexOf(target) !== 0) return;
    var after = normalised.charAt(target.length);
    if (after === '' || after === ':' || after === ' ') found = field.label;
  });
  return found;
}

/**
 * Finds a label line and returns the next line, which is its value.
 * Comparison is case-insensitive and tolerates a missing trailing colon.
 */
function findValueForLabel(lines, label) {
  var target = label.toLowerCase().replace(/:$/, '').trim();

  for (var i = 0; i < lines.length; i++) {
    var normalised = lines[i].toLowerCase().trim();
    if (normalised.indexOf(target) !== 0) continue;

    var after = normalised.charAt(target.length);
    if (after !== '' && after !== ':' && after !== ' ') continue;

    // Inline form: 'Label: value' on a single line.
    var remainder = lines[i].trim().slice(target.length).replace(/^\s*:?\s*/, '');
    if (remainder.length > 0) return remainder;

    // Next-line form: the label stands alone and its value is the line after.
    if (i + 1 >= lines.length) return null;
    return isLabelLine(lines[i + 1]) ? null : lines[i + 1];
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
    // A value that cannot be what this field holds is treated as not found.
    if (value !== null && value !== undefined && field.pattern
        && !field.pattern.test(String(value))) {
      value = null;
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
