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
 * redeliver everything already sent. The seen store in dedupe.gs is written
 * the instant each outcome is final, and that is what makes a second delivery
 * impossible.
 *
 * Labels are applied per thread, after every message in that thread has been
 * processed. They are human-visible status only — a thread label cannot be
 * the idempotency key, because Gmail groups these same-subject bookings into
 * one conversation and the label would hide every booking after the first.
 *
 * ensureLabels() is deliberately NOT called here. It costs four Gmail label
 * lookups, and at one run a minute that is 5,760 operations a day spent
 * re-confirming labels that already exist — enough, on top of the search and
 * attachment traffic, to push a consumer account past its 20,000/day Gmail
 * quota, at which point GmailApp.search throws and nothing is processed for
 * the rest of the day. The labels are created by installTrigger (before the
 * trigger can ever fire) and by the manual entry points, and applyLabel
 * creates a missing label on demand, so nothing here depends on it.
 */
function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log('Another run holds the lock; skipping this tick.');
    return;
  }

  try {
    pruneSeen();
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
        // batch mid-flight, leaving processed messages unlabelled.
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

    // Every thread that produced a candidate is labelled. There is no
    // "did we actually do work?" flag because there is nothing for it to
    // decide: findCandidates already drops messages the seen store knows
    // about, so a thread whose messages have all been handled yields no
    // candidates and never reaches this loop. That filter — not a flag here —
    // is what stops handled threads being relabelled every tick.
    Object.keys(byThread).forEach(function (id) {
      try {
        applyLabel(byThread[id].thread, byThread[id].label);
      } catch (err) {
        // An unlabelled thread loses its human-visible status, but its
        // messages are already recorded in the seen store and will not be
        // reprocessed. Counting it as an unexpected failure is what makes it
        // alert rather than sit in a log nobody reads.
        console.error('Failed to label thread ' + id
          + ' as ' + byThread[id].label + ': ' + err);
        unexpectedFailures++;
      }
    });

    // Nothing will be re-delivered — outcomes are recorded per message as
    // soon as they are final. But an unexpected exception means a bug, not a
    // bad document, and swallowing it would cost us Apps Script's own
    // failed-trigger email to the owner — the only alert that does not
    // require someone to go and read Cloud Logging. A systemic fault would
    // otherwise mark every booking pdf-failed in silence.
    if (unexpectedFailures > 0) {
      throw new Error(unexpectedFailures + ' message(s) failed unexpectedly this run; '
        + 'see the preceding log lines. Completed messages are recorded, so '
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
  var seen = getSeenOutcome(candidate.messageId);
  if (seen !== null) {
    // Already reached a final outcome on an earlier run whose labelling did
    // not complete. Return the outcome it actually earned — assuming success
    // here would relabel a failed or ignored message pdf-processed and hide a
    // real problem.
    return seen;
  }

  if (!isAllowedSender(candidate.from, allowlist)) {
    // Terminal, and recorded per message. Recording is what keeps this
    // decision message-scoped: the alternative — leaning on a thread label —
    // would mute every future booking in this conversation.
    console.log('Ignoring message from unlisted sender: ' + candidate.from);
    markSeen(candidate.messageId, LABELS.ignored);
    return LABELS.ignored;
  }

  var text;
  try {
    text = pdfToText(candidate.attachment.copyBlob());
  } catch (err) {
    // Terminal: a document this converter cannot read will not read on the
    // next tick either, and retrying it every minute burns quota. Recorded so
    // the retry stops at this message, not this conversation.
    console.error('PDF conversion failed for ' + candidate.messageId + ': ' + err);
    markSeen(candidate.messageId, LABELS.failed);
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
    markSeen(candidate.messageId, LABELS.failed);
    return LABELS.failed;
  }

  var payload = buildPayload(record, candidate);
  var result = deliverPayload(payload, hookUrl);

  if (!result.ok) {
    // Terminal after deliverPayload's own retries: this is a human's problem
    // (a dead hook URL, a rejected payload), not something another tick will
    // fix. Recorded so it stays a message-scoped failure and its thread keeps
    // accepting later bookings.
    console.error('Delivery failed for ' + candidate.messageId
      + ' after ' + result.attempts + ' attempt(s), status ' + result.status
      + (result.error ? ', error: ' + result.error : ''));
    markSeen(candidate.messageId, LABELS.failed);
    return LABELS.failed;
  }

  var outcome = assessment.complete ? LABELS.processed : LABELS.partial;

  // Recorded the instant delivery succeeds, before anything that could throw
  // or time out. Everything after this point is labelling and logging, none
  // of which is allowed to cost a second POST.
  //
  // The write is guarded because it can fail on its own — the script property
  // store has a 500 KB cap, and PropertiesService has transient faults. Once
  // the POST has landed, failing to record is strictly better than re-throwing:
  // a throw here escapes processOne into the unexpected-failure path, which
  // deliberately leaves the message unrecorded, and every subsequent tick then
  // re-delivers a record the webhook already has. An unrecorded delivery may be
  // repeated once we get here whatever we do; re-throwing guarantees it repeats
  // every minute until the store recovers. So: log loudly and return normally.
  try {
    markSeen(candidate.messageId, outcome);
  } catch (err) {
    console.error('DELIVERED BUT NOT RECORDED: ' + candidate.messageId
      + ' was POSTed successfully, but writing its outcome (' + outcome
      + ') to the seen store failed: ' + err
      + '. This record MAY BE REDELIVERED on a later run. Check the script '
      + 'property store (it has a 500 KB cap) before the next tick.');
  }

  if (outcome === LABELS.partial) {
    console.log('Delivered partial record for ' + candidate.messageId
      + '; missing: ' + assessment.missing_fields.join(', '));
  }
  return outcome;
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
  pruneSeen();
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
    var outcome;
    try {
      outcome = processOne(candidate, hookUrl, allowlist);
    } catch (err) {
      // Mirrors processInbox: without this, one unexpected throw escapes
      // before the labelling loop below and the thread is left with no
      // human-visible status at all.
      console.error('Unexpected failure processing ' + candidate.messageId + ': ' + err);
      outcome = LABELS.failed;
    }
    console.log('Outcome for ' + candidate.messageId + ': ' + outcome);
    var id = candidate.thread.getId();
    if (!byThread[id]) {
      byThread[id] = { thread: candidate.thread, label: outcome };
    } else {
      byThread[id].label = worseOutcome(byThread[id].label, outcome);
    }
  });

  // As in processInbox: findCandidates' seen-store filter is what keeps a
  // handled thread out of this loop, so no per-thread "worked" flag is needed.
  Object.keys(byThread).forEach(function (id) {
    applyLabel(byThread[id].thread, byThread[id].label);
    console.log('Labelled thread ' + id + ' as ' + byThread[id].label + '.');
  });
}

