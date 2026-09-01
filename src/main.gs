/**
 * Outcome labels from least to most serious.
 *
 * Built inside the function, not at load time. A top-level `LABELS.ignored`
 * here would be dereferenced when this file is evaluated, which only works
 * while config.gs happens to sort before main.gs — and Apps Script's file
 * order is not version-controlled. Resolving it at call time removes the
 * dependency on load order entirely.
 */
function outcomeSeverity() {
  return [LABELS.ignored, LABELS.processed, LABELS.partial, LABELS.failed];
}

/** The more serious of two outcome labels, so one bad message marks the thread. */
function worseOutcome(a, b) {
  if (!a) return b;
  if (!b) return a;
  var order = outcomeSeverity();
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/**
 * Trigger entry point. Runs every minute.
 *
 * The script lock keeps a slow run from overlapping the next one, but it is
 * not what guarantees single delivery: the execution time limit is a hard
 * kill that does not run `finally`, so a timeout mid-batch would otherwise
 * redeliver everything already sent. The delivered-message set in dedupe.gs
 * is written the instant each POST succeeds, and that is what makes a second
 * delivery impossible.
 *
 * Labels are applied per thread, after every message in that thread has been
 * processed. They are human-visible status only — a thread label cannot be
 * the idempotency key, because Gmail groups these same-subject bookings into
 * one conversation and the label would hide every booking after the first.
 */
function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log('Another run holds the lock; skipping this tick.');
    return;
  }

  try {
    ensureLabels();
    pruneDelivered();
    var hookUrl = getHookUrl();
    var allowlist = getAllowlist();
    var candidates = findCandidates(10);

    if (candidates.length > 0) {
      console.log('Processing ' + candidates.length + ' candidate message(s).');
    }

    var byThread = {};
    var unexpectedFailures = 0;
    candidates.forEach(function (candidate) {
      var outcome;
      try {
        outcome = processOne(candidate, hookUrl, allowlist);
      } catch (err) {
        // processOne guards its own known failure modes; this catches the
        // unexpected ones so a single bad message cannot abandon the whole
        // batch mid-flight, leaving delivered messages unlabelled.
        console.error('Unexpected failure processing ' + candidate.messageId + ': ' + err);
        unexpectedFailures++;
        outcome = LABELS.failed;
      }
      var id = candidate.thread.getId();
      if (!byThread[id]) {
        byThread[id] = { thread: candidate.thread, label: outcome };
      } else {
        byThread[id].label = worseOutcome(byThread[id].label, outcome);
      }
    });

    Object.keys(byThread).forEach(function (id) {
      try {
        applyLabel(byThread[id].thread, byThread[id].label);
      } catch (err) {
        // An unlabelled thread loses its human-visible status and will be
        // re-enumerated next tick, but its delivered messages are already in
        // the delivered set and will not be sent again. Counting it as an
        // unexpected failure is what makes it alert rather than sit in a log
        // nobody reads.
        console.error('Failed to label thread ' + id
          + ' as ' + byThread[id].label + ': ' + err);
        unexpectedFailures++;
      }
    });

    // Nothing will be re-delivered — deliveries are recorded per message as
    // they succeed. But an unexpected exception means a bug, not a bad
    // document, and swallowing it would cost us Apps Script's own
    // failed-trigger email to the owner — the only alert that does not
    // require someone to go and read Cloud Logging. A systemic fault would
    // otherwise mark every booking pdf-failed in silence, and pdf-failed
    // threads are never retried.
    if (unexpectedFailures > 0) {
      throw new Error(unexpectedFailures + ' message(s) failed unexpectedly this run; '
        + 'see the preceding log lines. Delivered messages are recorded, so '
        + 'nothing will be re-delivered.');
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * One message, start to finish. Returns the label its thread has earned —
 * it does NOT apply it, because a thread may hold several messages and the
 * label must reflect all of them.
 */
function processOne(candidate, hookUrl, allowlist) {
  if (hasDelivered(candidate.messageId)) {
    // Already delivered on an earlier run whose labelling did not complete.
    // Re-labelling is safe and idempotent; re-delivering is not.
    return LABELS.processed;
  }

  if (!isAllowedSender(candidate.from, allowlist)) {
    console.log('Ignoring message from unlisted sender: ' + candidate.from);
    return LABELS.ignored;
  }

  var text;
  try {
    text = pdfToText(candidate.attachment.copyBlob());
  } catch (err) {
    console.error('PDF conversion failed for ' + candidate.messageId + ': ' + err);
    return LABELS.failed;
  }

  var record = extractFields(text);
  var assessment = assessExtraction(record);

  if (assessment.empty) {
    // Not one field matched. The document text is NOT logged: the case this
    // branch exists to catch is template drift, where the document IS a real
    // booking whose labels stopped matching — so its text is patient data,
    // and the execution log is a wider boundary than the mailbox. These two
    // signals separate the likely causes without exposing anything: the
    // title present means the template changed; absent means a different
    // document arrived.
    console.error('No fields matched for ' + candidate.messageId
      + ' (extracted ' + text.length + ' characters, expected title '
      + (text.indexOf('New Patient Booking Activation') !== -1 ? 'present' : 'absent')
      + '). Open the message in Gmail to inspect the document.');
    return LABELS.failed;
  }

  var payload = buildPayload(record, candidate);
  var result = deliverPayload(payload, hookUrl);

  if (!result.ok) {
    console.error('Delivery failed for ' + candidate.messageId
      + ' after ' + result.attempts + ' attempt(s), status ' + result.status
      + (result.error ? ', error: ' + result.error : ''));
    return LABELS.failed;
  }

  // Recorded the instant delivery succeeds, before anything that could throw
  // or time out. Everything after this point is labelling and logging, none
  // of which is allowed to cost a second POST.
  markDelivered(candidate.messageId);

  if (assessment.complete) {
    return LABELS.processed;
  }

  console.log('Delivered partial record for ' + candidate.messageId
    + '; missing: ' + assessment.missing_fields.join(', '));
  return LABELS.partial;
}

/**
 * Processes one thread on demand. Run this from the Apps Script editor during
 * setup, with ZAPIER_HOOK_URL pointed at a request-capture endpoint rather
 * than the live Zap.
 *
 * findCandidates bounds THREADS, not messages, so a single thread can yield
 * several candidates. Every one of them is processed and the worst outcome
 * applied once — processing only the first would label the thread and make
 * its remaining messages invisible to every later run.
 */
function runOnce() {
  ensureLabels();
  pruneDelivered();
  var candidates = findCandidates(1);
  if (candidates.length === 0) {
    console.log('No candidate messages found.');
    return;
  }

  var hookUrl = getHookUrl();
  var allowlist = getAllowlist();
  console.log('Processing ' + candidates.length + ' candidate message(s) '
    + 'from one thread.');

  var byThread = {};
  candidates.forEach(function (candidate) {
    console.log('Processing message ' + candidate.messageId);
    var outcome = processOne(candidate, hookUrl, allowlist);
    console.log('Outcome for ' + candidate.messageId + ': ' + outcome);
    var id = candidate.thread.getId();
    if (!byThread[id]) {
      byThread[id] = { thread: candidate.thread, label: outcome };
    } else {
      byThread[id].label = worseOutcome(byThread[id].label, outcome);
    }
  });

  Object.keys(byThread).forEach(function (id) {
    applyLabel(byThread[id].thread, byThread[id].label);
    console.log('Labelled thread ' + id + ' as ' + byThread[id].label + '.');
  });
}

/**
 * Installs the minute-by-minute trigger, removing any existing one first so
 * running this twice does not double the processing rate.
 */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'processInbox') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(1).create();
  console.log('Trigger installed: processInbox every 1 minute.');
}
