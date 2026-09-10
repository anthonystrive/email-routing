/**
 * Bumped by hand whenever FIELDS changes, so a downstream consumer can tell
 * which ruleset produced a given record.
 */
var EXTRACTOR_VERSION = '1.4.0';

/**
 * The only place in this system that knows anything about the source
 * document. When the template changes, this table is what changes.
 *
 * `optional: true` means absence is expected and does not count against the
 * record's completeness. Three fields carry it, for two different reasons.
 * Account holder B is a safeguard — most bookings have only one account
 * holder, and without `optional` every single record would report as
 * incomplete. The postal address and the referral are optional because the
 * September 2026 template added the first and made the second conditional:
 * documents predating it carry no postal address label at all, and a booking
 * that needs no imaging carries no referral. Counting either would report a
 * daily partial count for fields that were never in the document, and a
 * summary reporting an expected number every morning is one nobody reads.
 * The cost is that a genuinely dropped address or referral no longer raises
 * a flag — revisit once old-template documents have stopped arriving.
 *
 * `pattern` is a shape check, not a format validator. isLabelLine only knows
 * the 14 labels below, so a label emitted with a blank value followed by
 * document boilerplate (a footer, a title, 'Page 1 of 1') would take that
 * line as its value and still report complete — a wrong value is worse than
 * a null, because downstream cannot detect it. A value failing its pattern is
 * nulled, which routes it into missing_fields and pdf-partial exactly as a
 * failed transform does. Kept deliberately loose: the goal is rejecting
 * obvious boilerplate, not validating addresses or phone numbers.
 *
 * `multiline: true` means the value may run over several consecutive lines,
 * and collection continues until the next label or the end of the document.
 * The September 2026 template revision made this true of two fields: Account
 * holder A now lists one email address per line (one to three across the
 * sample documents), and Needs referral for lists one item per line where it
 * previously emitted a single '+'-joined string. Without it only the first
 * line survives — silently, since a short list is indistinguishable from a
 * complete one downstream. `pattern` is applied per line, so a stray footer
 * among the addresses is dropped without costing the addresses either side.
 *
 * `separator` splits a collected line into several values. Drive's converter
 * merges lines as readily as it merges label/value pairs, so the addresses
 * that occupy one line each in the PDF can arrive on a single line — and
 * collected whole, both travel in one field, which a receiving system rejects
 * as not an email. Only a field that declares a separator is split: a name and
 * a mobile number both contain spaces and must survive intact, and a postal
 * address carries commas that are structure rather than separators — split on
 * them, '34 Sample Street, Sampleton, VIC 3000' becomes three fragments no
 * delivery system can use.
 *
 * `extraKey` names a second record key holding every value AFTER the first,
 * joined with ', '. The field's own key keeps the first — the primary address
 * — so a consumer reading `account_holder_a_email` as a string is unaffected,
 * and the extras are a single string a Zap step can drop straight into a CC
 * line. The primary is deliberately absent from it: repeated in both, a Zap
 * mailing each in turn writes to the same person twice. Null, not an empty
 * string, when there are no extras, so it reads like every other absent value
 * in the record. `join` instead
 * folds the collected lines into one string — ' + ' for the referral, which
 * reproduces exactly the single-line form the old template produced, so the
 * derived booleans and any downstream string matching carry on unchanged.
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
    pattern: /@/, multiline: true, separator: /[\s,;]+/,
    extraKey: 'account_holder_a_emails' },

  { key: 'account_holder_a_postal_address',
    label: 'Account holder A postal address',
    optional: true, pattern: /\d/ },

  { key: 'account_holder_b_name',    label: 'Account holder B titled full name',
    optional: true },
  { key: 'account_holder_b_mobile',  label: 'Account holder B mobile number',
    optional: true, pattern: /\d/ },
  { key: 'account_holder_b_email',   label: 'Account holder B email',
    optional: true, pattern: /@/, multiline: true, separator: /[\s,;]+/,
    extraKey: 'account_holder_b_emails' },

  { key: 'needs_referral_for',       label: 'Needs referral for',
    optional: true, multiline: true, join: ' + ' },
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
 * Every line belonging to a label, in document order.
 *
 * Returns [] when the label is absent or carries no value, so a caller never
 * has to distinguish "not found" from "found but empty" — both are nothing.
 *
 * Comparison is case-insensitive and tolerates a missing trailing colon. Both
 * of the converter's forms are handled: an inline 'Label: value', and a label
 * standing alone with its value on the line after. A field may be both — when
 * Drive merges the label with the first of several values, the remaining
 * lines still follow — so for a `multiline` field the inline remainder is the
 * first item and collection continues from the next line.
 *
 * Collection stops at the next label or the end of the document. Blank lines
 * never reach here: `toLines` drops them, which is what lets the referral
 * block survive the empty line the template leaves between it and its label
 * on some documents.
 */
function collectValuesForLabel(lines, label, multiline) {
  var target = label.toLowerCase().replace(/:$/, '').trim();

  for (var i = 0; i < lines.length; i++) {
    var normalised = lines[i].toLowerCase().trim();
    if (normalised.indexOf(target) !== 0) continue;

    var after = normalised.charAt(target.length);
    if (after !== '' && after !== ':' && after !== ' ') continue;

    var values = [];

    // Inline form: 'Label: value' on a single line.
    var remainder = lines[i].trim().slice(target.length).replace(/^\s*:?\s*/, '');
    if (remainder.length > 0) values.push(remainder);

    // Next-line form. A single-value field takes one line and stops; a
    // multiline field keeps going until the next label ends its block.
    if (values.length === 0 || multiline) {
      for (var j = i + 1; j < lines.length; j++) {
        if (isLabelLine(lines[j])) break;
        values.push(lines[j]);
        if (!multiline) break;
      }
    }

    return values;
  }

  return [];
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
    const collected = collectValuesForLabel(lines, field.label, field.multiline === true);

    // One line can hold several values where the converter merged them.
    const parts = field.separator
      ? collected.reduce(function (all, line) {
          return all.concat(String(line).split(field.separator));
        }, [])
      : collected;

    // Transform and screen line by line. A single-value field has at most one
    // line here, so this is the original behaviour; for a multiline field it
    // is what keeps one unreadable line from costing the whole list.
    const values = parts
      .map(function (line) {
        return field.transform ? field.transform(line) : line;
      })
      .filter(function (value) {
        if (value === null || value === undefined || value === '') return false;
        // A value that cannot be what this field holds is treated as not found.
        return !field.pattern || field.pattern.test(String(value));
      });

    record[field.key] = values.length === 0 ? null
      : (field.join ? values.join(field.join) : values[0]);

    // Everything after the primary, as one string. Null when there is nothing
    // beyond the primary, matching how every other absent value is reported.
    if (field.extraKey) {
      var extra = values.slice(1);
      record[field.extraKey] = extra.length > 0 ? extra.join(', ') : null;
    }
  });

  // Derived by substring rather than by matching the three known values
  // exactly, so a fourth combination appearing later still yields correct
  // booleans. The raw string always passes through unchanged alongside them.
  const referral = record.needs_referral_for;
  record.needs_opg = referral ? /OPG/i.test(referral) : false;
  record.needs_lateral_ceph = referral ? /lateral\s+cephalogram/i.test(referral) : false;

  return record;
}
