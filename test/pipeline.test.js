const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');
const { COMPLETE } = require('./fixtures');

/**
 * Regression tests for the four properties that keep this system from
 * delivering a record twice or silently losing one. Each of them was, until
 * this file existed, protected only by a comment: a reviewer reverted every
 * one in turn and the suite stayed green.
 *
 * They are behavioural, not structural — they drive findCandidates,
 * processOne and seedBacklog against fakes and assert on what reached the
 * seen store and the delivery transport. Reverting the corresponding fix in
 * src/ must turn each of them red; that is the only thing that makes them
 * worth their runtime.
 */

const FILES = [
  'config.gs',
  'dedupe.gs',
  'deliver.gs',
  'extract.gs',
  'gmail.gs',
  'main.gs',
  'pdf.gs',
  'summary.gs',
  'text.gs',
  'transforms.gs',
  'validate.gs',
];

const ALLOWED_FROM = 'Tops Ortho <bookings@clinic.com.au>';

/** Backed by a plain object, exactly as in dedupe.test.js. */
function fakeProperties(initial) {
  const store = Object.assign({}, initial);
  const service = {
    getProperty: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setProperty: (key, value) => { store[key] = String(value); return service; },
    deleteProperty: (key) => { delete store[key]; return service; },
    getProperties: () => Object.assign({}, store),
  };
  return { store, service };
}

function fakeAttachment(name) {
  return {
    getContentType: () => 'application/pdf',
    getName: () => name || 'booking.pdf',
    copyBlob: () => ({ name: name || 'booking.pdf' }),
  };
}

/**
 * A Gmail message stub. `counters.attachmentFetches` is the point of test 1:
 * getAttachments() is a billed Gmail operation, and an already-seen message
 * must never cost one.
 */
function fakeMessage(id, options) {
  options = options || {};
  const counters = { attachmentFetches: 0 };
  return {
    counters,
    getId: () => id,
    getFrom: () => (options.from === undefined ? ALLOWED_FROM : options.from),
    getDate: () => new Date('2026-09-01T08:50:00Z'),
    getThread: () => options.thread || null,
    getAttachments: () => {
      counters.attachmentFetches++;
      return options.attachments || [fakeAttachment()];
    },
  };
}

function fakeThread(id, messages) {
  const applied = [];
  return {
    applied,
    getId: () => id,
    getMessages: () => messages,
    addLabel: (label) => { applied.push(label.getName()); },
  };
}

/**
 * Loads the whole project into one context — the way Apps Script runs it —
 * over fakes for every service it touches. Returns the handles the tests
 * assert on: the raw property store, and the list of POSTs the transport saw.
 */
