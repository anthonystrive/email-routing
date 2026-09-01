/**
 * Trigger entry point. Runs every minute.
 *
 * The script lock prevents a slow run from overlapping the next one and
 * delivering the same message twice — labels are only applied at the end of
 * processing, so an overlapping run would see the message as unprocessed.
 */
var OUTCOME_SEVERITY = {};
OUTCOME_SEVERITY[LABELS.ignored] = 0;
OUTCOME_SEVERITY[LABELS.processed] = 1;
OUTCOME_SEVERITY[LABELS.partial] = 2;
OUTCOME_SEVERITY[LABELS.failed] = 3;

/** The more serious of two outcome labels, so one bad message marks the thread. */
function worseOutcome(a, b) {
  if (!a) return b;
  if (!b) return a;
  return OUTCOME_SEVERITY[a] >= OUTCOME_SEVERITY[b] ? a : b;
}

/**
 * Trigger entry point. Runs every minute.
 *
 * The script lock prevents a slow run from overlapping the next one and
 * delivering the same message twice.
 *
 * Labels are applied per thread, after every message in that thread has been
 * processed — see the note above on why labelling mid-thread can silently
 * lose a booking.
 */
function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log('Another run holds the lock; skipping this tick.');
    return;
  }

  try {
    ensureLabels();
    var hookUrl = getHookUrl();
    var allowlist = getAllowlist();
    var candidates = findCandidates(10);

    if (candidates.length > 0) {
      console.log('Processing ' + candidates.length + ' candidate message(s).');
    }

    var byThread = {};
    candidates.forEach(function (candidate) {
      var outcome = processOne(candidate, hookUrl, allowlist);
      var id = candidate.thread.getId();
      if (!byThread[id]) {
        byThread[id] = { thread: candidate.thread, label: outcome };
      } else {
        byThread[id].label = worseOutcome(byThread[id].label, outcome);
      }
    });

    Object.keys(byThread).forEach(function (id) {
      applyLabel(byThread[id].thread, byThread[id].label);
    });
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
    // Nothing matched, so this is almost certainly not the expected
    // template. Log a bounded excerpt to make the mismatch diagnosable —
    // a document that matches nothing is unlikely to be a patient booking.
    console.error('No fields matched for ' + candidate.messageId
      + '. First 300 characters: ' + text.slice(0, 300));
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

  if (assessment.complete) {
    return LABELS.processed;
  }

  console.log('Delivered partial record for ' + candidate.messageId
    + '; missing: ' + assessment.missing_fields.join(', '));
  return LABELS.partial;
}

/**
 * Processes a single message on demand. Run this from the Apps Script editor
 * during setup, with ZAPIER_HOOK_URL pointed at a request-capture endpoint
 * rather than the live Zap.
 */
function runOnce() {
  ensureLabels();
  var candidates = findCandidates(1);
  if (candidates.length === 0) {
    console.log('No candidate messages found.');
    return;
  }
  console.log('Processing message ' + candidates[0].messageId
    + ' from ' + candidates[0].from);
  var outcome = processOne(candidates[0], getHookUrl(), getAllowlist());
  applyLabel(candidates[0].thread, outcome);
  console.log('Outcome: ' + outcome);
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
