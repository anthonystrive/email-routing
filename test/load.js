const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

/**
 * Evaluates the given src/*.gs files into a single shared context, which is
 * how Apps Script actually runs them: one global scope, no module system.
 * Apps Script globals used at call time (UrlFetchApp, GmailApp, Drive) are
 * deliberately absent — pure modules must not touch them.
 *
 * `extras` adds context globals for the few modules that genuinely need one
 * Apps Script service to be testable at all — dedupe.gs and PropertiesService.
 * It defaults to none, so every existing caller keeps the bare context and the
 * "pure modules must not touch them" rule stays enforced for them.
 */
function loadAppsScript(files, extras) {
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
    ...(extras || {}),
  };
  vm.createContext(context);
  for (const file of files) {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return context;
}

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