/**
 * Suppresses a pre-existing backlog, for use once at deployment.
 *
 * Marks every currently-matching message as seen with outcome pdf-ignored and
 * delivers nothing. Run this with the trigger still off if the mailbox already
 * holds bookings within the seven-day window that must NOT be sent to the Zap.
 *
 * The old advice — label those threads pdf-ignored so the query skips them —
 * is what this replaces. Labels are per thread, so it silently suppressed
 * every FUTURE booking that landed in the same conversation. Seeding the
 * per-message store suppresses exactly the messages that exist right now;
 * anything that arrives afterwards is processed normally.
 *
 * Takes the same script lock processInbox does. It is meant to be run with the
 * trigger off, but it cannot assume it was: seeding alongside a live tick can
 * write pdf-ignored over a booking that run is midway through handling, and
 * that booking is then never delivered and never reported.
 */
function seedBacklog() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log('A processing run holds the lock; nothing was seeded. '
      + 'Turn the trigger off and run seedBacklog again.');
    return;
  }

  try {
    ensureLabels();
    var seeded = 0;
    var threads = GmailApp.search(buildSearchQuery(), 0, 500);
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (message) {
        var messageId = message.getId();
        if (getSeenOutcome(messageId) !== null) return;
        markSeen(messageId, LABELS.ignored);
        seeded++;
      });
    });
    console.log('Seeded ' + seeded + ' backlog message(s) as '
      + LABELS.ignored + '. Nothing was delivered. Messages arriving from now '
      + 'on are processed normally, including in these same threads.');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Installs the minute-by-minute trigger, removing any existing one first so
 * running this twice does not double the processing rate.
 *
 * The labels are created here, once, rather than on every tick. This runs
 * before the trigger exists, so they are in place before processInbox can
 * ever fire.
 */
function installTrigger() {
  ensureLabels();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'processInbox') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(1).create();
  console.log('Trigger installed: processInbox every 1 minute.');
}
