#!/usr/bin/env node
const { main } = require('../src/cli');

main(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  err => {
    process.stderr.write(`divar-crawler: fatal: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  }
);
