const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { fixture, tempDir, loadSchema } = require('./helpers');
const { validate } = require('./schema-validator');
const { loadConfig, parseArgs, ConfigError } = require('../src/config');
const { main } = require('../src/cli');
const { DivarAdapter } = require('../src/divar/adapter');
const { SqliteSink } = require('../src/sinks/sqlite');

test('loadConfig defaults', () => {
  const c = loadConfig([], {});
  assert.deepEqual(c.categories, ['buy', 'rent']);
  assert.equal(c.mode, 'recent');
  assert.equal(c.maxPages, 3);
  assert.equal(c.stopAfterExisting, 30);
  assert.equal(c.fetchDetails, true);
  assert.deepEqual(c.outputs, ['sqlite']);
  assert.ok(c.dbPath.endsWith(path.join('data', 'divar.sqlite')));
  assert.equal(c.jsonlPath, '-');
  assert.equal(c.divar.delayMs, 1500);
  assert.deepEqual(c.divar.cityIds, ['1']);
  assert.equal(c.http.rateLimitBackoffMs, 15000);
});

test('loadConfig reads flags and env', () => {
  const c = loadConfig(
    ['--category=rent', '--mode', 'full', '--pages=7', '--stop-after=5', '--no-details', '--output=sqlite,jsonl', '--db=/tmp/x.sqlite', '--jsonl=/tmp/x.jsonl'],
    { DIVAR_CITY_IDS: '1, 2', DIVAR_DELAY_MS: '2000', HTTP_MAX_RETRIES: '3' }
  );
  assert.deepEqual(c.categories, ['rent']);
  assert.equal(c.mode, 'full');
  assert.equal(c.maxPages, 7);
  assert.equal(c.stopAfterExisting, 5);
  assert.equal(c.fetchDetails, false);
  assert.deepEqual(c.outputs, ['sqlite', 'jsonl']);
  assert.equal(c.dbPath, '/tmp/x.sqlite');
  assert.equal(c.jsonlPath, '/tmp/x.jsonl');
  assert.deepEqual(c.divar.cityIds, ['1', '2']);
  assert.equal(c.divar.delayMs, 2000);
  assert.equal(c.http.maxRetries, 3);
  assert.equal(loadConfig([], { DIVAR_DB_PATH: '/tmp/env.sqlite' }).dbPath, '/tmp/env.sqlite');
});

test('loadConfig fails fast with clear messages', () => {
  const bad = [
    [['--category=land'], {}, /buy\|rent\|all/],
    [['--mode=fast'], {}, /recent\|full/],
    [['--pages=0'], {}, /--pages/],
    [['--output=csv'], {}, /--output=csv/],
    [['--output=http'], {}, /SINK_URL is required/],
    [['--output=http'], { SINK_URL: 'https://core.example/x' }, /SINK_TOKEN is required/],
    [[], { SINK_URL: 'ftp://x' }, /SINK_URL/],
    [[], { DIVAR_CITY_IDS: 'tehran' }, /not numeric/],
    [[], { DIVAR_DELAY_MS: '-1' }, /DIVAR_DELAY_MS/],
    [['--bogus'], {}, /Unknown flag/],
    [['--pages'], {}, /needs a value/],
    [['stray'], {}, /Unexpected argument/]
  ];
  for (const [argv, env, re] of bad) {
    assert.throws(() => loadConfig(argv, env), err => err instanceof ConfigError && re.test(err.message), `${argv} ${JSON.stringify(env)}`);
  }
  const http = loadConfig(['--output=http'], { SINK_URL: 'https://core.example/x', SINK_TOKEN: 't' });
  assert.equal(http.sink.batchSize, 25);
  assert.deepEqual(parseArgs(['--help']), { help: true });
});

function captureStream() {
  const chunks = [];
  const stream = new Writable({ write(c, e, cb) { chunks.push(c.toString()); cb(); } });
  stream.text = () => chunks.join('');
  return stream;
}

test('main --help prints usage; bad config exits 2', async () => {
  const stdout = captureStream();
  assert.equal(await main(['--help'], {}, { stdout }), 0);
  assert.match(stdout.text(), /--category=buy\|rent\|all/);
  const origWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await main(['--mode=nope'], {}, {}), 2);
  } finally {
    process.stderr.write = origWrite;
  }
});

test('main end-to-end with a fake Divar client writes sqlite + jsonl that validate against the contract', async t => {
  const dir = tempDir(t);
  const db = path.join(dir, 'divar.sqlite');
  const jsonl = path.join(dir, 'out.jsonl');
  const search = fixture('divar/search-residential-sell.json');
  search.pagination.has_next_page = false;
  const client = {
    postJson: async () => search,
    getJson: async url => {
      if (url.endsWith('gaTEST103')) {
        const { HttpError } = require('../src/http-client');
        throw new HttpError(404, url);
      }
      return fixture('divar/post-apartment-sell.json');
    },
    stats: { requests: 0, retries: 0, rateLimited: 0 }
  };
  // Only one detail fixture exists, so map every token to it except the failing one.
  const adapter = new DivarAdapter({ client });
  const origDetails = adapter.fetchDetails.bind(adapter);
  adapter.fetchDetails = async summary => ({ ...(await origDetails(summary)), sourceId: summary.sourceId, url: summary.url });

  const code = await main(['--category=buy', '--pages=1', '--output=sqlite,jsonl', `--db=${db}`, `--jsonl=${jsonl}`], { LOG_LEVEL: 'silent' }, { adapter });
  assert.equal(code, 0);

  const schema = loadSchema();
  const lines = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const l of lines) assert.deepEqual(validate(schema, l), []);
  assert.deepEqual(lines.map(l => l.hasFullDetails), [true, true, false]);

  const sink = new SqliteSink(db);
  assert.deepEqual(sink.stats(), { total: 3, withFullDetails: 2 });
  const seen = sink.db.prepare('SELECT COUNT(*) AS n FROM seen').get().n;
  assert.equal(seen, 3, 'state lives in the same file');
  sink.close();
});
