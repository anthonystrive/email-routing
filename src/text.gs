/**
 * Unicode normalisation for text extracted from the source PDF.
 *
 * NFKC folds compatibility characters — critically the `fi` ligature
 * (U+FB01) that MacRomanEncoding produces for the word "first" — into their
 * plain ASCII equivalents. The explicit whitespace pass then catches every
 * space separator, including the narrow no-break space (U+202F) that
 * separates the appointment time from its meridiem.
 *
 * The zero-width space (U+200B) and byte order mark (U+FEFF) are in the class
 * too. Neither is folded by NFKC and neither is visible, so one sitting
 * inside a label would break the match with nothing to see in the output.
 * Both collapse to a space, which toLines then trims away.
 */
function normaliseText(raw) {
  if (raw === null || raw === undefined) return '';
  let text = String(raw).normalize('NFKC');
  text = text.replace(/[\u00a0\u1680\u2000-\u200a\u200b\u202f\u205f\u3000\ufeff]/g, ' ');
  text = text.replace(/\r\n?/g, '\n');
  return text;
}

/**
 * Normalised text as a list of non-empty, trimmed lines.
 *
 * Dropping empty lines is what makes label/value pairing work: the value is
 * always the next line with content on it, however the converter spaced the
 * document out.
 */
function toLines(raw) {
  return normaliseText(raw)
    .split('\n')
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line.length > 0; });
}
