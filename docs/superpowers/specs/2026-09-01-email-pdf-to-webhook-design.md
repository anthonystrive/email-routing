# Email → PDF Extraction → Webhook

**Date:** 2026-09-01
**Status:** Design approved. Sample PDF analysed; ready for implementation planning.

## Problem

A fixed-template PDF arrives by email. Its data needs to reach third-party
systems (initially Zapier) as structured JSON, without manual re-keying.

## Constraints

- Zero running cost.
- Minimal infrastructure — no server, no database, no DNS changes.
- Source code version-controlled in this repo, not only in a browser editor.
- Latency of up to a minute is acceptable.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Inbound mail | Gmail mailbox | Free; no DNS or mail vendor. A forward from a custom domain hides the Gmail address from senders. |
| Runtime | Google Apps Script, time-driven trigger | Free, no hosting, native Gmail and Drive access. |
| PDF → text | Google Drive conversion to a Google Doc, via the **v2** advanced service | Apps Script has no PDF library. Drive converts free and handles text-layer PDFs cleanly. v2 is what the Apps Script editor offers; its call shape is `Files.insert` with `title`, not v3's `Files.create` with `name`. |
| Extraction | Declarative label/value table | One consistent template. Deterministic, no model cost, missing fields reported not enforced. |
| Delivery | HTTP POST to a Zapier Catch Hook | Push-only. No storage, no polling endpoint, no auth surface to defend. |
| Trigger cadence | Every 1 minute | Apps Script's finest time-driven granularity. |