function loadPipeline(options) {
  options = options || {};
  const { store, service } = fakeProperties(Object.assign({
    ZAPIER_HOOK_URL: 'https://hooks.example.com/hooks/catch/1/abc/',
    SENDER_ALLOWLIST: 'bookings@clinic.com.au',
    SUMMARY_TO: 'owner@clinic.com.au',
  }, options.properties));

  const posts = [];
  const createdLabels = [];
  const threads = options.threads || [];
  const searches = [];

  // dryRun reports through the log, so that is where its behaviour is
  // observable. Capturing also keeps a pipeline run from writing a booking's
  // worth of output into the test report.
  const logs = [];
  const capture = function () {
    logs.push(Array.prototype.map.call(arguments, String).join(' '));
  };

  const app = loadAppsScript(FILES, {
    console: { log: capture, error: capture, warn: capture },

    PropertiesService: { getScriptProperties: () => service },

    GmailApp: {
      search: (query, start, max) => { searches.push({ query, start, max }); return threads; },
      // Real GmailApp throws on an id it cannot resolve rather than returning
      // null, and dryRun has to survive that.
      getMessageById: (id) => {
        const found = (options.messagesById || {})[id];
        if (!found) throw new Error('No item with the given ID could be found');
        return found;
      },
      getUserLabelByName: (name) => ({ getName: () => name }),
      createLabel: (name) => { createdLabels.push(name); return { getName: () => name }; },
      sendEmail: () => {},
    },

    LockService: {
      getScriptLock: () => ({
        tryLock: () => (options.lockAvailable === false ? false : true),
        releaseLock: () => {},
      }),
    },

    // pdfToText's three services. The "conversion" hands back fixture text.
    // Drive advanced service v2: `insert`, not v3's `create`. If this fake and
    // src/pdf.gs ever disagree, pdfToText throws and every booking fails —
    // so the fake deliberately mirrors the real method name.
    Drive: { Files: { insert: () => ({ id: 'tmp-doc-1' }), remove: () => {} } },
    DocumentApp: {
      openById: () => ({
        getBody: () => ({ getText: () => (options.documentText === undefined ? COMPLETE : options.documentText) }),
      }),
    },
    MimeType: { GOOGLE_DOCS: 'application/vnd.google-apps.document' },
    Utilities: { getUuid: () => 'uuid-1', sleep: () => {} },

    // The delivery transport. Every POST that would leave the script lands here.
    UrlFetchApp: {
      fetch: (url, params) => {
        posts.push({ url, params });
        return { getResponseCode: () => (options.status === undefined ? 200 : options.status) };
      },
    },
  });

  return { app, store, posts, createdLabels, searches, threads, logs };
}

/** The outcome recorded for a message, read straight out of the raw store. */
function recorded(store, messageId) {
  const raw = store['seen:' + messageId];
  if (raw === undefined) return null;
  return String(raw).slice(String(raw).indexOf('|') + 1);
}

// ---------------------------------------------------------------------------
// 1. findCandidates must not fetch attachments for an already-seen message.
// ---------------------------------------------------------------------------

test('findCandidates does not fetch attachments for an already-seen message', () => {
  // The quota fix, and until now it was guarded only by a comment asking
  // future readers not to reorder two lines in gmail.gs. The search query
  // carries no label exclusion, so every already-processed thread is
  // re-enumerated on every one of the 1440 daily ticks. getId() is free on a
  // message already fetched with its thread; getAttachments() is a separate
  // billed Gmail operation. Checking the seen store FIRST is what keeps the
  // per-tick cost flat instead of growing with the mailbox — and what keeps a
  // consumer account under its 20,000/day Gmail quota, past which
  // GmailApp.search throws and nothing is processed at all.
  //
  // Swap the two lines in findCandidates and this test fails.
  const message = fakeMessage('msg-seen');
  const thread = fakeThread('thread-1', [message]);
  const { app, store } = loadPipeline({ threads: [thread] });

  app.markSeen('msg-seen', app.LABELS.processed);
  const candidates = app.findCandidates(10);

  assert.strictEqual(message.counters.attachmentFetches, 0,
    'an already-seen message must cost no attachment fetch');
  assert.strictEqual(candidates.length, 0, 'a seen message must not become a candidate');
  assert.strictEqual(recorded(store, 'msg-seen'), 'pdf-processed');
});

test('findCandidates does fetch attachments for an unseen message', () => {
  // The other half: the guard above must not be passing merely because
  // attachments are never fetched at all.
  const message = fakeMessage('msg-new');
  const thread = fakeThread('thread-1', [message]);
  const { app } = loadPipeline({ threads: [thread] });

  const candidates = app.findCandidates(10);

  assert.strictEqual(message.counters.attachmentFetches, 1);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].messageId, 'msg-new');
});

test('findCandidates skips only the seen message, not its thread siblings', () => {
  // Message-scoped, not thread-scoped. These same-subject bookings share one
  // conversation, so a thread-scoped skip would lose every later booking.
  const seen = fakeMessage('msg-seen');
  const fresh = fakeMessage('msg-fresh');
  const thread = fakeThread('thread-1', [seen, fresh]);
  const { app } = loadPipeline({ threads: [thread] });

  app.markSeen('msg-seen', app.LABELS.processed);
  const candidates = app.findCandidates(10);

  assert.strictEqual(seen.counters.attachmentFetches, 0);
  assert.strictEqual(fresh.counters.attachmentFetches, 1);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].messageId, 'msg-fresh');
});

