function buildSummaryQuery(labelName) {
  return 'label:' + labelName + ' newer_than:1d';
}

/**
 * Emails the account owner a count of yesterday's failures and partials.
 *
 * Sends nothing when both counts are zero — a daily "all clear" trains you
 * to ignore the message, which defeats the purpose.
 */
function sendDailySummary() {
  var failed = GmailApp.search(buildSummaryQuery(LABELS.failed)).length;
  var partial = GmailApp.search(buildSummaryQuery(LABELS.partial)).length;

  if (failed === 0 && partial === 0) return;

  var owner = Session.getEffectiveUser().getEmail();
  var body = 'In the last 24 hours:\n\n'
    + '  Failed:  ' + failed + '\n'
    + '  Partial: ' + partial + '\n\n'
    + 'Search Gmail for label:' + LABELS.failed
    + ' or label:' + LABELS.partial + ' to review them.\n\n'
    + 'A rising partial count usually means the source template changed and '
    + 'a label in FIELDS no longer matches.';

  GmailApp.sendEmail(owner, 'PDF routing: ' + failed + ' failed, ' + partial + ' partial', body);
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
