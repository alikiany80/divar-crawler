const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURES = path.join(__dirname, 'fixtures');
const SCHEMA_PATH = path.join(__dirname, '..', 'contract', 'listing.v1.schema.json');

function fixture(relPath) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, relPath), 'utf8'));
}

function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

/** Fresh temp dir removed after the test. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'divar-crawler-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Collects written listings; mimics the sink interface. */
function memorySink() {
  return {
    name: 'memory',
    listings: [],
    flushed: 0,
    closed: false,
    async write(listing) { this.listings.push(listing); },
    async flush() { this.flushed++; },
    async close() { this.closed = true; }
  };
}

module.exports = { fixture, loadSchema, tempDir, memorySink, FIXTURES };