// ---------------------------------------------------------------------------
// 2. processOne records the store on every terminal path.
// ---------------------------------------------------------------------------

/** One candidate, shaped exactly as findCandidates builds them. */
function candidateFor(messageId, from) {
  return {
    thread: fakeThread('thread-1', []),
    attachment: fakeAttachment(),
    from: from === undefined ? ALLOWED_FROM : from,
    messageId: messageId,
    receivedAt: '2026-09-01T08:50:00.000Z',
  };
}

test('processOne records pdf-ignored for a sender not on the allowlist', () => {
  // Terminal, and it MUST be recorded per message. Leaning on the thread
  // label instead would mute every future booking in the conversation; not
  // recording at all means this message is re-examined every minute forever.
  // Delete the markSeen on this path and this test fails.
  const { app, store, posts } = loadPipeline();

  const outcome = app.processOne(
    candidateFor('msg-1', 'Someone Else <stranger@example.com>'),
    'https://hooks.example.com/hooks/catch/1/abc/',
    app.getAllowlist(),
  );

  assert.strictEqual(outcome, 'pdf-ignored');
  assert.strictEqual(recorded(store, 'msg-1'), 'pdf-ignored',
    'an ignored message must be recorded, or it is re-examined every tick');
  assert.strictEqual(posts.length, 0, 'nothing may be delivered for an unlisted sender');
});

test('processOne records pdf-failed when delivery fails', () => {
  // Terminal after deliverPayload's own retries: a dead hook URL or a
  // rejected payload is a human's problem, not something the next tick fixes.
  // Unrecorded, it is retried every minute for as long as it stays in the
  // seven-day window. Delete the markSeen on this path and this test fails.
  const { app, store, posts } = loadPipeline({ status: 500 });

  const outcome = app.processOne(
    candidateFor('msg-2'),
    'https://hooks.example.com/hooks/catch/1/abc/',
    app.getAllowlist(),
  );

  assert.strictEqual(outcome, 'pdf-failed');
  assert.strictEqual(recorded(store, 'msg-2'), 'pdf-failed',
    'a failed delivery must be recorded, or it is retried every tick');
  assert.ok(posts.length > 0, 'delivery should have been attempted');
});

test('processOne records pdf-failed when the document yields no fields', () => {
  const { app, store, posts } = loadPipeline({ documentText: 'Invoice #4471\nAmount due: $320.00' });

  const outcome = app.processOne(
    candidateFor('msg-3'),
    'https://hooks.example.com/hooks/catch/1/abc/',
    app.getAllowlist(),
  );

  assert.strictEqual(outcome, 'pdf-failed');
  assert.strictEqual(recorded(store, 'msg-3'), 'pdf-failed');
  assert.strictEqual(posts.length, 0, 'an unreadable document must not be delivered');
});

test('processOne records the outcome after a successful delivery', () => {
  const { app, store, posts } = loadPipeline();

  const outcome = app.processOne(
    candidateFor('msg-4'),
    'https://hooks.example.com/hooks/catch/1/abc/',
    app.getAllowlist(),
  );

  assert.strictEqual(outcome, 'pdf-processed');
  assert.strictEqual(recorded(store, 'msg-4'), 'pdf-processed');
  assert.strictEqual(posts.length, 1, 'exactly one POST per delivered record');
});

