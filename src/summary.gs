function buildSummaryQuery(labelName) {
  return 'label:' + labelName + ' newer_than:1d';
}

/**
 * Emails a count of yesterday's failures, partials and ignored messages.
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
  var failed = GmailApp.search(buildSummaryQuery(LABELS.failed)).length;
  var partial = GmailApp.search(buildSummaryQuery(LABELS.partial)).length;
  var ignored = GmailApp.search(buildSummaryQuery(LABELS.ignored)).length;

  if (failed === 0 && partial === 0 && ignored === 0) return;

  var recipient = getSummaryRecipient();
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
