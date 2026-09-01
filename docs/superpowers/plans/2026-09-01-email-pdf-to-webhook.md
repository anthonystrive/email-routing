# Email → PDF Extraction → Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Google Apps Script that watches a Gmail mailbox, converts an attached fixed-template PDF to text, extracts thirteen fields, and POSTs them as flat JSON to a Zapier Catch Hook.

**Architecture:** A time-driven trigger runs every minute. It finds unprocessed mail carrying a PDF, converts the PDF to text via Google Drive's Docs conversion, extracts values by label/value line pairing, assembles a flat JSON payload annotated with extraction quality, and POSTs it with retries. Extraction and payload assembly are pure functions with no Apps Script dependencies, so they run under Node for testing and port to another runtime unchanged.

**Tech Stack:** Google Apps Script (V8 runtime), Gmail service, Drive advanced service v3, `clasp` for version control, Node 18+ `node --test` for unit tests. No npm runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-email-pdf-to-webhook-design.md`

## Global Constraints

- **Apps Script V8 runtime.** All `src/*.gs` files share a single global scope — there is no module system, no `require`, no `import`. Files may call each other's top-level functions freely.
- **No npm packages in `src/`.** Runtime dependencies are zero. npm is used only for the test runner, which is built into Node.
- **V8 features are available** and preferred where they read better:
  `String.prototype.normalize`, `padStart`, arrow functions. Do not target ES5.
- **Deep comparisons in tests must wrap VM values in `host(...)`** (from
  `test/load.js`). The VM is a separate realm, so arrays and objects built
  inside a `.gs` file have different intrinsics; `assert.deepStrictEqual`
  compares prototypes with `===` and fails on otherwise-identical values.
  `assert.strictEqual` on primitives is unaffected.
- **Top-level declarations in `src/*.gs` MUST use `var` or `function`, never
  `const`/`let`.** Inside function bodies `const`/`let` are preferred. This is
  not stylistic: the test harness evaluates each file with `vm.runInContext`,
  where top-level `var` and function declarations become properties of the
  shared context but `const`/`let` stay script-scoped — invisible to both
  other files and the tests. A top-level `const FIELDS` would make
  `app.FIELDS` `undefined` in every test that reads it.
- **Timezone: `Australia/Brisbane`** in `appsscript.json`. Queensland does not observe daylight saving.
- **`EXTRACTOR_VERSION` is `'1.0.0'`** and is bumped by hand whenever the `FIELDS` table changes.
- **Script properties (never committed):** `ZAPIER_HOOK_URL`, `SENDER_ALLOWLIST`.
- **Gmail labels:** `pdf-processed`, `pdf-partial`, `pdf-failed`, `pdf-ignored`.
- **No real patient data in any committed file.** All fixtures are synthesised. The original sample PDF was deleted from this repo; do not restore it.
- **Partial extraction is a normal outcome.** Missing fields are reported, never enforced. Only a total read failure or a delivery failure stops a record reaching Zapier.

## File Structure

| File | Responsibility |
|---|---|
| `src/appsscript.json` | Manifest: runtime, timezone, OAuth scopes, Drive advanced service |
| `src/config.gs` | Label names, script-property accessors, sender allowlist matching |
| `src/text.gs` | Unicode normalisation and line splitting (pure) |
| `src/transforms.gs` | `auDateToIso`, `normaliseTime` (pure) |
| `src/extract.gs` | `FIELDS` table, `extractFields`, derived booleans (pure) |
| `src/validate.gs` | `assessExtraction`, `buildPayload` (pure) |
| `src/deliver.gs` | `deliverPayload` with retry/backoff; dependency-injected fetch |
| `src/pdf.gs` | PDF blob → text via Drive conversion |
| `src/gmail.gs` | Candidate message search, attachment selection, labelling |
| `src/main.gs` | `processInbox`, `processOne`, `runOnce`, `installTrigger` |
| `test/load.js` | Loads `src/*.gs` into one shared VM context, mimicking Apps Script |
| `test/fixtures.js` | Synthesised document text fixtures |
| `test/syntax.test.js` | Asserts every `src/*.gs` parses |
| `test/*.test.js` | Unit tests per pure module |

**Deviation from the spec, deliberate:** the spec suggested a trailing
`if (typeof module !== 'undefined') module.exports = ...` in each file to make
them Node-loadable. That is rejected. `extract.gs` calls `toLines` from
`text.gs`, and CommonJS would give each file its own scope, so every
cross-file call would need wiring that does not exist in Apps Script. Instead
`test/load.js` evaluates the source files into one shared `vm` context — a
faithful reproduction of Apps Script's single global scope, and it keeps the
production files free of test scaffolding.

**Deviation from the spec, minor:** normalisation and value transforms are
split out of `extract.gs` into `text.gs` and `transforms.gs`. They are the
subtlest logic in the system and deserve their own test boundaries;
`extract.gs` stays a readable table plus a lookup.

---

### Task 1: Repository scaffolding and test harness

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `test/load.js`
- Create: `src/text.gs` (placeholder, replaced in Task 2)
- Create: `test/harness.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `loadAppsScript(files)` → an object whose properties are every top-level `var`/`function` declared in the listed `src/*.gs` files, sharing one scope. Tests use it as `const app = loadAppsScript(['text.gs', 'extract.gs'])` then call `app.extractFields(...)`.

**Note on git:** `git rev-parse --show-toplevel` currently resolves to the
user's home directory, so committing here would attach this project to an
unrelated repository containing thousands of unrelated files. Step 1 creates
a repository scoped to this project. This is reversible (`rm -rf .git`).

- [ ] **Step 1: Initialise a project-scoped git repository**

```bash
cd /Users/anthony/Documents/devbox/work-projects/email-routing
git rev-parse --show-toplevel   # confirm: currently /Users/anthony
git init
git rev-parse --show-toplevel   # confirm: now .../email-routing
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.clasp.json
.env
*.pdf
.DS_Store
```

`.clasp.json` holds the script ID, which is not a secret but is
environment-specific. `*.pdf` is a guard: no source document should ever be
committed, given they carry patient data.

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "email-routing",
  "version": "1.0.0",
  "private": true,
  "description": "Email → PDF extraction → webhook, on Google Apps Script",
  "scripts": {
    "test": "node --test test/*.test.js"
  }
}
```

No dependencies. `node --test` is built into Node 18+.

The glob is deliberate. `node --test test/` treats **every** file in a
directory named `test` as a test file, so `load.js` and `fixtures.js` would
be executed as tests and reported as failures. Matching `*.test.js`
explicitly keeps the helpers as helpers.

- [ ] **Step 4: Create `test/load.js`**

```js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

/**
 * Evaluates the given src/*.gs files into a single shared context, which is
 * how Apps Script actually runs them: one global scope, no module system.
 * Apps Script globals used at call time (UrlFetchApp, GmailApp, Drive) are
 * deliberately absent — pure modules must not touch them.
 */
