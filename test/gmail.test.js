const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['config.gs', 'gmail.gs']);

test('the query requires a pdf attachment', () => {
  const query = app.buildSearchQuery();
  assert.match(query, /has:attachment/);
  assert.match(query, /filename:pdf/);
});

test('the query contains no label exclusion of any kind', () => {
  // Do not "restore" any of these exclusions — adding one back is a
  // regression, not a tidy-up. Gmail labels are per THREAD, and these bookings
  // share a subject and sender, so Gmail groups them into one conversation.
  // ANY `-label:` term hides every later booking in a thread already carrying
  // that label: never enumerated, never processed, never counted, no signal
  // anywhere. That is true of the terminal labels (pdf-failed, pdf-ignored)
  // just as much as the successful ones — one ignored booking would mute the
  // whole conversation for good. Reprocessing is prevented per MESSAGE by the
  // seen store in dedupe.gs, which findCandidates consults before it fetches
  // any attachment.
  const query = app.buildSearchQuery();
  assert.doesNotMatch(query, /-label:/);
  assert.doesNotMatch(query, /-label:pdf-processed/);
  assert.doesNotMatch(query, /-label:pdf-partial/);
  assert.doesNotMatch(query, /-label:pdf-failed/);
  assert.doesNotMatch(query, /-label:pdf-ignored/);
});

test('the query is bounded in time', () => {
  assert.match(app.buildSearchQuery(), /newer_than:7d/);
});

/** A stand-in for a Gmail attachment: only the two getters used are needed. */
function fakeAttachment(contentType, name) {
  return {
    getContentType: () => contentType,
    getName: () => name,
  };
}

function fakeMessage(attachments) {
  return { getAttachments: () => attachments };
}

test('finds an attachment declared application/pdf', () => {
  const pdf = fakeAttachment('application/pdf', 'booking.pdf');
  assert.strictEqual(app.firstPdfAttachment(fakeMessage([pdf])), pdf);
});

test('finds a .pdf sent as application/octet-stream', () => {
  // Real senders do this. Requiring the content type exactly meant the
  // message yielded no candidate at all, so its thread was never labelled
  // and the booking was lost with no signal.
  const pdf = fakeAttachment('application/octet-stream', 'booking.pdf');
  assert.strictEqual(app.firstPdfAttachment(fakeMessage([pdf])), pdf);
});

test('finds a .pdf sent as application/x-pdf, case-insensitively', () => {
  const pdf = fakeAttachment('application/x-pdf', 'BOOKING.PDF');
  assert.strictEqual(app.firstPdfAttachment(fakeMessage([pdf])), pdf);
});

test('ignores an attachment that is neither a pdf type nor a .pdf name', () => {
  const other = fakeAttachment('image/png', 'signature.png');
  assert.strictEqual(app.firstPdfAttachment(fakeMessage([other])), null);
});

test('skips non-pdf attachments to reach the pdf', () => {
  const other = fakeAttachment('image/png', 'signature.png');
  const pdf = fakeAttachment('application/octet-stream', 'booking.pdf');
  assert.strictEqual(app.firstPdfAttachment(fakeMessage([other, pdf])), pdf);
});
