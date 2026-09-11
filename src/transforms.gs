/**
 * Australian day-first date to ISO. '2/9/2026' is 2 September 2026.
 *
 * Round-trips through Date.UTC to reject dates that match the pattern but do
 * not exist, such as 31/2. Returns null rather than throwing so one bad
 * field does not cost the whole record.
 */
function auDateToIso(value) {
  if (value === null || value === undefined) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value).trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
  if (!valid) return null;

  return String(year).padStart(4, '0')
    + '-' + String(month).padStart(2, '0')
    + '-' + String(day).padStart(2, '0');
}

/**
 * 12-hour time to a single canonical form: 'H:MM am' / 'H:MM pm'.
 *
 * The source separates the time from its meridiem with a narrow no-break
 * space, which text.gs has already collapsed to an ordinary space by the
 * time this runs. The optional space here covers the case where it has not.
 */
function normaliseTime(value) {
  if (value === null || value === undefined) return null;
  const match = /^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?$/i.exec(String(value).trim());
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;

  return hour + ':' + String(minute).padStart(2, '0') + ' ' + match[3].toLowerCase() + 'm';
}

/**
 * MBS item numbers for referral items, in the order they are applied.
 *
 * A table rather than a rule per item so a new referral type is one line
 * here and nothing else. Anything absent from it passes through unchanged,
 * which is what keeps an unrecognised referral readable rather than dropped.
 *
 * The negative lookahead makes the substitution idempotent: a document that
 * already names the item number, or a value this transform has already seen,
 * does not come out as 'OPG (Item 57966) (Item 57966)'.
 */
var REFERRAL_ITEMS = [
  { pattern: /\bOPG\b(?!\s*\(Item)/gi, number: '57966' }
];

/**
 * Referral text with each known item's MBS number appended to it.
 *
 * Substitutes WITHIN the value rather than matching it whole, because both
 * template layouts reach this transform: the September 2026 template lists
 * one item per line, so this sees 'OPG' alone, while documents predating it
 * emit a single merged 'OPG + Lateral Cephalogram'. Matching the whole value
 * would number the first and silently miss the second — and since extract.gs
 * applies a transform per collected line and only then joins them, both
 * layouts must produce byte-identical output or the same booking would
 * deliver differently depending on which template produced it.
 *
 * Returns null for an absent value, as every transform here does.
 */
function appendReferralItemNumbers(value) {
  if (value === null || value === undefined) return null;

  var text = String(value);
  REFERRAL_ITEMS.forEach(function (item) {
    text = text.replace(item.pattern, function (match) {
      return match + ' (Item ' + item.number + ')';
    });
  });
  return text;
}
