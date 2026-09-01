/**
 * Idempotency for delivery, keyed by Gmail message id.
 *
 * Thread labels cannot serve this purpose: Gmail groups these same-subject,
 * same-sender bookings into one conversation, so a thread label would hide
 * every booking after the first. Labels remain, but only as human-visible
 * status — this set is what actually prevents a second delivery.
 *
 * Entries are pruned past the search window, so the store stays small.
 */
var DELIVERED_PREFIX = 'sent:';
var DELIVERED_TTL_MS = 8 * 24 * 60 * 60 * 1000;

function hasDelivered(messageId) {
  return PropertiesService.getScriptProperties()
    .getProperty(DELIVERED_PREFIX + messageId) !== null;
}

function markDelivered(messageId) {
  PropertiesService.getScriptProperties()
    .setProperty(DELIVERED_PREFIX + messageId, String(Date.now()));
}

/** Drops records older than the search window so the store cannot grow without bound. */
function pruneDelivered() {
  var properties = PropertiesService.getScriptProperties();
  var all = properties.getProperties();
  var cutoff = Date.now() - DELIVERED_TTL_MS;
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(DELIVERED_PREFIX) !== 0) return;
    var stamp = Number(all[key]);
    if (!isNaN(stamp) && stamp < cutoff) properties.deleteProperty(key);
  });
}
