/**
 * Excludes every terminal label so a message is considered exactly once.
 * The time bound stops the job re-examining the whole mailbox once it has
 * been running for months; nothing older than a week is worth retrying
 * automatically.
 */
function buildSearchQuery() {
  return 'has:attachment filename:pdf'
    + ' -label:' + LABELS.processed
    + ' -label:' + LABELS.partial
    + ' -label:' + LABELS.failed
    + ' -label:' + LABELS.ignored
    + ' newer_than:7d';
}

/** The first PDF attachment on a message, or null. Inline images are ignored. */
function firstPdfAttachment(message) {
  var attachments = message.getAttachments({ includeInlineImages: false });
  for (var i = 0; i < attachments.length; i++) {
    if (attachments[i].getContentType() === 'application/pdf') {
      return attachments[i];
    }
  }
  return null;
}

/**
 * Unprocessed messages carrying a PDF, newest first.
 * Messages without a PDF are skipped silently — ordinary mail will arrive in
 * this mailbox and is not an error.
 */
function findCandidates(maxThreads) {
  var threads = GmailApp.search(buildSearchQuery(), 0, maxThreads || 10);
  var candidates = [];

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      var attachment = firstPdfAttachment(message);
      if (!attachment) return;
      candidates.push({
        thread: thread,
        attachment: attachment,
        from: message.getFrom(),
        messageId: message.getId(),
        receivedAt: message.getDate().toISOString()
      });
    });
  });

  return candidates;
}

function applyLabel(thread, labelName) {
  var label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
  thread.addLabel(label);
}

/**
 * Creates any missing labels up front. Without this the search query
 * references labels that may not exist yet, which Gmail tolerates but which
 * makes the first run harder to reason about.
 */
function ensureLabels() {
  Object.keys(LABELS).forEach(function (key) {
    if (!GmailApp.getUserLabelByName(LABELS[key])) {
      GmailApp.createLabel(LABELS[key]);
    }
  });
}
