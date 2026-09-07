/**
 * No label exclusions at all. This is deliberate — do not add one back.
 *
 * Gmail labels are per THREAD, and these bookings share a subject and sender,
 * which is exactly what Gmail groups into one conversation. ANY `-label:`
 * term therefore hides every later booking in a thread that already carries
 * that label — enumerated never, processed never, counted never. That is
 * silent total loss, and it applies just as much to the terminal labels
 * (pdf-failed, pdf-ignored) as to the successful ones: one ignored booking
 * would permanently mute the conversation it arrived in. "Restoring" any of
 * these exclusions reintroduces exactly that silent loss.
 *
 * The exclusion is the per-message store in dedupe.gs instead. It is keyed by
 * Gmail message id, so it can never hide a sibling message, and findCandidates
 * consults it before touching an attachment, which keeps the per-tick cost of
 * an already-processed thread to one script-property lookup per message.
 *
 * The time bound stops the job re-examining the whole mailbox once it has
 * been running for months; nothing older than a week is worth retrying
 * automatically.
 */
function buildSearchQuery() {
  return 'has:attachment filename:pdf newer_than:7d';
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
      // Order matters — do not reorder these two lines. The query no longer
      // excludes any label, so every already-processed thread re-enumerates
      // every tick. getId() is free on a message already fetched with the
      // thread; getAttachments() is a separate attachment fetch billed against
      // the daily Gmail quota. Skipping seen messages FIRST is what keeps the
      // per-tick cost flat instead of growing with the mailbox.
      var messageId = message.getId();
      if (getSeenOutcome(messageId) !== null) return;
      var attachment = firstPdfAttachment(message);
      if (!attachment) return;
      candidates.push({
        thread: thread,
        attachment: attachment,
        from: message.getFrom(),
        messageId: messageId,
        receivedAt: message.getDate().toISOString()
      });
    });
  });

  return candidates;
}

/**
 * One candidate built from a nominated message id, bypassing the seen store.
 *
 * findCandidates deliberately drops messages already recorded as seen — that
 * filter is what stops the trigger reprocessing them. Inspecting one of those
 * therefore used to mean deleting its seen record, which hands the message
 * straight back to the trigger for a duplicate delivery. Reading the message
 * directly leaves the record, and so the delivery guarantee, untouched.
 *
 * Returns `{ candidate, problem }`. `problem` distinguishes an id that cannot
 * be resolved from a message that simply carries no PDF, because those need
 * different answers from the caller. GmailApp throws rather than returning
 * null for an unknown id, so that is caught here.
 */
function candidateForMessageId(messageId) {
  var message;
  try {
    message = GmailApp.getMessageById(messageId);
  } catch (err) {
    return { candidate: null, problem: 'unreadable' };
  }
  if (!message) return { candidate: null, problem: 'unreadable' };

  var attachment = firstPdfAttachment(message);
  if (!attachment) return { candidate: null, problem: 'no-pdf' };

  // Deliberately the same shape findCandidates produces, so a candidate is a
  // candidate wherever it came from.
  return {
    candidate: {
      thread: message.getThread(),
      attachment: attachment,
      from: message.getFrom(),
      messageId: message.getId(),
      receivedAt: message.getDate().toISOString()
    },
    problem: null
  };
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
