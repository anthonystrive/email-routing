/**
 * Per-message processing record: the single source of truth for what has
 * already been handled.
 *
 * Thread labels cannot serve this purpose. Gmail groups these same-subject,
 * same-sender bookings into one conversation, so any thread-scoped exclusion
 * hides every later booking in that thread — silently, with no error and no
 * count. Labels remain for human visibility only; this store is what decides
 * whether a message is processed.
 *
 * Values are `timestamp|outcome` so a re-seen message can be relabelled with
 * the outcome it actually earned, rather than being assumed successful.
 *
 * Entries are pruned past the search window, so the store stays small.
 */
var SEEN_PREFIX = 'seen:';
var SEEN_TTL_MS = 8 * 24 * 60 * 60 * 1000;

/** The stored outcome label for a message, or null if never processed. */
function getSeenOutcome(messageId) {
  var raw = PropertiesService.getScriptProperties()
    .getProperty(SEEN_PREFIX + messageId);
  if (raw === null || raw === undefined) return null;
  var separator = String(raw).indexOf('|');
  if (separator === -1) return null;
  var outcome = String(raw).slice(separator + 1);
  return outcome.length > 0 ? outcome : null;
}

/** Records the outcome a message earned. Call only after the outcome is final. */
function markSeen(messageId, outcome) {
  PropertiesService.getScriptProperties()
    .setProperty(SEEN_PREFIX + messageId, String(Date.now()) + '|' + String(outcome));
}

/** Drops records past the search window so the store cannot grow without bound. */
function pruneSeen() {
  var properties = PropertiesService.getScriptProperties();
  var all = properties.getProperties();
  var cutoff = Date.now() - SEEN_TTL_MS;
  Object.keys(all).forEach(function (key) {
    // This guard is the only thing standing between this sweep and the live
    // configuration: ZAPIER_HOOK_URL, SENDER_ALLOWLIST and SUMMARY_TO live in
    // the same script-property store. Invert it and the deploy deletes itself.
    if (key.indexOf(SEEN_PREFIX) !== 0) return;
    var value = String(all[key]);
    var separator = value.indexOf('|');
    // A malformed record has no readable timestamp and can never expire on its
    // own, so drop it now rather than keep it forever.
    if (separator === -1) {
      properties.deleteProperty(key);
      return;
    }
    var stamp = Number(value.slice(0, separator));
    if (isNaN(stamp)) {
      properties.deleteProperty(key);
      return;
    }
    if (stamp < cutoff) properties.deleteProperty(key);
  });
}
