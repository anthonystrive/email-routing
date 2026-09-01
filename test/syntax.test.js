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
