/**
 * Excludes only the labels a human triages, NOT the successful ones.
 *
 * Gmail labels are per THREAD, and these bookings share a subject and sender,
 * which is exactly what Gmail groups into one conversation. Excluding
 * pdf-processed or pdf-partial would therefore hide every later booking in a
 * thread whose first booking already succeeded — enumerated never, processed
 * never, counted never. That is a silent total loss, so those two exclusions
 * are deliberately absent. Redelivery is prevented instead by the
 * delivered-message set in dedupe.gs, which is keyed per message.
 *
 * The cost is that an already-processed thread re-enumerates every tick: one
 * script-property lookup per message, and no PDF conversion, because
 * processOne returns before any work as soon as the message is known
 * delivered.
 *
 * pdf-failed and pdf-ignored stay excluded. Those are terminal states a human
 * triages — retrying them automatically every minute would just burn quota.
 *
 * The time bound stops the job re-examining the whole mailbox once it has
 * been running for months; nothing older than a week is worth retrying
 * automatically.
 */
function buildSearchQuery() {
  return 'has:attachment filename:pdf'
    + ' -label:' + LABELS.failed
    + ' -label:' + LABELS.ignored
    + ' newer_than:7d';
}

/**
 * The first PDF attachment on a message, or null. Inline images are ignored.
 *
 * The filename is accepted as evidence alongside the content type, because
 * real senders label .pdf files application/octet-stream and
 * application/x-pdf. Requiring application/pdf exactly meant such a message
 * yielded no candidate at all — so its thread was never labelled and the
 * booking vanished with no signal anywhere.
 */
function firstPdfAttachment(message) {
  var attachments = message.getAttachments({ includeInlineImages: false });
  for (var i = 0; i < attachments.length; i++) {
    var contentType = attachments[i].getContentType();
    var name = attachments[i].getName() || '';
    if (contentType === 'application/pdf' || /\.pdf$/i.test(name)) {
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
