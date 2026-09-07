/**
 * Reports extraction quality. Never blocks delivery — a partial record is a
 * normal outcome, and the caller decides what to do about it.
 *
 * `optional` fields are excluded from `missing_fields` and from `complete`.
 * Account holder B is absent on most bookings; counting it would mark every
 * record incomplete and render the flag useless.
 *
 * `empty` means nothing at all matched, including optional fields. That is
 * the one case the caller treats as a failure.
 */
function assessExtraction(record) {
  var missing = [];
  var populated = 0;

  FIELDS.forEach(function (field) {
    var value = record[field.key];
    var present = value !== null && value !== undefined;
    if (present) {
      populated++;
    } else if (!field.optional) {
      missing.push(field.key);
    }
  });

  return {
    missing_fields: missing,
    complete: missing.length === 0,
    empty: populated === 0
  };
}

/**
 * Assembles the flat JSON delivered to the webhook.
 *
 * Every extracted key passes through unchanged, including nulls — downstream
 * Zap steps break on absent keys, not on null values. `_meta` carries the
 * provenance and extraction quality that make a bad parse debuggable weeks
 * later.
 *
 * Flat apart from `_meta`, with one exception: a field whose value is
 * genuinely a list arrives as an array of strings, which a Catch Hook exposes
 * as line items. Nested objects remain out — a Zap step maps a value, not a
 * structure. `account_holder_a_emails` is the only such key today, and the
 * scalar `account_holder_a_email` still holds the first address beside it, so
 * a step written before the template listed several keeps working.
 */
function buildPayload(record, context) {
  var assessment = assessExtraction(record);
  var payload = {};

  Object.keys(record).forEach(function (key) {
    payload[key] = record[key];
  });

  payload._meta = {
    message_id: context.messageId,
    // The bare address, not the raw header. The data contract specifies
    // 'sender@example.com', and a downstream Zap filtering on the sender
    // should not have to parse 'Tops Ortho <sender@example.com>' itself.
    from: extractEmailAddress(context.from),
    received_at: context.receivedAt,
    extractor_version: EXTRACTOR_VERSION,
    complete: assessment.complete,
    missing_fields: assessment.missing_fields
  };

  return payload;
}