test('a markSeen that throws after a successful POST does not re-throw', () => {
  // The redelivery blocker. The POST has already landed; a throw here escapes
  // processOne into processInbox's unexpected-failure path, which deliberately
  // leaves the message unrecorded — so the next tick POSTs it again, and the
  // one after that, forever. Failing to record is strictly better than
  // re-throwing once the record is out the door.
  const { app, posts } = loadPipeline();
  const realMarkSeen = app.markSeen;
  app.markSeen = function (messageId, outcome) {
    if (outcome === 'pdf-processed' || outcome === 'pdf-partial') {
      throw new Error('Script property store quota exceeded');
    }
    return realMarkSeen(messageId, outcome);
  };

  const outcome = app.processOne(
    candidateFor('msg-5'),
    'https://hooks.example.com/hooks/catch/1/abc/',
    app.getAllowlist(),
  );

  assert.strictEqual(outcome, 'pdf-processed', 'the earned outcome is still returned');
  assert.strictEqual(posts.length, 1, 'the delivery itself is unaffected');
});

// ---------------------------------------------------------------------------
// 3. processOne short-circuits on an already-seen message.
// ---------------------------------------------------------------------------

test('processOne returns the stored outcome for an already-seen message', () => {
  // It returns what the message actually EARNED. Assuming success here would
  // relabel a partial, failed or ignored message pdf-processed and hide a real
  // problem — and the daily summary, which now counts from this same store,
  // would stop reporting it.
  const { app, posts } = loadPipeline();
  app.markSeen('msg-6', app.LABELS.partial);

  const outcome = app.processOne(
    candidateFor('msg-6'),
    'https://hooks.example.com/hooks/catch/1/abc/',
    app.getAllowlist(),
  );

  assert.strictEqual(outcome, 'pdf-partial',
    'the stored outcome must come back, not an assumed pdf-processed');
  assert.strictEqual(posts.length, 0,
    'an already-seen message must never be delivered a second time');
});

test('processOne re-delivers nothing for a seen message whatever its outcome', () => {
  const { app, posts } = loadPipeline();
  app.markSeen('msg-a', app.LABELS.processed);
  app.markSeen('msg-b', app.LABELS.failed);
  app.markSeen('msg-c', app.LABELS.ignored);
  const url = 'https://hooks.example.com/hooks/catch/1/abc/';
  const allowlist = app.getAllowlist();

  assert.strictEqual(app.processOne(candidateFor('msg-a'), url, allowlist), 'pdf-processed');
  assert.strictEqual(app.processOne(candidateFor('msg-b'), url, allowlist), 'pdf-failed');
  assert.strictEqual(app.processOne(candidateFor('msg-c'), url, allowlist), 'pdf-ignored');
  assert.strictEqual(posts.length, 0);
});

// ---------------------------------------------------------------------------
// 4. seedBacklog records every message and delivers nothing.
// ---------------------------------------------------------------------------

test('seedBacklog records every message as pdf-ignored and delivers nothing', () => {
  // Run once at deployment to suppress a pre-existing backlog. The old advice
  // — label those threads pdf-ignored so the query skips them — silently
  // suppressed every FUTURE booking in the same conversation. Seeding the
  // per-message store suppresses exactly the messages that exist right now.
  // Make seedBacklog record nothing and this test fails.
  const threadA = fakeThread('thread-1', [fakeMessage('old-1'), fakeMessage('old-2')]);
  const threadB = fakeThread('thread-2', [fakeMessage('old-3')]);
  const { app, store, posts } = loadPipeline({ threads: [threadA, threadB] });

  app.seedBacklog();

  assert.strictEqual(recorded(store, 'old-1'), 'pdf-ignored');
  assert.strictEqual(recorded(store, 'old-2'), 'pdf-ignored');
  assert.strictEqual(recorded(store, 'old-3'), 'pdf-ignored');
  assert.strictEqual(posts.length, 0, 'seedBacklog must deliver nothing');
});

test('seedBacklog leaves an already-recorded outcome alone', () => {
  // Seeding must not overwrite a real outcome with pdf-ignored, or the daily
  // summary loses the failure it was meant to report.
  const thread = fakeThread('thread-1', [fakeMessage('done-1'), fakeMessage('new-1')]);
  const { app, store } = loadPipeline({ threads: [thread] });

  app.markSeen('done-1', app.LABELS.failed);
  app.seedBacklog();

  assert.strictEqual(recorded(store, 'done-1'), 'pdf-failed');
  assert.strictEqual(recorded(store, 'new-1'), 'pdf-ignored');
});