**Rejected:** Cloudflare Email Worker (requires Workers Paid at $5/mo, since
PDF parsing exceeds the free tier's 10ms CPU cap, plus DNS on Cloudflare).
Cloudflare + Vercel free tiers (Vercel Hobby forbids commercial use).
Both remain viable upgrade paths — see *Portability*.

## Source document

Analysed from a sample since removed from the repo (it contained
real patient data). Findings recorded here; all example values below are
fictional. Single page, single column,
text layer present, no images, no form fields. Produced by **Tops Ortho**
practice-management software, titled *New Patient Booking Activation*.

Structure is a flat sequence of label/value pairs at a consistent left margin.
Ten fields, listed in the `FIELDS` table below.

**In the PDF itself** every label sits on its own line with its value on the
next. **After Drive's conversion that is not what arrives.** The converter
merges some label/value pairs onto a single line (`Patient appointment date:
24/9/2026`) and leaves others on two, according to their spacing in the
source. Confirmed on a live document: of ten fields, three converted inline
and seven did not.

This matters more than it sounds. Fixtures written from the PDF's internal
structure — which is what the original analysis of this file produced — contain
only the two-line form, so an extractor that handles only that form passes
every test and then returns null for the merged fields against real mail.
`collectValuesForLabel` handles both, and `test/fixtures.js` carries a mixed
fixture so the inline form stays covered.

Known variability the single sample does not settle, to confirm before or
during implementation:

- **Account holder B** rows are included as a safeguard, with labels assumed
  to mirror A's. No sample containing a B record has been seen, so the exact
  label wording is unverified.
- ~~`Needs referral for` takes one of three known values: `OPG`,
  `Lateral Cephalogram`, or `OPG + Lateral Cephalogram`.~~ Superseded by the
  September 2026 revision below: the items are now listed one per line.
- Whether the document ever runs to a second page.

## Template revision — September 2026

Three further sample documents (again analysed then deleted — they contained
real patient data) show the template has changed in two ways. Both make a
field's value span **several consecutive lines**, which the original
one-label-one-line reading cannot see.

**Account holder A now lists every email address, one per line.** The three
samples carried three, two and three addresses; one recurring address is the
practice's own copy. The old reader took the line after the label and stopped,
so it captured the first address and dropped the rest silently — no error, no
`missing_fields` entry, nothing downstream could detect.

**`Needs referral for` lists one item per line** where it previously emitted a
single `+`-joined string. None of the three samples selects more than one
item, so the two-item case has not been seen directly; the tell is the layout.
Two of the three leave an **empty line** between the label and its value —
confirmed against the PDF content stream, where nothing at all is drawn on
that line — which is a list rendering blank slots. The blank line itself is
harmless, since `toLines` drops empty lines before pairing. The list is not:
a booking needing both items would yield a wrong boolean, which is worse than
a null because nothing downstream can detect it.

`collectValuesForLabel` therefore gathers every line belonging to a label
until the next label or the end of the document, for fields marked
`multiline`. `pattern` is applied per line, so a stray non-address line among
the emails is dropped without costing the addresses either side.

**Confirmed in production, and it broke:** Drive's converter merges *lines*,
not only label/value pairs. The addresses that occupy one line each in the PDF
arrived on a single line, so `collectValuesForLabel` returned one value holding
all of them and Zapier rejected `account_holder_a_email` as not an email. The
local check that missed this ran against the PDF's text layer, where the lines
are still separate — the same trap the inline label/value fix hit, one level
down. The address fields now declare a `separator` and split what they collect;
only fields declaring one are split, since a name and a mobile number contain
spaces.

**Assumption, unverified:** the document has no footer. All three samples end
at the referral value, and `Needs referral for` is the last field, so
multiline collection runs to end-of-document. Should a footer ever appear, it
would be appended to the referral value — one fixture and a `pattern` on that
field is the fix.

## Architecture

```
sender ──email──> Gmail mailbox
                        │
              time-driven trigger (1 min)
                        │
                   main.gs
                    ├─ gmail.gs    find unprocessed mail with a PDF
                    ├─ dedupe.gs   per-message record of what is done
                    ├─ pdf.gs      PDF blob → plain text (via Drive)
                    ├─ extract.gs  text → typed object (rule table)
                    ├─ validate.gs report which fields are missing
                    ├─ deliver.gs  POST to the Zapier hook
                    └─ label the thread processed / failed
```

Apps Script files share one global scope — there is no module system. Each
file below is a `.gs` file exposing top-level functions; separation is by
convention and discipline, not by imports.

## Components

### `main.gs`
Entry point invoked by the trigger. Acquires a `LockService` script lock so
overlapping runs do not duplicate work, iterates candidate messages, and
routes each to success or failure labelling. The lock is not what guarantees
single delivery — Apps Script's execution limit is a hard kill that skips
`finally`, so a run can die holding it. The per-message record in `dedupe.gs`
is the guarantee. Contains
orchestration only — no Gmail queries, no parsing, no HTTP.

### `gmail.gs`
Queries `GmailApp` for threads matching `has:attachment filename:pdf
newer_than:7d` and returns the first PDF attachment per message — matched on
content type OR a `.pdf` filename, since real senders emit
`application/octet-stream` — alongside sender and message ID. Also owns label
creation and application.

**The query carries no label exclusions, deliberately.** Labels are
thread-scoped, and these same-subject, same-sender bookings land in one Gmail
conversation, so any `-label:` term would hide every later booking in a thread
that had already been handled — silently, with no error and no count.
`dedupe.gs` holds the per-message record that decides what is skipped.
Restoring a label exclusion would reintroduce that silent loss.

Already-seen messages are skipped **before** their attachments are fetched,
which is what keeps the per-tick Gmail cost flat despite re-enumerating
handled threads.

The `newer_than:7d` bound keeps the query cheap and stops the job from
re-examining the entire mailbox once it has been running for months.

### `pdf.gs`
Takes a PDF blob, creates a temporary Google Doc via the Drive **v2**
advanced service — `Files.insert` with a `title` field; v3's `Files.create`
with `name` is not what the editor offers — reads its text with
`DocumentApp`, then
deletes the temporary file outright (`Drive.Files.remove`, not trash) in a
`finally` block, so a mid-run failure cannot leave copies of the source
document accumulating in Drive.

### `dedupe.gs`
The per-message processing record, in script properties: `timestamp|outcome`
keyed by Gmail message ID, pruned past the search window. This is the single
source of truth for what has been handled, and the only thing preventing both
duplicate delivery and silent loss. Thread labels cannot serve the purpose —
see `gmail.gs` above. Labels remain, but only for human visibility.

`seedBacklog` marks existing messages as handled without delivering them, so
an operator can suppress a pre-existing backlog at deploy time safely.

### `extract.gs`
The only file that knows anything about the specific document. The source
document places each label on its own line with the value on the next line,
so extraction is a label lookup rather than a per-field regex:

```js
const FIELDS = [
  { key: 'patient_first_name',       label: 'Patient first name' },
  { key: 'patient_surname',          label: 'Patient surname' },
  { key: 'patient_gender',           label: 'Patient gender' },
  // Transforms are wrapped in function literals, never referenced bare.
  // A bare reference is resolved when this array is built, which depends on
  // Apps Script's file load order — and that order is not version-controlled.
  { key: 'patient_date_of_birth',    label: 'Patient date of birth',
    transform: function (v) { return auDateToIso(v); } },
  { key: 'patient_appointment_date', label: 'Patient appointment date',
    transform: auDateToIso },
  { key: 'patient_appointment_time', label: 'Patient appointment time',
    transform: normaliseTime },

  { key: 'account_holder_a_name',    label: 'Account holder A titled full name' },
  { key: 'account_holder_a_mobile',  label: 'Account holder A mobile number' },
  // One address per line since the September 2026 revision. The field's own
  // key holds the primary address; `extraKey` holds everything after it as one
  // ', '-separated string, with the primary deliberately not repeated there.
  { key: 'account_holder_a_email',   label: 'Account holder A email',
    pattern: /@/, multiline: true, separator: /[\s,;]+/,
    extraKey: 'account_holder_a_emails' },

  // Account holder B is a safeguard: expected to be absent on most bookings.
  // `optional` keeps its absence out of the completeness calculation.
  { key: 'account_holder_b_name',    label: 'Account holder B titled full name',
    optional: true },
  { key: 'account_holder_b_mobile',  label: 'Account holder B mobile number',
    optional: true },
  { key: 'account_holder_b_email',   label: 'Account holder B email',
    optional: true, pattern: /@/, multiline: true, separator: /[\s,;]+/,
    extraKey: 'account_holder_b_emails' },

  // Listed one item per line since the September 2026 revision. `join`
  // reproduces the single-line form the old template produced, so the derived
  // booleans and any downstream string matching are unaffected.
  { key: 'needs_referral_for',       label: 'Needs referral for',
    multiline: true, join: ' + ' },
];
```

`extractFields(text)` normalises the text once, then for each row finds the
line beginning with `label` (trailing colon optional, case-insensitive). If
that line carries more text after the label, it is the value; otherwise the
value is the next non-empty line. A label that is absent, or present with
no following value, yields `null` — it does not throw.

**Normalisation is mandatory, not defensive.** The source PDF uses
MacRomanEncoding and contains an `fi` ligature in "first", and separates the
appointment time from its meridiem with a narrow no-break space drawn from a
different font. Before matching, the text is NFKC-normalised (which folds
`\uFB01` to `fi`) and all Unicode whitespace is collapsed to ASCII spaces.
Without this, label lookups miss silently and every field returns null.

Dates arrive as Australian `D/M/YYYY` without zero-padding (`5/4/1988`) and
are converted to ISO `YYYY-MM-DD`. This is the one place a wrong assumption
is genuinely dangerous: `2/9/2026` is 2 September, not 9 February.

When the template changes, this table is the only thing that changes.

**Optional fields.** A row marked `optional` behaves identically during
extraction — it yields null when absent — but is excluded from
`missing_fields` and from the `complete` calculation. Without this
distinction, account holder B being absent (the normal case) would mark every
single record incomplete and render the flag worthless.

The B labels are assumed to mirror A's exactly. This is unverified — no
sample containing a B record has been seen. If the wording differs, only
these three `label` strings change, and until then B records simply extract
as null rather than breaking anything.

**Derived fields.** `needs_referral_for` is the referral items joined with
` + `, which reproduces the single-line form the template used to emit
directly: `OPG`, `Lateral Cephalogram`, or `OPG + Lateral Cephalogram`.
Rather than
force downstream consumers to string-match a compound value, extraction
derives two booleans by substring:

```js
needs_opg           = /OPG/i.test(raw)
needs_lateral_ceph  = /lateral\s+cephalogram/i.test(raw)
```

A Zap can then branch on a boolean instead of parsing text. Deriving by
substring rather than matching the three values exactly means a fourth
combination appearing later still produces correct booleans, and the raw
string is always passed through unchanged alongside them. If the raw value
is present but matches neither term, both booleans are false and the value
is logged as unrecognised — delivery still proceeds.


### `validate.gs`
Advisory, not blocking. Reports which expected fields came back null and
which transforms failed, and returns that list for inclusion in the payload.
It never prevents delivery.

The single exception is the empty-extraction case: if *zero* fields matched,
the text almost certainly did not come from this template (or the conversion
failed), and an empty payload has no value downstream. That case is treated
as a failure. Any result with at least one populated field is delivered.

### `deliver.gs`
POSTs JSON via `UrlFetchApp` with `muteHttpExceptions: true`. Retries up to
three times with backoff on 5xx or network failure; treats 4xx as permanent
and does not retry. The hook URL is read from `PropertiesService` script
properties, never committed.

## Data contract

Flat, snake_case JSON — flat because Zapier handles nested objects poorly.
Every field in the `FIELDS` table is always present as a key; fields that
could not be extracted are `null` rather than omitted, so downstream Zap
steps never break on a missing key.

```json
{
  "patient_first_name": "Alex",
  "patient_surname": "Sample",
  "patient_gender": "Male",
  "patient_date_of_birth": "1990-01-15",
  "patient_appointment_date": "2026-09-02",
  "patient_appointment_time": "8:50 am",
  "account_holder_a_name": "Dr. Jamie R Sample",
  "account_holder_a_mobile": "+61-400-000-000",
  "account_holder_a_email": "jamie@example.com",
  "account_holder_a_emails": "alex@example.com, bookings@example.com",
  "account_holder_b_name": null,
  "account_holder_b_mobile": null,
  "account_holder_b_email": null,
  "account_holder_b_emails": null,
  "needs_referral_for": "OPG + Lateral Cephalogram",
  "needs_opg": true,
  "needs_lateral_ceph": true,
  "_meta": {
    "message_id": "...",
    "from": "sender@example.com",
    "received_at": "2026-09-01T04:31:00.000Z",
    "extractor_version": "1.3.0",
    "complete": true,
    "missing_fields": []
  }
}
```

The payload is **strictly flat** apart from `_meta`: every value is a string,
a number, a boolean or null, so a Zap step maps each key directly rather than
reaching into a structure. Where a field holds several values, they arrive as
one `', '`-separated string.

`account_holder_a_email` holds the **primary** address alone.
`account_holder_a_emails` holds everything after it, and the primary is
deliberately not repeated there — carried in both, a Zap mailing each in turn
writes to the same person twice. It is null, not an empty string, when there
are no additional addresses, matching every other absent value in the record.

The example above is a **complete** record despite the three null account
holder B fields — those are optional, so their absence does not count.

**Partial records are delivered.** `_meta.complete` and
`_meta.missing_fields` carry the extraction quality forward so a Zap can
branch on it — route complete records straight through, send incomplete ones
to a human for review — rather than the record being withheld entirely.

`_meta` is what makes a bad parse debuggable weeks later.
`extractor_version` is bumped by hand whenever the `FIELDS` table changes, so
a downstream consumer can tell which ruleset produced a given record.

## Error handling

| Failure | Behaviour |
|---|---|
| Sender not in allowlist | Skip, record the message as `pdf-ignored`. The address is effectively public once known. Note the thread label reflects the *worst* outcome across its messages, so a conversation mixing ignored and processed messages shows the processed label — the ignored count comes from the per-message store, not from labels. |
| No PDF attachment | Skip silently — ordinary mail will land in this box. |
| Drive conversion fails | Label `pdf-failed`, log the message ID. Nothing sent. |
| Zero fields extracted | Label `pdf-failed`, log the message id, character count and whether the expected title is present — never the text itself, which would be patient data. Nothing sent. |
| Some fields missing | **Deliver anyway.** Nulls for the missing fields, `complete: false`, names listed in `missing_fields`. Thread labelled `pdf-partial`. |
| A transform fails (e.g. unparseable date) | Field set to null and named in `missing_fields`; the rest of the record is delivered. |
| Zapier returns 5xx | Retry 3× with backoff, then label `pdf-failed`. |
| Zapier returns 4xx | No retry, label `pdf-failed`. |

Partial extraction is a normal outcome, not an error — it is labelled
distinctly (`pdf-partial`) so incomplete records stay reviewable in Gmail
without blocking delivery. Only a total failure to read the document, or a
delivery failure, stops a record reaching Zapier.

The optional daily summary trigger reports counts of `pdf-failed`,
`pdf-partial` and `pdf-ignored` threads — ignored included because an
allowlist that stops matching would otherwise drop every booking while the
summary stayed silent, so a template change that quietly breaks one field
shows up as a rising partial count rather than going unnoticed.

Two alerting paths, deliberately separated. An *expected* failure — an
unreadable PDF, a rejected webhook, a document matching nothing — is recorded
against the message, labelled, and left for the daily summary to count. An
*unexpected* exception means a bug, so the run rethrows after labelling and
Apps Script emails the owner directly, and the message is deliberately NOT
recorded so it retries next tick. The per-message record in `dedupe.gs`, not
the ordering of labels, is what prevents a redelivery.

## Security

- **Sender allowlist** in script properties is the security boundary. Without
  it, anyone who learns the address can inject arbitrary records downstream.
- **Zapier hook URL** lives in script properties, not source. Anyone holding
  that URL can post to the Zap.
- The script is bound to a Google account with access to that whole mailbox
  and Drive. Use a dedicated account, not a personal one, if the mailbox
  carries anything unrelated.
- **These documents carry identifiable health information** — patient name,
  date of birth, gender, contact details and appointment. Treat the mailbox,
  the Drive account and the Zapier hook as handling health data, and check
  what obligations that carries before going live.
- **No real patient data is committed.** The original sample was removed from
  the repo and all example values here are fictional. Keep it that way:
  fixtures are synthesised, never derived from a live booking.
- If the PDFs contain personal or health data, the temporary Drive Doc is a
  transient copy of it. `Drive.Files.remove` deletes it outright rather than
  trashing it, since trashed files persist until the trash is emptied.

## Testing

`extract.gs` and `validate.gs` reference no Apps Script globals, so both run
under plain Node. A trailing conditional export
(`if (typeof module !== 'undefined') module.exports = ...`) makes them
loadable by `node --test` locally while remaining valid Apps Script.

- **Unit:** `extractFields` against committed fixture strings — one complete
  document; one with a label absent, asserting a null field and correct
  `missing_fields`; one with a malformed date, asserting the bad field nulls
  while the rest survive; one of unrelated text, asserting the zero-match
  failure path.
- **Normalisation:** a fixture containing the `fi` ligature and a narrow
  no-break space, asserting labels still match and the time reads `8:50 am`.
- **Dates:** `auDateToIso('2/9/2026')` is 2 September, not 9 February.
- **Optional fields:** a fixture with no account holder B, asserting the
  three B keys are null, `missing_fields` is empty and `complete` is true.
- **Referral values:** all three known values, asserting the boolean pairs
  `(true,false)`, `(false,true)` and `(true,true)`; plus an unrecognised
  value, asserting both false and the raw string still delivered.
- **Fixture provenance:** the sample PDF has been deleted, so fixtures are
  synthesised from the label structure recorded in this spec rather than from
  real converted output. Consequence: the first live email is also the first
  real test of Drive's conversion. Task 11 verifies this end to end before the
  minute-by-minute trigger is enabled.
- **Integration:** a `runOnce()` function processes a single message on
  demand from the Apps Script editor, with delivery pointed at a
  request-capture URL rather than the live Zap.
- Do not commit a real patient/client PDF as a fixture. Commit the derived
  text with identifying values replaced.

## Version control

Source lives in this repo under `src/` and is pushed with `clasp`. The
`.clasp.json` file holds the script ID and is committed; script properties
are configured in the Apps Script UI and are not. Three are required:
`ZAPIER_HOOK_URL`, `SENDER_ALLOWLIST` and `SUMMARY_TO`. Each accessor throws
when its property is missing, so a misconfiguration fails loudly rather than
delivering nowhere, accepting every sender, or never sending a summary.

## Portability

`extract.gs` and `validate.gs` are pure functions over a string. If this
later needs instant delivery or a custom-domain mailbox, only `gmail.gs`,
`pdf.gs` and the entry point are replaced — the extraction rules move to a
Cloudflare Worker unchanged. That is the single reason the design insists on
purity in those two files.

## Out of scope

- Storing extracted records (push-only; Zapier owns persistence).
- A pull/polling API for other consumers.
- Multiple PDF templates or format detection.
- OCR for scanned documents.
- Handling more than one PDF per email.

## Prerequisites for implementation

Settled:

1. ~~Sample PDF~~ — analysed, ten fields identified.
2. ~~Field list~~ — the `FIELDS` table above. No field is mandatory;
   extraction quality is reported rather than enforced.

Still needed:

3. The Zapier Catch Hook URL (implementation can proceed against a
   request-capture stub and have this pasted in later).
4. The Gmail account to use, and the sender allowlist.
5. A sample containing an account holder B, to verify the assumed label
   wording. Not blocking — B extracts as null until then.