function loadAppsScript(files) {
  const context = {
    console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Object,
    Array,
    RegExp,
    Error,
    isNaN,
  };
  vm.createContext(context);
  for (const file of files) {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return context;
}

module.exports = { loadAppsScript };
```

- [ ] **Step 5: Write the failing harness test**

Create `test/harness.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

test('loadAppsScript exposes top-level functions from a .gs file', () => {
  const app = loadAppsScript(['text.gs']);
  assert.strictEqual(typeof app.normaliseText, 'function');
});

test('loaded files share one global scope', () => {
  const app = loadAppsScript(['text.gs']);
  assert.strictEqual(app.normaliseText('a'), 'a');
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `ENOENT: no such file or directory ... src/text.gs`

- [ ] **Step 7: Create the placeholder `src/text.gs`**

```js
function normaliseText(raw) {
  return String(raw);
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 2 tests

- [ ] **Step 9: Commit**

```bash
git add .gitignore package.json test/load.js test/harness.test.js src/text.gs
git commit -m "chore: scaffold repo and Apps Script test harness"
```

---

### Task 2: Text normalisation

**Files:**
- Modify: `src/text.gs` (replaces the Task 1 placeholder)
- Modify: `test/load.js` (adds the `host` helper)
- Test: `test/text.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `normaliseText(raw: string) → string` — NFKC-normalised, Unicode whitespace collapsed to ASCII space, line endings normalised to `\n`
  - `toLines(raw: string) → string[]` — normalised, trimmed, empty lines dropped

**Why this matters:** the source PDF uses MacRomanEncoding. The word "first"
is stored as an `fi` ligature (`ﬁ`), and the appointment time is
separated from its meridiem by a narrow no-break space (U+202F) drawn from
a different font. Without normalisation, `'Patient first name'` never matches
the extracted `'Patient ﬁrst name'` and every field silently returns null.

- [ ] **Step 0: Add the `host` helper to `test/load.js`**

Append this function and extend the exports:

```js
/**
 * Rehydrates a value produced inside the VM into host-realm structures.
 *
 * `vm.createContext` creates a new realm with its own intrinsics, so an array
 * built inside a loaded .gs file has a different `Array.prototype` than one
 * written in a test file. `assert.deepStrictEqual` compares prototypes with
 * `===`, so it fails on values that are otherwise identical. Wrap any array
 * or object crossing that boundary before a deep comparison.
 *
 * `assert.strictEqual` on primitives is unaffected and needs no wrapping.
 */
function host(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { loadAppsScript, host };
```

Replace the existing `module.exports = { loadAppsScript };` line with the one
above — do not leave two export assignments.

- [ ] **Step 1: Write the failing tests**

Create `test/text.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript, host } = require('./load');

const app = loadAppsScript(['text.gs']);

test('folds the fi ligature to plain ascii', () => {
  assert.strictEqual(app.normaliseText('Patient \ufb01rst name'), 'Patient first name');
});

test('collapses narrow no-break space to ascii space', () => {
  assert.strictEqual(app.normaliseText('8:50\u202fam'), '8:50 am');
});

test('collapses non-breaking space to ascii space', () => {
  assert.strictEqual(app.normaliseText('Dr.\u00a0Sample'), 'Dr. Sample');
});

test('normalises CRLF and CR line endings to LF', () => {
  assert.strictEqual(app.normaliseText('a\r\nb\rc'), 'a\nb\nc');
});

test('handles null and undefined without throwing', () => {
  assert.strictEqual(app.normaliseText(null), '');
  assert.strictEqual(app.normaliseText(undefined), '');
});

test('toLines trims each line and drops empty ones', () => {
  assert.deepStrictEqual(host(app.toLines('  a  \n\n\n  b\n   \nc  ')), ['a', 'b', 'c']);
});

test('toLines applies normalisation', () => {
  assert.deepStrictEqual(host(app.toLines('Patient \ufb01rst name:\nAlex')), ['Patient first name:', 'Alex']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the ligature test fails first (`'Patient ﬁrst name'` !== `'Patient first name'`), and `app.toLines is not a function`

- [ ] **Step 3: Implement `src/text.gs`**

```js
/**
 * Unicode normalisation for text extracted from the source PDF.
 *
 * NFKC folds compatibility characters — critically the `fi` ligature
 * (U+FB01) that MacRomanEncoding produces for the word "first" — into their
 * plain ASCII equivalents. The explicit whitespace pass then catches every
 * space separator, including the narrow no-break space (U+202F) that
 * separates the appointment time from its meridiem.
 */
function normaliseText(raw) {
  if (raw === null || raw === undefined) return '';
  let text = String(raw).normalize('NFKC');
  text = text.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  text = text.replace(/\r\n?/g, '\n');
  return text;
}

/**
 * Normalised text as a list of non-empty, trimmed lines.
 *
 * Dropping empty lines is what makes label/value pairing work: the value is
 * always the next line with content on it, however the converter spaced the
 * document out.
 */
function toLines(raw) {
  return normaliseText(raw)
    .split('\n')
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line.length > 0; });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/text.gs test/load.js test/text.test.js
git commit -m "feat: add unicode normalisation and line splitting"
```

---

### Task 3: Value transforms

**Files:**
- Create: `src/transforms.gs`
- Test: `test/transforms.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `auDateToIso(value: string) → string|null` — `'D/M/YYYY'` → `'YYYY-MM-DD'`, `null` if unparseable
  - `normaliseTime(value: string) → string|null` — `'8:50 am'` → `'8:50 am'`, `null` if unparseable

**The critical behaviour:** dates are Australian day-first. `'2/9/2026'` is
2 September 2026, not 9 February. Getting this backwards produces
plausible-looking wrong appointment dates that no downstream system can
detect. The test below exists specifically to pin this down.

Transforms return `null` rather than throwing. A bad date nulls one field;
the rest of the record still reaches Zapier.

- [ ] **Step 1: Write the failing tests**

Create `test/transforms.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['transforms.gs']);

test('parses day-first Australian dates', () => {
  assert.strictEqual(app.auDateToIso('2/9/2026'), '2026-09-02');
});

test('day-first, not month-first: 2/9/2026 is September, not February', () => {
  assert.notStrictEqual(app.auDateToIso('2/9/2026'), '2026-02-09');
});

test('handles unpadded single-digit day and month', () => {
  assert.strictEqual(app.auDateToIso('5/4/1988'), '1988-04-05');
});

test('handles zero-padded input', () => {
  assert.strictEqual(app.auDateToIso('05/04/1988'), '1988-04-05');
});

test('rejects an impossible month', () => {
  assert.strictEqual(app.auDateToIso('5/13/1988'), null);
});

test('rejects a day that does not exist in that month', () => {
  assert.strictEqual(app.auDateToIso('31/2/2026'), null);
});

test('rejects malformed and empty date input', () => {
  assert.strictEqual(app.auDateToIso('not a date'), null);
  assert.strictEqual(app.auDateToIso('2026-09-02'), null);
  assert.strictEqual(app.auDateToIso(''), null);
  assert.strictEqual(app.auDateToIso(null), null);
});

test('normalises a 12-hour time with meridiem', () => {
  assert.strictEqual(app.normaliseTime('8:50 am'), '8:50 am');
});

test('normalises meridiem case and dotted forms', () => {
  assert.strictEqual(app.normaliseTime('8:50 AM'), '8:50 am');
  assert.strictEqual(app.normaliseTime('8:50 p.m.'), '8:50 pm');
});

test('normalises a time with no space before the meridiem', () => {
  assert.strictEqual(app.normaliseTime('8:50am'), '8:50 am');
});

test('rejects malformed and empty time input', () => {
  assert.strictEqual(app.normaliseTime('25:00 am'), null);
  assert.strictEqual(app.normaliseTime('8:70 am'), null);
  assert.strictEqual(app.normaliseTime('sometime'), null);
  assert.strictEqual(app.normaliseTime(''), null);
  assert.strictEqual(app.normaliseTime(null), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `app.auDateToIso is not a function`

- [ ] **Step 3: Implement `src/transforms.gs`**

```js
/**
 * Australian day-first date to ISO. '2/9/2026' is 2 September 2026.
 *
 * Round-trips through Date.UTC to reject dates that match the pattern but do
 * not exist, such as 31/2. Returns null rather than throwing so one bad
 * field does not cost the whole record.
 */
function auDateToIso(value) {
  if (value === null || value === undefined) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value).trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
  if (!valid) return null;

  return String(year).padStart(4, '0')
    + '-' + String(month).padStart(2, '0')
    + '-' + String(day).padStart(2, '0');
}

/**
 * 12-hour time to a single canonical form: 'H:MM am' / 'H:MM pm'.
 *
 * The source separates the time from its meridiem with a narrow no-break
 * space, which text.gs has already collapsed to an ordinary space by the
 * time this runs. The optional space here covers the case where it has not.
 */
function normaliseTime(value) {
  if (value === null || value === undefined) return null;
  const match = /^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?$/i.exec(String(value).trim());
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;

  return hour + ':' + String(minute).padStart(2, '0') + ' ' + match[3].toLowerCase() + 'm';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 20 tests total

- [ ] **Step 5: Commit**

```bash
git add src/transforms.gs test/transforms.test.js
git commit -m "feat: add australian date and time transforms"
```

---

### Task 4: Field extraction

**Files:**
- Create: `src/extract.gs`
- Create: `test/fixtures.js`
- Test: `test/extract.test.js`

**Interfaces:**
- Consumes: `toLines` (Task 2), `auDateToIso` and `normaliseTime` (Task 3)
- Produces:
  - `EXTRACTOR_VERSION: string`
  - `FIELDS: Array<{key, label, transform?, optional?}>`
  - `extractFields(rawText: string) → object` — every `FIELDS` key present, `null` where not found, plus derived `needs_opg` and `needs_lateral_ceph` booleans

**The document shape:** each label sits on its own line, its value on the
next non-empty line. Extraction finds the label line and takes the line after
it — no per-field regex, which means a wording change breaks one field
rather than the parser.

- [ ] **Step 1: Create `test/fixtures.js`**

All values are fictional. The original sample PDF was deleted from this repo;
these fixtures reproduce its *structure* only.

```js
// Synthesised fixtures. No real patient data — the source sample was deleted.
// Structure mirrors the "New Patient Booking Activation" template: each label
// on its own line, value on the next.

const COMPLETE = [
  'New Patient Booking Activation',
  'Patient first name:',
  'Alex',
  'Patient surname:',
  'Sample',
  'Patient gender:',
  'Male',
  'Patient date of birth:',
  '5/4/1988',
  'Patient appointment date:',
  '2/9/2026',
  'Patient appointment time:',
  '8:50 am',
  'Account holder A titled full name:',
  'Dr. Jamie R Sample',
  'Account holder A mobile number:',
  '+61-400-000-000',
  'Account holder A email:',
  'jamie@example.com',
  'Needs referral for:',
  'OPG + Lateral Cephalogram',
].join('\n');

// As delivered by the converter before normalisation: 'first' carries the
// MacRoman fi ligature, and the time uses a narrow no-break space.
const RAW_ENCODING = COMPLETE
  .replace('Patient first name:', 'Patient \ufb01rst name:')
  .replace('8:50 am', '8:50\u202fam');

const MISSING_LABEL = COMPLETE
  .replace('Patient gender:\nMale\n', '');

const BAD_DATE = COMPLETE
  .replace('5/4/1988', '05-04-88');

const WITH_ACCOUNT_HOLDER_B = COMPLETE
  .replace('Needs referral for:', [
    'Account holder B titled full name:',
    'Mr. Chris Sample',
    'Account holder B mobile number:',
    '+61-400-000-001',
    'Account holder B email:',
    'chris@example.com',
    'Needs referral for:',
  ].join('\n'));

// A label the form emitted with no value, so the next label follows it
// directly. Without a guard, that label text becomes the field's value.
const BLANK_VALUE = COMPLETE
  .replace('Account holder A email:\njamie@example.com\n', 'Account holder A email:\n');

const UNRELATED = [
  'Invoice #4471',
  'Amount due: $320.00',
  'Thank you for your business.',
].join('\n');

function withReferral(value) {
  return COMPLETE.replace('OPG + Lateral Cephalogram', value);
}

module.exports = {
  COMPLETE,
  RAW_ENCODING,
  MISSING_LABEL,
  BAD_DATE,
  WITH_ACCOUNT_HOLDER_B,
  BLANK_VALUE,
  UNRELATED,
  withReferral,
};
```

- [ ] **Step 2: Write the failing tests**

Create `test/extract.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');
const fx = require('./fixtures');

const app = loadAppsScript(['text.gs', 'transforms.gs', 'extract.gs']);

test('extracts every field from a complete document', () => {
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.patient_first_name, 'Alex');
  assert.strictEqual(record.patient_surname, 'Sample');
  assert.strictEqual(record.patient_gender, 'Male');
  assert.strictEqual(record.patient_date_of_birth, '1988-04-05');
  assert.strictEqual(record.patient_appointment_date, '2026-09-02');
  assert.strictEqual(record.patient_appointment_time, '8:50 am');
  assert.strictEqual(record.account_holder_a_name, 'Dr. Jamie R Sample');
  assert.strictEqual(record.account_holder_a_mobile, '+61-400-000-000');
  assert.strictEqual(record.account_holder_a_email, 'jamie@example.com');
  assert.strictEqual(record.needs_referral_for, 'OPG + Lateral Cephalogram');
});

test('extracts correctly from raw converter encoding', () => {
  const record = app.extractFields(fx.RAW_ENCODING);
  assert.strictEqual(record.patient_first_name, 'Alex');
  assert.strictEqual(record.patient_appointment_time, '8:50 am');
});

test('account holder B is null when absent', () => {
  const record = app.extractFields(fx.COMPLETE);
  assert.strictEqual(record.account_holder_b_name, null);
  assert.strictEqual(record.account_holder_b_mobile, null);
  assert.strictEqual(record.account_holder_b_email, null);
});

test('account holder B is extracted when present', () => {
  const record = app.extractFields(fx.WITH_ACCOUNT_HOLDER_B);
  assert.strictEqual(record.account_holder_b_name, 'Mr. Chris Sample');
  assert.strictEqual(record.account_holder_b_mobile, '+61-400-000-001');
  assert.strictEqual(record.account_holder_b_email, 'chris@example.com');
  assert.strictEqual(record.account_holder_a_name, 'Dr. Jamie R Sample');
});

test('a missing label yields null without disturbing other fields', () => {
  const record = app.extractFields(fx.MISSING_LABEL);
  assert.strictEqual(record.patient_gender, null);
  assert.strictEqual(record.patient_first_name, 'Alex');
  assert.strictEqual(record.patient_date_of_birth, '1988-04-05');
});

test('a failed transform nulls only its own field', () => {
  const record = app.extractFields(fx.BAD_DATE);
  assert.strictEqual(record.patient_date_of_birth, null);
  assert.strictEqual(record.patient_appointment_date, '2026-09-02');
  assert.strictEqual(record.patient_first_name, 'Alex');
});

test('every FIELDS key is present even when nothing matches', () => {
  const record = app.extractFields(fx.UNRELATED);
  for (const field of app.FIELDS) {
    assert.ok(field.key in record, 'missing key: ' + field.key);
    assert.strictEqual(record[field.key], null);
  }
});

test('derives both referral booleans from a compound value', () => {
  const record = app.extractFields(fx.withReferral('OPG + Lateral Cephalogram'));
  assert.strictEqual(record.needs_opg, true);
  assert.strictEqual(record.needs_lateral_ceph, true);
});

test('derives referral booleans from OPG alone', () => {
  const record = app.extractFields(fx.withReferral('OPG'));
  assert.strictEqual(record.needs_opg, true);
  assert.strictEqual(record.needs_lateral_ceph, false);
});

test('derives referral booleans from Lateral Cephalogram alone', () => {
  const record = app.extractFields(fx.withReferral('Lateral Cephalogram'));
  assert.strictEqual(record.needs_opg, false);
  assert.strictEqual(record.needs_lateral_ceph, true);
});

test('an unrecognised referral value still passes through raw', () => {
  const record = app.extractFields(fx.withReferral('Bitewing X-ray'));
  assert.strictEqual(record.needs_referral_for, 'Bitewing X-ray');
  assert.strictEqual(record.needs_opg, false);
  assert.strictEqual(record.needs_lateral_ceph, false);
});

test('referral booleans are false, not null, when the field is absent', () => {
  const record = app.extractFields(fx.UNRELATED);
  assert.strictEqual(record.needs_opg, false);
  assert.strictEqual(record.needs_lateral_ceph, false);
});

test('label matching ignores case and a missing trailing colon', () => {
  const record = app.extractFields('PATIENT FIRST NAME\nAlex');
  assert.strictEqual(record.patient_first_name, 'Alex');
});

test('a label with a blank value does not consume the next label', () => {
  const record = app.extractFields(fx.BLANK_VALUE);
  assert.strictEqual(record.account_holder_a_email, null);
  assert.strictEqual(record.needs_referral_for, 'OPG + Lateral Cephalogram');
});

test('a label with no following line yields null', () => {
  const record = app.extractFields('Patient first name:');
  assert.strictEqual(record.patient_first_name, null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ENOENT ... src/extract.gs`. (`loadAppsScript` reads each
listed file before evaluating it, so a file that does not exist yet fails on
read. A "not a function" error would instead mean the file exists but lacks
the function.)

- [ ] **Step 4: Implement `src/extract.gs`**

```js
/**
 * Bumped by hand whenever FIELDS changes, so a downstream consumer can tell
 * which ruleset produced a given record.
 */
var EXTRACTOR_VERSION = '1.0.0';

/**
 * The only place in this system that knows anything about the source
 * document. When the template changes, this table is what changes.
 *
 * `optional: true` means absence is expected and does not count against the
 * record's completeness. Account holder B is a safeguard — most bookings
 * have only one account holder, and without `optional` every single record
 * would report as incomplete.
 */
var FIELDS = [
  { key: 'patient_first_name',       label: 'Patient first name' },
  { key: 'patient_surname',          label: 'Patient surname' },
  { key: 'patient_gender',           label: 'Patient gender' },
  { key: 'patient_date_of_birth',    label: 'Patient date of birth',
    transform: auDateToIso },
  { key: 'patient_appointment_date', label: 'Patient appointment date',
    transform: auDateToIso },
  { key: 'patient_appointment_time', label: 'Patient appointment time',
    transform: normaliseTime },

  { key: 'account_holder_a_name',    label: 'Account holder A titled full name' },
  { key: 'account_holder_a_mobile',  label: 'Account holder A mobile number' },
  { key: 'account_holder_a_email',   label: 'Account holder A email' },

  { key: 'account_holder_b_name',    label: 'Account holder B titled full name',
    optional: true },
  { key: 'account_holder_b_mobile',  label: 'Account holder B mobile number',
    optional: true },
  { key: 'account_holder_b_email',   label: 'Account holder B email',
    optional: true },

  { key: 'needs_referral_for',       label: 'Needs referral for' },
];

/**
 * True when a line is itself one of the document's labels.
 *
 * The form emits a label even when its value is blank, and toLines has
 * already dropped the empty line — so without this check the NEXT label
 * would be consumed as this field's value, writing plausible-looking
 * garbage ('Needs referral for:') into an email or phone field.
 */
function isLabelLine(line) {
  var candidate = line.toLowerCase().replace(/:$/, '').trim();
  return FIELDS.some(function (field) {
    return field.label.toLowerCase().replace(/:$/, '').trim() === candidate;
  });
}

/**
 * Finds a label line and returns the next line, which is its value.
 * Comparison is case-insensitive and tolerates a missing trailing colon.
 * A label with no value of its own yields null rather than swallowing the
 * label that follows it.
 */
function findValueForLabel(lines, label) {
  const target = label.toLowerCase().replace(/:$/, '').trim();
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines[i].toLowerCase().replace(/:$/, '').trim();
    if (candidate === target) {
      if (i + 1 >= lines.length) return null;
      return isLabelLine(lines[i + 1]) ? null : lines[i + 1];
    }
  }
  return null;
}

/**
 * Document text to a flat record. Every FIELDS key is always present;
 * anything not found is null. Never throws — a document this cannot read
 * yields an all-null record, which validate.gs recognises as a failure.
 */
function extractFields(rawText) {
  const lines = toLines(rawText);
  const record = {};

  FIELDS.forEach(function (field) {
    const raw = findValueForLabel(lines, field.label);
    let value = raw;
    if (value !== null && field.transform) {
      value = field.transform(value);
    }
    record[field.key] = (value === '' || value === undefined) ? null : value;
  });

  // Derived by substring rather than by matching the three known values
  // exactly, so a fourth combination appearing later still yields correct
  // booleans. The raw string always passes through unchanged alongside them.
  const referral = record.needs_referral_for;
  record.needs_opg = referral ? /OPG/i.test(referral) : false;
  record.needs_lateral_ceph = referral ? /lateral\s+cephalogram/i.test(referral) : false;

  return record;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 35 tests total

- [ ] **Step 6: Commit**

```bash
git add src/extract.gs test/extract.test.js test/fixtures.js
git commit -m "feat: add label/value field extraction with derived referral flags"
```

---

### Task 5: Extraction assessment and payload assembly

**Files:**
- Create: `src/validate.gs`
- Test: `test/validate.test.js`

**Interfaces:**
- Consumes: `FIELDS`, `EXTRACTOR_VERSION`, `extractFields` (Task 4)
- Produces:
  - `assessExtraction(record) → {missing_fields: string[], complete: boolean, empty: boolean}`
  - `buildPayload(record, context) → object` where `context` is `{messageId, from, receivedAt}`

**Advisory, not blocking.** This never prevents delivery. It annotates the
payload so a Zap can branch on extraction quality. The one exception is
`empty` — zero populated fields means the document almost certainly was not
this template, and an empty record helps nobody.

Note that `complete` ignores `optional` fields. Without that, account holder
B being absent — the normal case — would mark every record incomplete and
make the flag worthless.

- [ ] **Step 1: Write the failing tests**

Create `test/validate.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript, host } = require('./load');
const fx = require('./fixtures');

const app = loadAppsScript(['text.gs', 'transforms.gs', 'extract.gs', 'validate.gs']);

const CONTEXT = {
  messageId: 'msg-123',
  from: 'bookings@example.com',
  receivedAt: '2026-09-01T04:31:00.000Z',
};

test('a full document with no account holder B is complete', () => {
  const assessment = app.assessExtraction(app.extractFields(fx.COMPLETE));
  assert.strictEqual(assessment.complete, true);
  assert.deepStrictEqual(host(assessment.missing_fields), []);
  assert.strictEqual(assessment.empty, false);
});

test('optional fields are excluded from missing_fields', () => {
  const assessment = app.assessExtraction(app.extractFields(fx.COMPLETE));
  assert.ok(!assessment.missing_fields.includes('account_holder_b_name'));
});

test('a missing expected field is reported and marks the record incomplete', () => {
  const assessment = app.assessExtraction(app.extractFields(fx.MISSING_LABEL));
  assert.strictEqual(assessment.complete, false);
  assert.deepStrictEqual(host(assessment.missing_fields), ['patient_gender']);
  assert.strictEqual(assessment.empty, false);
});

test('a failed transform is reported as missing', () => {
  const assessment = app.assessExtraction(app.extractFields(fx.BAD_DATE));
  assert.deepStrictEqual(host(assessment.missing_fields), ['patient_date_of_birth']);
  assert.strictEqual(assessment.complete, false);
});

test('a document matching nothing is flagged empty', () => {
  const assessment = app.assessExtraction(app.extractFields(fx.UNRELATED));
  assert.strictEqual(assessment.empty, true);
  assert.strictEqual(assessment.complete, false);
});

test('a document with one field is not empty', () => {
  const assessment = app.assessExtraction(app.extractFields('Patient surname:\nSample'));
  assert.strictEqual(assessment.empty, false);
  assert.strictEqual(assessment.complete, false);
});

test('buildPayload carries every extracted field through unchanged', () => {
  const payload = app.buildPayload(app.extractFields(fx.COMPLETE), CONTEXT);
  assert.strictEqual(payload.patient_first_name, 'Alex');
  assert.strictEqual(payload.patient_date_of_birth, '1988-04-05');
  assert.strictEqual(payload.needs_opg, true);
});

test('buildPayload keeps missing fields as explicit nulls', () => {
  const payload = app.buildPayload(app.extractFields(fx.MISSING_LABEL), CONTEXT);
  assert.ok('patient_gender' in payload);
  assert.strictEqual(payload.patient_gender, null);
});

test('buildPayload attaches complete metadata', () => {
  const payload = app.buildPayload(app.extractFields(fx.COMPLETE), CONTEXT);
  assert.strictEqual(payload._meta.message_id, 'msg-123');
  assert.strictEqual(payload._meta.from, 'bookings@example.com');
  assert.strictEqual(payload._meta.received_at, '2026-09-01T04:31:00.000Z');
  assert.strictEqual(payload._meta.extractor_version, app.EXTRACTOR_VERSION);
  assert.strictEqual(payload._meta.complete, true);
  assert.deepStrictEqual(host(payload._meta.missing_fields), []);
});

test('buildPayload reports incompleteness in metadata', () => {
  const payload = app.buildPayload(app.extractFields(fx.MISSING_LABEL), CONTEXT);
  assert.strictEqual(payload._meta.complete, false);
  assert.deepStrictEqual(host(payload._meta.missing_fields), ['patient_gender']);
});

test('the payload is flat apart from _meta', () => {
  const payload = app.buildPayload(app.extractFields(fx.COMPLETE), CONTEXT);
  for (const key of Object.keys(payload)) {
    if (key === '_meta') continue;
    const value = payload[key];
    assert.ok(value === null || typeof value !== 'object',
      'nested value at key: ' + key);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ENOENT ... src/validate.gs` (the file does not exist yet;
`loadAppsScript` reads before it evaluates).

- [ ] **Step 3: Implement `src/validate.gs`**

```js
/**
 * Reports extraction quality. Never blocks delivery — a partial record is a
 * normal outcome, and the caller decides what to do about it.
 *
 * `optional` fields are excluded from `missing_fields` and from `complete`.
 * Account holder B is absent on most bookings; counting it would mark every
 * record incomplete and render the flag useless.
 *
 * `empty` means nothing at all matched, including optional fields. That is
 * the one case the caller treats as a failure.
 */
function assessExtraction(record) {
  var missing = [];
  var populated = 0;

  FIELDS.forEach(function (field) {
    var value = record[field.key];
    var present = value !== null && value !== undefined;
    if (present) {
      populated++;
    } else if (!field.optional) {
      missing.push(field.key);
    }
  });

  return {
    missing_fields: missing,
    complete: missing.length === 0,
    empty: populated === 0
  };
}

/**
 * Assembles the flat JSON delivered to the webhook.
 *
 * Every extracted key passes through unchanged, including nulls — downstream
 * Zap steps break on absent keys, not on null values. `_meta` carries the
 * provenance and extraction quality that make a bad parse debuggable weeks
 * later.
 */
function buildPayload(record, context) {
  var assessment = assessExtraction(record);
  var payload = {};

  Object.keys(record).forEach(function (key) {
    payload[key] = record[key];
  });

  payload._meta = {
    message_id: context.messageId,
    from: context.from,
    received_at: context.receivedAt,
    extractor_version: EXTRACTOR_VERSION,
    complete: assessment.complete,
    missing_fields: assessment.missing_fields
  };

  return payload;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 46 tests total

- [ ] **Step 5: Commit**

```bash
git add src/validate.gs test/validate.test.js
git commit -m "feat: add extraction assessment and payload assembly"
```

---

### Task 6: Delivery with retry

**Files:**
- Create: `src/deliver.gs`
- Test: `test/deliver.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `deliverPayload(payload, url, deps?) → {ok: boolean, attempts: number, status: number|null, permanent?: boolean, error?: string}`
  - `postJson(url, payload) → number` — the real `UrlFetchApp` call, used as the default transport

**Why dependency injection:** `UrlFetchApp` exists only inside Apps Script,
and retry logic with backoff is exactly the kind of code that is wrong in
subtle ways. `deps` lets the tests drive every branch — 5xx retries, 4xx
giving up immediately, thrown network errors, backoff timing — without a
network or a live Zap. In production `deps` is omitted and the real transport
is used.

**Retry policy:** 5xx and thrown errors retry up to 3 attempts with
exponential backoff (1s, 2s). 4xx is permanent and does not retry — a
rejected payload will be rejected again, and Apps Script's daily quota is
finite.

- [ ] **Step 1: Write the failing tests**

Create `test/deliver.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['deliver.gs']);

/** Returns a transport that yields the given statuses in order. */
function transportReturning(statuses) {
  const calls = [];
  const fetchJson = (url, payload) => {
    calls.push({ url, payload });
    const next = statuses[calls.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchJson, calls };
}

function recordingSleep() {
  const delays = [];
  return { sleep: (ms) => delays.push(ms), delays };
}

test('succeeds on the first attempt', () => {
  const t = transportReturning([200]);
  const result = app.deliverPayload({ a: 1 }, 'https://hook.example', { fetchJson: t.fetchJson });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.attempts, 1);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(t.calls.length, 1);
});

test('passes the url and payload to the transport', () => {
  const t = transportReturning([200]);
  app.deliverPayload({ a: 1 }, 'https://hook.example', { fetchJson: t.fetchJson });
  assert.strictEqual(t.calls[0].url, 'https://hook.example');
  assert.deepStrictEqual(t.calls[0].payload, { a: 1 });
});

test('accepts any 2xx status', () => {
  const t = transportReturning([204]);
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson });
  assert.strictEqual(result.ok, true);
});

test('retries a 5xx and succeeds', () => {
  const t = transportReturning([500, 200]);
  const s = recordingSleep();
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson, sleep: s.sleep });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(t.calls.length, 2);
});