test('seedBacklog seeds nothing when a processing run holds the lock', () => {
  // Without the lock, seeding alongside a live tick can write pdf-ignored over
  // a booking that run is midway through handling: never delivered, never
  // reported.
  const thread = fakeThread('thread-1', [fakeMessage('inflight-1')]);
  const { app, store } = loadPipeline({ threads: [thread], lockAvailable: false });

  app.seedBacklog();

  assert.strictEqual(recorded(store, 'inflight-1'), null,
    'nothing may be seeded while another run holds the lock');
});

// ---------------------------------------------------------------------------
// The quota fix, stated as a property of processInbox rather than of gmail.gs.
// ---------------------------------------------------------------------------

test('processInbox costs no label operations when there is nothing to do', () => {
  // ensureLabels() re-checked four labels on every one of the 1440 daily
  // ticks: 5,760 Gmail operations a day spent confirming labels that already
  // exist, on top of a measured steady-state floor that already sat near the
  // 20,000/day consumer quota. Past the quota GmailApp.search throws and
  // nothing is processed for the rest of the day. Put ensureLabels() back into
  // processInbox and this test fails.
  const message = fakeMessage('msg-seen');
  const thread = fakeThread('thread-1', [message]);
  const { app, createdLabels } = loadPipeline({ threads: [thread] });
  let labelLookups = 0;
  const realLookup = app.GmailApp.getUserLabelByName;
  app.GmailApp.getUserLabelByName = (name) => { labelLookups++; return realLookup(name); };

  app.markSeen('msg-seen', app.LABELS.processed);
  app.processInbox();

  assert.strictEqual(labelLookups, 0,
    'a tick with nothing to do must cost no label lookups');
  assert.strictEqual(createdLabels.length, 0);
  assert.strictEqual(message.counters.attachmentFetches, 0);
});

test('processInbox still labels a thread it did work on', () => {
  // Removing ensureLabels() must not remove labelling: applyLabel creates a
  // missing label on demand, which is why nothing breaks without it.
  const thread = fakeThread('thread-1', [fakeMessage('msg-new')]);
  const { app, posts } = loadPipeline({ threads: [thread] });

  app.processInbox();

  assert.deepStrictEqual(thread.applied, ['pdf-processed']);
  assert.strictEqual(posts.length, 1);
});

// ---------------------------------------------------------------------------
// The summary now counts from the store.
// ---------------------------------------------------------------------------

test('sendDailySummary counts messages from the store, not threads from Gmail', () => {
  // Twenty failures in one conversation used to report "Failed: 1", because
  // the count came from a Gmail thread search and labels are per thread.
  const sent = [];
  const { app, store, searches } = loadPipeline();
  app.GmailApp.sendEmail = (to, subject, body) => { sent.push({ to, subject, body }); };

  const now = Date.now();
  for (let i = 0; i < 20; i++) store['seen:f-' + i] = String(now) + '|pdf-failed';
  store['seen:p-1'] = String(now) + '|pdf-partial';
  store['seen:i-1'] = String(now) + '|pdf-ignored';
  store['seen:ok-1'] = String(now) + '|pdf-processed';

  const searchesBefore = searches.length;
  app.sendDailySummary();

  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].subject, /20 failed, 1 partial, 1 ignored/);
  assert.match(sent[0].body, /Failed: {2}20/);
  assert.match(sent[0].body, /Partial: 1/);
  assert.match(sent[0].body, /Ignored: 1/);
  assert.strictEqual(searches.length, searchesBefore,
    'the summary must no longer search Gmail to count');
});

