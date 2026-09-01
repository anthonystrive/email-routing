const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

/**
 * Apps Script has no module system: every .gs file is evaluated into one
 * global scope, in project order, and `clasp push` defaults that order to
 * alphabetical. Nothing in this repo controls it, so any top-level expression
 * that dereferences a name from another file is a deploy-time ReferenceError
 * waiting on the alphabet.
 *
 * This test evaluates the real files in the worst plausible order — plain
 * alphabetical, the same order clasp uses — and fails if any of them cannot
 * be evaluated standing alone. It is the test that would have caught FIELDS
 * naming auDateToIso directly while extract.gs sorts before transforms.gs:
 * that threw at load, FIELDS was never defined, and every single execution
 * would have died before processing anything.
 *
 * The context mirrors test/load.js: Apps Script service globals (GmailApp,
 * Drive, PropertiesService, UrlFetchApp) are deliberately absent, so a file
 * touching one at LOAD time fails here — which is exactly the bug class.
 * Touching them inside a function body is fine and stays untested here.
 */
function loadAllAlphabetically() {
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

  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort();
  assert.ok(files.length > 0, 'no .gs files found in src/');

  for (const file of files) {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.doesNotThrow(
      () => vm.runInContext(code, context, { filename: file }),
      `${file} threw while loading in alphabetical order`,
    );
  }

  return { context, files };
}

test('every src/*.gs evaluates in alphabetical order', () => {
  const { files } = loadAllAlphabetically();
  // Guards the premise: extract.gs really does sort before transforms.gs,
  // so this test is exercising the hostile order and not a lucky one.
  assert.ok(files.indexOf('extract.gs') < files.indexOf('transforms.gs'),
    'expected extract.gs to sort before transforms.gs');
});

test('FIELDS is defined and its transforms survive the load order', () => {
  const { context } = loadAllAlphabetically();
  assert.ok(Array.isArray(context.FIELDS), 'FIELDS was never defined');
  assert.strictEqual(typeof context.FIELDS[3].transform, 'function');
});

test('no transform in FIELDS was lost to load order', () => {
  const { context } = loadAllAlphabetically();
  for (const field of context.FIELDS) {
    if ('transform' in field) {
      assert.strictEqual(typeof field.transform, 'function',
        'non-function transform on field: ' + field.key);
    }
  }
});

test('a lazily referenced transform still resolves when called', () => {
  const { context } = loadAllAlphabetically();
  // The whole point of the wrapper: the name is resolved now, not at build.
  assert.strictEqual(context.FIELDS[3].transform('5/4/1988'), '1988-04-05');
});

/**
 * The order-independent form of the same rule, and the stronger one.
 *
 * Alphabetical order only catches a load-time dereference that happens to
 * point backwards through the alphabet: main.gs reading LABELS from config.gs
 * at load time is the identical bug, but config.gs sorts first, so the test
 * above cannot see it. Loading each file into a context of its own removes
 * the alphabet from the question entirely — a file that needs a name from
 * another file merely to be evaluated fails here, whichever way they sort.
 *
 * Using a name from another file INSIDE a function body is normal and
 * correct; that is what one shared global scope is for, and it is untouched
 * by this test.
 */
test('every src/*.gs evaluates standing alone, whatever the file order', () => {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort();
  for (const file of files) {
    const context = {
      console, JSON, Math, Date, String, Number,
      Object, Array, RegExp, Error, isNaN,
    };
    vm.createContext(context);
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.doesNotThrow(
      () => vm.runInContext(code, context, { filename: file }),
      `${file} dereferences another file at load time`,
    );
  }
});
