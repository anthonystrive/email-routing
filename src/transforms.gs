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