test('sendDailySummary stays silent when the last day holds nothing to report', () => {
  // The zero-count silence rule: a daily "all clear" trains you to ignore the
  // message. A successful delivery is not something to report.
  const sent = [];
  const { app, store } = loadPipeline();
  app.GmailApp.sendEmail = (to, subject, body) => { sent.push({ to, subject, body }); };

  store['seen:ok-1'] = String(Date.now()) + '|pdf-processed';
  store['seen:old-fail'] = String(Date.now() - 3 * 24 * 60 * 60 * 1000) + '|pdf-failed';

  app.sendDailySummary();

  assert.strictEqual(sent.length, 0,
    'a stale failure outside the window must not resend the summary every day');
});

test('sendDailySummary resolves its recipient before deciding to stay silent', () => {
  // A missing SUMMARY_TO must throw on the first run, while someone is still
  // watching the deploy — not lie dormant until the first day something
  // actually needs reporting, which is the one day it must not fail.
  const { app } = loadPipeline({ properties: { SUMMARY_TO: '' } });
  assert.throws(() => app.sendDailySummary(), /SUMMARY_TO/);
});

// ---------------------------------------------------------------------------
// dryRun against a nominated message, including one already processed.
// ---------------------------------------------------------------------------

/** A pipeline whose one message has already been delivered and recorded. */
function loadProcessed() {
  const message = fakeMessage('msg-done');
  const thread = fakeThread('thread-1', [message]);
  const pipeline = loadPipeline({ threads: [thread], messagesById: { 'msg-done': message } });
  pipeline.app.markSeen('msg-done', pipeline.app.LABELS.processed);
  return pipeline;
}

test('dryRun inspects a message that is already recorded as seen', () => {
  // findCandidates drops seen messages before dryRun can reach them, so
  // checking a booking that has already been through used to mean deleting its
  // seen record — which hands it straight back to the trigger for a duplicate
  // delivery. Naming the message skips the seen store without touching it.
  const { app, logs } = loadProcessed();

  app.dryRun('msg-done');

  assert.ok(logs.some((line) => line.includes('msg-done')),
    'the nominated message should be the one reported on');
  assert.ok(logs.some((line) => line.includes('patient_first_name')),
    'the field report should have run');
});

test('dryRun on a nominated message leaves the seen store untouched', () => {
  // The whole point: no duplicate-delivery window is opened by inspecting.
  const { app, store } = loadProcessed();
  const before = JSON.stringify(store);

  app.dryRun('msg-done');

  assert.strictEqual(JSON.stringify(store), before);
});

test('dryRun on a nominated message delivers nothing', () => {
  const { app, posts } = loadProcessed();

  app.dryRun('msg-done');

  assert.strictEqual(posts.length, 0);
});

test('dryRun explains an unresolvable message id instead of throwing', () => {
  const { app, logs } = loadProcessed();

  app.dryRun('no-such-id');

  assert.ok(logs.some((line) => line.includes('no-such-id')),
    'the log should name the id that could not be read');
  assert.ok(logs.some((line) => /could not/i.test(line)),
    'the log should say what went wrong');
});

test('dryRun reports a nominated message that carries no PDF', () => {
  const message = fakeMessage('msg-nopdf', { attachments: [] });
  const thread = fakeThread('thread-1', [message]);
  const { app, logs } = loadPipeline({
    threads: [thread],
    messagesById: { 'msg-nopdf': message },
  });

  app.dryRun('msg-nopdf');

  assert.ok(logs.some((line) => /pdf/i.test(line) && line.includes('msg-nopdf')),
    'the log should say the named message has no PDF');
});

test('dryRun with no argument still picks its own candidate', () => {
  // The setup path must keep working unchanged for someone who has not got a
  // message id to hand.
  const message = fakeMessage('msg-new');
  const thread = fakeThread('thread-1', [message]);
  const { app, logs, posts } = loadPipeline({ threads: [thread] });

  app.dryRun();

  assert.ok(logs.some((line) => line.includes('msg-new')));
  assert.strictEqual(posts.length, 0);
});
