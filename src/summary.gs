var SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The Gmail search a reader runs by hand to LOOK AT the affected messages.
 * It is no longer how the summary COUNTS them — see sendDailySummary.
 */
function buildSummaryQuery(labelName) {
  return 'label:' + labelName + ' newer_than:1d';
}

/**
 * Emails a count of yesterday's failures, partials and ignored messages.
 *
 * Counts come from the dedupe store, not from Gmail. Searching `label:X
 * newer_than:1d` counts THREADS, and labels are per thread and never removed:
 * these same-subject bookings all land in one conversation, so every count was
 * 0 or 1 whatever the volume — one old failure reported "Failed: 1" every day
 * forever, and twenty failures in a day also reported 1. The store holds one
 * timestamped outcome per MESSAGE, so countSeenSince is exact.
 *
 * Sends nothing when all three counts are zero — a daily "all clear" trains
 * you to ignore the message, which defeats the purpose.
 *
 * Ignored is counted because it is the one outcome that looks like silence.
 * A wrong allowlist entry, or a change in the sender's From format, labels
 * every booking pdf-ignored — and a summary counting only failed and partial
 * would stay quiet at exactly the moment the system is dropping everything.
 */
function sendDailySummary() {
  // Resolved first, before the searches and before the all-clear early
  // return. A missing SUMMARY_TO throws on the very first summary run, when
  // someone is still watching the deploy — rather than lying dormant until
  // the first day something actually needs reporting, which is the one day
  // the summary must not fail.
  var recipient = getSummaryRecipient();

  var counts = countSeenSince(SUMMARY_WINDOW_MS);
  var failed = counts[LABELS.failed] || 0;
  var partial = counts[LABELS.partial] || 0;
  var ignored = counts[LABELS.ignored] || 0;

  if (failed === 0 && partial === 0 && ignored === 0) return;

  var body = 'In the last 24 hours:\n\n'
    + '  Failed:  ' + failed + '\n'
    + '  Partial: ' + partial + '\n'
    + '  Ignored: ' + ignored + '\n\n'
    + 'Search Gmail for label:' + LABELS.failed
    + ', label:' + LABELS.partial
    + ' or label:' + LABELS.ignored + ' to review them.\n\n'
    + 'A rising partial count usually means the source template changed and '
    + 'a label in FIELDS no longer matches.\n\n'
    + 'A non-zero ignored count usually means the sender address or its From '
    + 'format changed, so SENDER_ALLOWLIST no longer matches — those bookings '
    + 'were not delivered anywhere.';

  GmailApp.sendEmail(recipient,
    'PDF routing: ' + failed + ' failed, ' + partial + ' partial, '
      + ignored + ' ignored',
    body);
}

function installSummaryTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'sendDailySummary') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('sendDailySummary').timeBased().atHour(7).everyDays(1).create();
  console.log('Summary trigger installed: sendDailySummary daily at ~07:00.');
}