test('gives up after three 5xx attempts', () => {
  const t = transportReturning([500, 502, 503]);
  const s = recordingSleep();
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson, sleep: s.sleep });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.attempts, 3);
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.permanent, false);
});

test('backs off exponentially between retries', () => {
  const t = transportReturning([500, 500, 500]);
  const s = recordingSleep();
  app.deliverPayload({}, 'u', { fetchJson: t.fetchJson, sleep: s.sleep });
  assert.deepStrictEqual(s.delays, [1000, 2000]);
});

test('does not retry a 4xx', () => {
  const t = transportReturning([400, 200]);
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.attempts, 1);
  assert.strictEqual(result.permanent, true);
  assert.strictEqual(t.calls.length, 1);
});

test('retries a thrown network error', () => {
  const t = transportReturning([new Error('DNS failure'), 200]);
  const s = recordingSleep();
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson, sleep: s.sleep });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.attempts, 2);
});

test('reports the last error when every attempt throws', () => {
  const t = transportReturning([new Error('a'), new Error('b'), new Error('c')]);
  const s = recordingSleep();
  const result = app.deliverPayload({}, 'u', { fetchJson: t.fetchJson, sleep: s.sleep });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /c/);
});

test('honours a custom attempt limit', () => {
  const t = transportReturning([500, 500, 500, 500, 500]);
  const s = recordingSleep();
  const result = app.deliverPayload({}, 'u',
    { fetchJson: t.fetchJson, sleep: s.sleep, maxAttempts: 5 });
  assert.strictEqual(result.attempts, 5);
  assert.strictEqual(t.calls.length, 5);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ENOENT ... src/deliver.gs` (the file does not exist yet;
`loadAppsScript` reads before it evaluates).

- [ ] **Step 3: Implement `src/deliver.gs`**

```js
/**
 * POSTs the payload as JSON, retrying transient failures.
 *
 * `deps` exists for testing: it injects the transport and the sleep so every
 * retry branch can be driven without a network. Production callers omit it.
 *
 * 5xx and thrown errors retry with exponential backoff. 4xx does not — a
 * payload the endpoint rejects will be rejected again, and the daily
 * UrlFetch quota is finite.
 */
function deliverPayload(payload, url, deps) {
  deps = deps || {};
  var fetchJson = deps.fetchJson || postJson;
  var sleep = deps.sleep || function (ms) { Utilities.sleep(ms); };
  var maxAttempts = deps.maxAttempts || 3;

  var lastStatus = null;
  var lastError = null;

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      var status = fetchJson(url, payload);
      if (status >= 200 && status < 300) {
        return { ok: true, attempts: attempt, status: status };
      }
      if (status >= 400 && status < 500) {
        return { ok: false, attempts: attempt, status: status, permanent: true };
      }
      lastStatus = status;
    } catch (err) {
      lastError = String(err);
    }

    if (attempt < maxAttempts) {
      sleep(Math.pow(2, attempt - 1) * 1000);
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    status: lastStatus,
    error: lastError,
    permanent: false
  };
}

/**
 * The real transport. `muteHttpExceptions` keeps a non-2xx response as a
 * status code rather than a thrown exception, so deliverPayload can decide
 * whether it is worth retrying.
 */
function postJson(url, payload) {
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return response.getResponseCode();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 56 tests total

- [ ] **Step 5: Commit**

```bash
git add src/deliver.gs test/deliver.test.js
git commit -m "feat: add webhook delivery with retry and backoff"
```

---

### Task 7: Manifest and configuration

**Files:**
- Create: `src/appsscript.json`
- Create: `src/config.gs`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `LABELS: {processed, partial, failed, ignored}`
  - `getHookUrl() → string` — throws if the script property is unset
  - `getAllowlist() → string[]` — lowercased, trimmed
  - `extractEmailAddress(from: string) → string` — `'Name <a@b.com>'` → `'a@b.com'`
  - `isAllowedSender(from: string, allowlist: string[]) → boolean`

**The allowlist is the security boundary.** The mailbox address is
effectively public once anyone learns it, and without this check anyone could
email a crafted PDF and inject records into the practice's downstream
systems. An entry beginning with `@` matches a whole domain; anything else
must match the address exactly.

`getHookUrl` and `getAllowlist` throw on a missing property rather than
returning empty. Silently delivering nowhere, or silently accepting every
sender, are both worse than a loud failure in the execution log.

- [ ] **Step 1: Create `src/appsscript.json`**

```json
{
  "timeZone": "Australia/Brisbane",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "Drive",
        "serviceId": "drive",
        "version": "v3"
      }
    ]
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp"
  ]
}
```

Each scope earns its place: `gmail.modify` to read messages and apply labels,
`drive.file` to create and delete the temporary Doc (scoped to files this
script itself creates, not the whole Drive), `documents` to read its text,
`script.external_request` to POST to Zapier, `script.scriptapp` to install
the trigger. Queensland does not observe daylight saving, hence
`Australia/Brisbane`.

- [ ] **Step 2: Write the failing tests**

Create `test/config.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['config.gs']);

test('defines the four gmail labels', () => {
  assert.strictEqual(app.LABELS.processed, 'pdf-processed');
  assert.strictEqual(app.LABELS.partial, 'pdf-partial');
  assert.strictEqual(app.LABELS.failed, 'pdf-failed');
  assert.strictEqual(app.LABELS.ignored, 'pdf-ignored');
});

test('extracts an address from a display-name form', () => {
  assert.strictEqual(app.extractEmailAddress('Tops Ortho <bookings@example.com>'),
    'bookings@example.com');
});

test('accepts a bare address', () => {
  assert.strictEqual(app.extractEmailAddress('bookings@example.com'),
    'bookings@example.com');
});

test('lowercases and trims the extracted address', () => {
  assert.strictEqual(app.extractEmailAddress('  Bookings@Example.COM  '),
    'bookings@example.com');
});

test('returns empty string for missing input', () => {
  assert.strictEqual(app.extractEmailAddress(null), '');
  assert.strictEqual(app.extractEmailAddress(''), '');
});

test('allows an exactly matching address', () => {
  assert.strictEqual(
    app.isAllowedSender('Tops Ortho <bookings@example.com>', ['bookings@example.com']),
    true);
});

test('allows any address on an allowlisted domain', () => {
  assert.strictEqual(app.isAllowedSender('anyone@clinic.com.au', ['@clinic.com.au']), true);
});

test('rejects an address not on the allowlist', () => {
  assert.strictEqual(app.isAllowedSender('attacker@evil.com', ['bookings@example.com']), false);
});

test('rejects a domain that merely ends with an allowlisted one', () => {
  assert.strictEqual(app.isAllowedSender('someone@notclinic.com.au', ['@clinic.com.au']), false);
});

test('rejects everything when the allowlist is empty', () => {
  assert.strictEqual(app.isAllowedSender('bookings@example.com', []), false);
});

test('rejects a missing sender', () => {
  assert.strictEqual(app.isAllowedSender(null, ['bookings@example.com']), false);
});

test('a decoy address in a quoted display name does not win', () => {
  assert.strictEqual(
    app.extractEmailAddress('"Trusted <bookings@example.com>" <attacker@evil.com>'),
    'attacker@evil.com');
});

test('a header with several angle-addrs is rejected', () => {
  assert.strictEqual(
    app.extractEmailAddress('Real Name <bookings@example.com> <attacker@evil.com>'),
    '');
});

test('a decoy display name does not pass the allowlist', () => {
  assert.strictEqual(
    app.isAllowedSender('"Trusted <bookings@example.com>" <attacker@evil.com>',
      ['bookings@example.com']),
    false);
});

test('a header containing a comment is rejected', () => {
  assert.strictEqual(
    app.extractEmailAddress('<attacker@evil.com> (note: <bookings@example.com>)'),
    '');
});

test('a comment decoy does not pass the allowlist', () => {
  assert.strictEqual(
    app.isAllowedSender('<attacker@evil.com> (note: <bookings@example.com>)',
      ['bookings@example.com']),
    false);
});

test('a multi-mailbox From is rejected outright', () => {
  assert.strictEqual(
    app.extractEmailAddress('attacker@evil.com, "Second" <bookings@example.com>'),
    '');
  assert.strictEqual(
    app.isAllowedSender('attacker@evil.com, "Second" <bookings@example.com>',
      ['bookings@example.com']),
    false);
});

test('legitimate address forms still extract correctly', () => {
  assert.strictEqual(app.extractEmailAddress('bookings+tag@example.com'), 'bookings+tag@example.com');
  assert.strictEqual(app.extractEmailAddress('user@sub.example.museum'), 'user@sub.example.museum');
});

test('a nested comment cannot smuggle a decoy', () => {
  assert.strictEqual(
    app.extractEmailAddress('<attacker@evil.com> (note (x) <bookings@example.com>)'),
    '');
  assert.strictEqual(
    app.isAllowedSender('<attacker@evil.com> (note (x) <bookings@example.com>)',
      ['bookings@example.com']),
    false);
});

test('an unquoted comma in a display name is still accepted', () => {
  assert.strictEqual(
    app.extractEmailAddress('Smith, John <john@clinic.com.au>'),
    'john@clinic.com.au');
});

test('a quoted comma in a display name is still accepted', () => {
  assert.strictEqual(
    app.extractEmailAddress('"Smith, John" <john@clinic.com.au>'),
    'john@clinic.com.au');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ENOENT ... src/config.gs` (the file does not exist yet;
`loadAppsScript` reads before it evaluates).

- [ ] **Step 4: Implement `src/config.gs`**

```js
var LABELS = {
  processed: 'pdf-processed',
  partial: 'pdf-partial',
  failed: 'pdf-failed',
  ignored: 'pdf-ignored'
};

/**
 * Throws rather than returning empty. A missing hook URL means delivering
 * nowhere; a missing allowlist means accepting every sender. Both are worse
 * silently than loudly.
 */
function getScriptProperty(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) {
    throw new Error('Missing required script property: ' + name);
  }
  return value;
}

function getHookUrl() {
  return getScriptProperty('ZAPIER_HOOK_URL');
}

function getAllowlist() {
  return getScriptProperty('SENDER_ALLOWLIST')
    .split(',')
    .map(function (entry) { return entry.trim().toLowerCase(); })
    .filter(function (entry) { return entry.length > 0; });
}

/**
 * Address forms this system accepts from a From header. Deliberately narrow:
 * no angle brackets, commas, parens or quotes inside the address itself.
 */
var ADDR_PATTERN = '[^\\s<>@,()"]+@[^\\s<>@,()"]+';

/**
 * 'Tops Ortho <bookings@example.com>' -> 'bookings@example.com'
 *
 * Security-critical, and a whitelist by design. RFC 5322 lets a sender hide
 * a decoy address inside a quoted display name or a (possibly nested)
 * comment, and stripping those constructs kept missing variants. So instead
 * of removing what looks dangerous, this accepts only three shapes that are
 * unambiguous and returns '' for everything else — including multi-mailbox
 * headers and anything containing a comment. The caller then fails closed.
 *
 * A rejected header shows up as a pdf-ignored label in Gmail, which is
 * visible and recoverable. Silently trusting a forged sender is not.
 */
function extractEmailAddress(from) {
  if (!from) return '';
  var text = String(from).trim();

  // 1. A bare address and nothing else.
  if (new RegExp('^' + ADDR_PATTERN + '$').test(text)) {
    return text.toLowerCase();
  }

  // 2. A quoted display name, then exactly one angle-addr at the very end.
  //    The quoted part may contain a decoy — it is not the address.
  var quoted = new RegExp('^"(?:[^"\\\\]|\\\\.)*"\\s*<(' + ADDR_PATTERN + ')>$').exec(text);
  if (quoted) return quoted[1].toLowerCase();

  // 3. An unquoted display name, then exactly one angle-addr. The display
  //    name may contain a comma ('Smith, John') but not '@', '<', '>', '(',
  //    ')' or '"' — those are how a second address gets smuggled in.
  var plain = new RegExp('^[^<>()"@]*<(' + ADDR_PATTERN + ')>$').exec(text);
  if (plain) return plain[1].toLowerCase();

  return '';
}

/**
 * The security boundary. The mailbox address is effectively public once
 * anyone learns it; without this, a crafted PDF from any sender would flow
 * straight into the practice's downstream systems.
 *
 * An entry starting with '@' matches a whole domain. The leading '@' is what
 * stops 'notclinic.com.au' matching an allowlisted 'clinic.com.au'.
 */
function isAllowedSender(from, allowlist) {
  var address = extractEmailAddress(from);
  if (!address) return false;
  return allowlist.some(function (entry) {
    if (entry.charAt(0) === '@') {
      return address.endsWith(entry);
    }
    return address === entry;
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 77 tests total

- [ ] **Step 6: Commit**

```bash
git add src/appsscript.json src/config.gs test/config.test.js
git commit -m "feat: add manifest, config accessors and sender allowlist"
```

---

### Task 8: PDF to text via Drive

**Files:**
- Create: `src/pdf.gs`

**Interfaces:**
- Consumes: nothing
- Produces: `pdfToText(blob) → string` — throws if conversion or reading fails

**No unit test.** Every line of this function is a call into a Google service.
Mocking `Drive` and `DocumentApp` would test the mock, not the conversion.
It is verified for real in Task 11, against a live message.

**The cleanup matters.** The temporary Doc is a full copy of a document
carrying patient data. `Drive.Files.remove` deletes it outright rather than
trashing it, because trashed files persist until the trash is emptied. The
`finally` block ensures a failure while reading the text still removes the
copy.

- [ ] **Step 1: Implement `src/pdf.gs`**

```js
/**
 * PDF blob to plain text, via Drive's PDF-to-Docs conversion.
 *
 * Apps Script has no PDF library. Uploading a PDF with a Google Docs target
 * mime type makes Drive convert it, and DocumentApp can then read the text.
 * For a text-layer PDF this is clean; it is not OCR and does not need to be.
 *
 * The temporary Doc is a copy of a document containing patient data, so it
 * is deleted outright rather than trashed, in a finally block so a failure
 * while reading still removes it.
 */
function pdfToText(blob) {
  var tempFile = Drive.Files.create(
    {
      name: 'tmp-pdf-extract-' + Utilities.getUuid(),
      mimeType: MimeType.GOOGLE_DOCS
    },
    blob
  );

  try {
    return DocumentApp.openById(tempFile.id).getBody().getText();
  } finally {
    try {
      Drive.Files.remove(tempFile.id);
    } catch (err) {
      // Never let cleanup failure mask the real outcome — but do make it
      // visible, since an orphaned copy holds patient data.
      console.error('Temporary Doc cleanup failed for ' + tempFile.id + ': ' + err);
    }
  }
}
```

- [ ] **Step 2: Verify the file parses**

Note: `node --check src/pdf.gs` does NOT work — Node rejects the `.gs`
extension with `ERR_UNKNOWN_FILE_EXTENSION` without reading the file. Use:

```bash
node -e "new (require('vm').Script)(require('fs').readFileSync('src/pdf.gs','utf8'))" && echo "parses"
```

Expected: `parses`. Task 10 adds `test/syntax.test.js`, which makes this a
permanent part of the suite for every `.gs` file.

- [ ] **Step 3: Confirm the existing suite still passes**

Run: `npm test`
Expected: PASS, 77 tests

- [ ] **Step 4: Commit**

```bash
git add src/pdf.gs
git commit -m "feat: add pdf to text conversion via drive"
```

---

### Task 9: Gmail intake and labelling

**Files:**
- Create: `src/gmail.gs`
- Test: `test/gmail.test.js`

**Interfaces:**
- Consumes: `LABELS` (Task 7)
- Produces:
  - `buildSearchQuery() → string`
  - `findCandidates(maxThreads?) → Array<{thread, attachment, from, messageId, receivedAt}>`
  - `firstPdfAttachment(message) → GmailAttachment|null`
  - `applyLabel(thread, labelName) → void`
  - `ensureLabels() → void`

Only `buildSearchQuery` is unit-testable — the rest are thin wrappers over
`GmailApp`. The query is worth testing because a typo in it fails silently:
the job simply finds nothing, forever, with no error.

- [ ] **Step 1: Write the failing tests**

Create `test/gmail.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['config.gs', 'gmail.gs']);

test('the query requires a pdf attachment', () => {
  const query = app.buildSearchQuery();
  assert.match(query, /has:attachment/);
  assert.match(query, /filename:pdf/);
});

test('the query carries no label exclusions', () => {
  // Regression guard. Label exclusions are thread-scoped and would hide later
  // bookings in an already-handled conversation. Do not "restore" them.
  assert.ok(!/-label:/.test(app.buildSearchQuery()));
});

test('the query is bounded in time', () => {
  assert.match(app.buildSearchQuery(), /newer_than:7d/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ENOENT ... src/gmail.gs` (the file does not exist yet;
`loadAppsScript` reads before it evaluates).

- [ ] **Step 3: Implement `src/gmail.gs`**

```js
/**
 * Excludes every terminal label so a message is considered exactly once.
 * The time bound stops the job re-examining the whole mailbox once it has
 * been running for months; nothing older than a week is worth retrying
 * automatically.
 */
function buildSearchQuery() {
  return 'has:attachment filename:pdf newer_than:7d';
}

// NOTE: this query deliberately carries NO label exclusions. Labels are
// thread-scoped, and these same-subject, same-sender bookings share one Gmail
// conversation, so any `-label:` term would hide every later booking in a
// thread that had already been handled — silently, with no error and no
// count. dedupe.gs holds the per-message record that decides what is skipped.
// Restoring a label exclusion here reintroduces silent data loss.

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 80 tests total

- [ ] **Step 5: Commit**

```bash
git add src/gmail.gs test/gmail.test.js
git commit -m "feat: add gmail intake, attachment selection and labelling"
```

---

### Task 10: Orchestration

**Files:**
- Create: `src/main.gs`

**Interfaces:**
- Consumes: everything from Tasks 2–9
- Produces:
  - `processInbox() → void` — the trigger entry point
  - `processOne(candidate, hookUrl, allowlist) → string` (the label its thread has earned; it does not apply it)
  - `worseOutcome(a, b) → string`
  - `runOnce() → void` — manual single-message run, for the editor
  - `installTrigger() → void`

**No unit test.** Every branch here is already covered by the pure modules;
this file only wires them together and calls Gmail. It is verified for real
in Task 11.

**The lock matters.** The trigger fires every minute and a run that hits a
slow Drive conversion can overrun. Without the lock, two runs could process
the same message and deliver it twice.

**Why labelling is deferred to the end of a thread.** Gmail labels apply to a
whole thread, but candidates are per message. Every booking email carries the
same subject from the same sender — exactly the shape Gmail may group into a
single thread — so a thread can hold several PDFs. If the thread were
labelled as each message finished and the run were then truncated (Apps
Script caps execution at six minutes), the search's `-label:` exclusion would
drop the entire thread from every future run and the unprocessed bookings
would be silently lost. So `processOne` returns an outcome instead of
applying a label, and `processInbox` applies one label per thread once all
of that thread's messages are done, using the worst outcome seen.

- [ ] **Step 1: Implement `src/main.gs`**

```js
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
        // An unlabelled thread is reprocessed next tick and its records
        // delivered a second time, so failing to label is worth shouting
        // about — but only this thread is affected.
        console.error('Failed to label thread ' + id
          + ' as ' + byThread[id].label + ': ' + err);
      }
    });

    // Labels are applied by this point, so nothing will be re-delivered.
    // But an unexpected exception means a bug, not a bad document, and
    // swallowing it would cost us Apps Script's own failed-trigger email to
    // the owner — the only alert that does not require someone to go and
    // read Cloud Logging. A systemic fault would otherwise mark every
    // booking pdf-failed in silence, and pdf-failed threads are never
    // retried. Ordinary pdf-failed outcomes do not reach here.
    if (unexpectedFailures > 0) {
      throw new Error(unexpectedFailures + ' message(s) failed unexpectedly this run; '
        + 'see the preceding log lines. Threads have been labelled, so nothing '
        + 'will be re-delivered.');
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
```

- [ ] **Step 2: Add a syntax test covering every `.gs` file**

`node --check` cannot read a `.gs` file at all — Node rejects the unknown
extension with `ERR_UNKNOWN_FILE_EXTENSION` before looking at the contents,
so it never verified anything. `main.gs` and `pdf.gs` are also the only two
source files no test loads, which means a syntax error in either would reach
production unnoticed.

Create `test/syntax.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

// Every .gs file must parse. Most are covered because a test loads them,
// but pdf.gs and main.gs are pure Apps Script service wiring that no test
// can execute — this is the only thing standing between a typo in them and
// a failed deploy.
for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.gs'))) {
  test(`${file} parses`, () => {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }));
  });
}
```

- [ ] **Step 3: Confirm the full suite still passes**

Run: `npm test`
Expected: PASS, 89 tests (80 + one per `.gs` file: text,
transforms, extract, validate, deliver, config, pdf, gmail, main)

- [ ] **Step 4: Commit**

```bash
git add src/main.gs test/syntax.test.js
git commit -m "feat: add orchestration, manual run and trigger installation"
```

---

### Task 11: Deploy and verify end to end

**Files:**
- Create: `.clasp.json` (generated, gitignored)
- Create: `.claspignore`
- Create: `README.md`

**Interfaces:**
- Consumes: everything
- Produces: a running system

**This task is where the design meets reality.** The sample PDF was deleted,
so every fixture is synthesised — meaning Drive's actual conversion output
has never been seen. If the converter formats the document differently from
the assumed label/value line pairs, it surfaces here, at Step 9. That is the
expected place to find it, and the fix is confined to `extract.gs`.

**Prerequisites** — gather before starting:
- The Gmail account this runs under. Prefer a dedicated account over a
  personal one: the script gets read access to the whole mailbox and to
  Drive, and these documents carry health information.
- The sender allowlist (addresses or `@domain` entries, comma-separated).
- A request-capture URL for testing (e.g. from webhook.site) — used first.
- The real Zapier Catch Hook URL — used only at Step 11.
- A real booking PDF, emailed to the mailbox from an allowlisted sender. Do
  not commit it.

- [ ] **Step 1: Install clasp and authenticate**

```bash
npm install -g @google/clasp
clasp login
```

This opens a browser. Sign in as the Google account that will own the script.

- [ ] **Step 2: Create the Apps Script project**

```bash
clasp create --type standalone --title "Email PDF Routing" --rootDir ./src
```

`--rootDir ./src` tells clasp that `src/` is the script root, so files push as
`text.gs`, `extract.gs` and so on rather than nested.

- [ ] **Step 3: Create `.claspignore`**

```
**/**
!appsscript.json
!*.gs
```

Without this, clasp attempts to push `test/`, `docs/` and `node_modules/`.
The pattern excludes everything, then re-includes the manifest and the
script files.

- [ ] **Step 4: Confirm `.clasp.json` is not tracked**

```bash
git status --short
```

Expected: `.clasp.json` does not appear (it is in `.gitignore` from Task 1).
If it does appear, stop and fix `.gitignore` before continuing.

- [ ] **Step 5: Push the code**

```bash
clasp push
clasp open
```

`clasp open` opens the script in the browser for the remaining steps.

- [ ] **Step 6: Enable the Drive advanced service**

In the Apps Script editor: **Services** (+) → **Drive API** → set version to
**v3** → **Add**. The identifier must read `Drive`.

The manifest declares this, but the editor also needs it enabled on the
project itself. `Drive.Files.create` throws `ReferenceError: Drive is not
defined` if this step is skipped.

**If Step 9 later fails with a Drive permission error**, the cause is almost
certainly the `drive.file` scope being insufficient for the conversion.
Widen it to `https://www.googleapis.com/auth/drive` in
`src/appsscript.json`, `clasp push`, and re-approve the consent screen. The
narrower scope is the correct default — it limits the script to files it
creates itself rather than the whole Drive — but this is the one place it
could bite, and the fix is one line.

- [ ] **Step 7: Set the script properties**

In the editor: **Project Settings** → **Script Properties** → add:

| Property | Value |
|---|---|
| `ZAPIER_HOOK_URL` | the request-capture URL, **not** the live Zap yet |
| `SENDER_ALLOWLIST` | e.g. `bookings@clinic.com.au,@clinic.com.au` |
| `SUMMARY_TO` | the address the daily summary is emailed to |

All three are required. Each accessor throws if its property is missing, so a
missing value fails loudly in the execution log rather than silently
delivering nowhere, accepting every sender, or never sending a summary.

- [ ] **Step 7a: Delete any stale `sent:*` script properties**

Only relevant if you ran an earlier build of this script. An intermediate
version recorded delivered messages under a `sent:` prefix; the current one
uses `seen:`. Stale `sent:*` entries are never read and never pruned, and a
message recorded only under the old prefix would be delivered once more.
Delete any you see in **Project Settings → Script Properties**. A fresh
install has none.

- [ ] **Step 7b: Suppress the existing backlog, if you want to**

The search window is seven days and the processed-message store starts empty,
so the first unattended run would otherwise process **every** booking PDF
already sitting in the mailbox from an allowlisted sender within that window,
and deliver them all to the Zap.

If that is not what you want, run `seedBacklog` once from the editor. It marks
every currently-matching message as already handled — without delivering
anything — and logs how many it seeded.

**Do not suppress a backlog by applying labels.** Labels are thread-scoped and
these bookings share a subject and sender, so Gmail groups them into one
conversation; labelling a thread would suppress every *future* booking that
lands in it too, silently. `seedBacklog` records individual messages, which is
why it is safe.

- [ ] **Step 8: Send a test email**

From an allowlisted sender, email a real booking PDF to the mailbox. Wait for
it to arrive. Do not install the trigger yet.

- [ ] **Step 9: Run `runOnce` and inspect the result**

In the editor, select `runOnce` from the function dropdown and click **Run**.
Approve the OAuth consent screen when prompted (it lists the five scopes from
the manifest).

Check three things:
1. **The execution log** shows the message being processed with no errors.
2. **The request-capture endpoint** received a JSON payload.
3. **Every field in that payload is correct** — particularly
   `patient_date_of_birth` and `patient_appointment_date`. Confirm against the
   PDF that the day and month are the right way round.

If fields are null that should not be, the converter's output does not match
the assumed structure. Add a temporary `console.log(text)` inside `runOnce`,
inspect the real text, and adjust `extract.gs`. This is the expected failure
point and the reason this step exists before the trigger is installed.

- [ ] **Step 10: Confirm the temporary Doc was cleaned up**

Open Drive and search for `tmp-pdf-extract`. Expected: no results, and
nothing in the trash. An orphan here means a copy of a patient document is
sitting in Drive.

- [ ] **Step 11: Point at the live Zap and re-verify**

Update `ZAPIER_HOOK_URL` to the real Catch Hook. Send a second test email and
run `runOnce` again. Confirm the Zap receives the record and that its field
mapping is correct.

- [ ] **Step 12: Install the trigger**

In the editor, select `installTrigger` and click **Run**. Then confirm under
**Triggers** that exactly one `processInbox` trigger exists, running every
minute.

- [ ] **Step 13: Verify unattended operation**

Send a third test email and do nothing. Within two minutes, confirm the Zap
received it and the Gmail thread carries `pdf-processed` (or `pdf-partial`).

- [ ] **Step 13b: Verify two bookings in one thread both arrive**

This is the single most important live check, because the failure it guards
against is silent. Send two booking emails **with the same subject, from the
same sender**, a minute or so apart — the shape Gmail groups into one
conversation.

Confirm the Zap received **both** records. Then look at the mailbox: if Gmail
did group them into one thread, that is exactly the case that would have lost
the second booking under thread-level tracking, with no error anywhere. The
delivered-message store is what makes both arrive.

If only one record arrives, stop and report it — do not leave the trigger
running.

- [ ] **Step 14: Verify the allowlist rejects an outsider**

From an address **not** on the allowlist, email any PDF to the mailbox.
Within two minutes, confirm the thread is labelled `pdf-ignored` and that
nothing reached the Zap. This is the security boundary; test it rather than
assuming it.

- [ ] **Step 15: Write `README.md`**

```markdown
# Email → PDF Extraction → Webhook

Watches a Gmail mailbox for a fixed-template PDF ("New Patient Booking
Activation", produced by Tops Ortho), extracts its fields, and POSTs them as
flat JSON to a Zapier Catch Hook. Runs on Google Apps Script. No server, no
database, no running cost.

- **Design:** `docs/superpowers/specs/2026-09-01-email-pdf-to-webhook-design.md`
- **Plan:** `docs/superpowers/plans/2026-09-01-email-pdf-to-webhook.md`

## Development

    npm test          # unit tests for the pure modules
    clasp push        # deploy to Apps Script
    clasp open        # open the project in the browser

`src/*.gs` share one global scope, as Apps Script requires. Top-level
declarations must use `var` or `function`, never `const`/`let` — the test
harness in `test/load.js` reads them off a shared VM context, and
`const`/`let` are invisible to it.

## Configuration

Script properties, set in the Apps Script editor and never committed:

| Property | Purpose |
|---|---|
| `ZAPIER_HOOK_URL` | Catch Hook the payload is POSTed to |
| `SENDER_ALLOWLIST` | Comma-separated addresses or `@domain` entries |

## Gmail labels

| Label | Meaning |
|---|---|
| `pdf-processed` | Delivered, every expected field present |
| `pdf-partial` | Delivered, some fields missing — see `_meta.missing_fields` |
| `pdf-failed` | Not delivered — conversion, extraction or delivery failed |
| `pdf-ignored` | Sender not on the allowlist |

## When the template changes

Edit the `FIELDS` table in `src/extract.gs` and bump `EXTRACTOR_VERSION`.
That table is the only place the document's structure is described.

## Privacy

These documents carry identifiable health information. No real patient data
belongs in this repository — fixtures are synthesised, and `.gitignore`
excludes `*.pdf` as a guard. The temporary Google Doc created during
conversion is deleted outright, not trashed.
```

- [ ] **Step 16: Commit**

```bash
git add .claspignore README.md
git commit -m "docs: add readme and clasp configuration"
```

---

### Task 12: Daily failure summary (optional)

**Files:**
- Create: `src/summary.gs`
- Test: `test/summary.test.js`

**Interfaces:**
- Consumes: `LABELS` (Task 7)
- Produces:
  - `buildSummaryQuery(labelName) → string`
  - `sendDailySummary() → void`
  - `installSummaryTrigger() → void`

**Why this exists.** Partial records are delivered silently by design. A
template change that quietly breaks one field would otherwise go unnoticed
indefinitely — the Zap keeps firing, just with a null where a value used to
be. A daily count makes that visible as a rising number.

Skip this task if the volume is low enough that you will notice by eye.

- [ ] **Step 1: Write the failing tests**

Create `test/summary.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./load');

const app = loadAppsScript(['config.gs', 'summary.gs']);

test('scopes the summary query to one label and the last day', () => {
  const query = app.buildSummaryQuery('pdf-failed');
  assert.match(query, /label:pdf-failed/);
  assert.match(query, /newer_than:1d/);
});

test('builds a query for the partial label too', () => {
  assert.match(app.buildSummaryQuery(app.LABELS.partial), /label:pdf-partial/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ENOENT ... src/summary.gs` (the file does not exist yet;
`loadAppsScript` reads before it evaluates).

- [ ] **Step 3: Implement `src/summary.gs`**

```js
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
```

`GmailApp.sendEmail` needs a broader scope than `gmail.modify`. Add
`https://www.googleapis.com/auth/gmail.send` to `oauthScopes` in
`src/appsscript.json` when doing this task, and re-approve the consent screen
on the next run.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 92 tests total

- [ ] **Step 5: Deploy and install**

```bash
clasp push
```

Then in the editor, run `installSummaryTrigger` once.

- [ ] **Step 6: Commit**

```bash
git add src/summary.gs test/summary.test.js src/appsscript.json
git commit -m "feat: add daily failure and partial summary"
```

---

## Verification

The plan is complete when all of the following hold:

- [ ] `npm test` passes with no failures.
- [ ] A real booking PDF, emailed from an allowlisted sender, reaches the Zap within two minutes with every field correct — dates verified day-first against the source document.
- [ ] A PDF from a non-allowlisted sender is labelled `pdf-ignored` and reaches nothing.
- [ ] Drive contains no `tmp-pdf-extract` files, including in the trash.
- [ ] `git status` shows no `.pdf` and no `.clasp.json` tracked.
- [ ] Exactly one `processInbox` trigger exists in the Apps Script Triggers list.

## Known limitations, carried from the spec

- Handles one PDF per email; a second attachment is ignored.
- One template only — no format detection, no OCR for scanned documents.
- Push-only. If Zapier is down beyond the retries, the record is labelled `pdf-failed` and must be re-sent by hand (remove the label to have it retried).
- Account holder B labels are assumed to mirror A's; unverified until a B document arrives.
- Up to one minute of latency by design.
