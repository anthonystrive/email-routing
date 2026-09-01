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
