const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { fixture, tempDir } = require('./helpers');
const { parseSearchResponse, parsePostDetail } = require('../src/divar/parser');
const { normalizeDivarSummary, normalizeDivarDetails } = require('../src/divar/normalize');
const { toContractListing } = require('../src/listing');
const { SqliteSink } = require('../src/sinks/sqlite');
const { JsonlSink } = require('../src/sinks/jsonl');
const { HttpSink } = require('../src/sinks/http');
const { createSinks } = require('../src/sinks');

const CRAWLED_AT = '2026-10-18T09:00:00.000Z';

function fullListing() {
  const raw = fixture('divar/post-apartment-sell.json');
  return toContractListing(normalizeDivarDetails(parsePostDetail(raw), raw), { crawledAt: CRAWLED_AT });
}

function summaryFor(listing) {
  return { ...listing, hasFullDetails: false, description: null, areaM2: null, rooms: null, images: null, attributes: null, details: { list_row_json: { token: listing.sourceId } }, title: 'عنوان جدید' };
}

test('SqliteSink: summary after full keeps known values (COALESCE), updates non-null fields', t => {
  const sink = new SqliteSink(path.join(tempDir(t), 'divar.sqlite'));
  const full = fullListing();
  sink.upsert(full);
  sink.upsert(summaryFor(full));

  const row = sink.getListing(full.sourceId);
  assert.equal(row.title, 'عنوان جدید');
  assert.equal(row.description, full.description);
  assert.equal(row.area_m2, 108);
  assert.equal(row.rooms, 2);
  assert.equal(row.price_toman, 36_800_000_000);
  assert.equal(row.has_full_details, 1);
  assert.equal(row.has_elevator, 1);
  assert.equal(row.images.length, 7, 'images kept when summary has images=null');
  assert.ok(row.attributes.length > 20);
  assert.equal(JSON.parse(row.details_json).category_slug, 'apartment-sell', 'summary details do not replace full details');
  assert.equal(JSON.parse(row.raw_json).webengage.token, 'gaTEST001');
  assert.ok(row.details_fetched_at);
  assert.deepEqual(sink.stats(), { total: 1, withFullDetails: 1 });
  sink.close();
});

test('SqliteSink: images/attributes replaced when an array is given', t => {
  const sink = new SqliteSink(path.join(tempDir(t), 'divar.sqlite'));
  const full = fullListing();
  sink.upsert(full);
  sink.upsert({ ...full, images: [], attributes: [{ group: 'g', name: 'n', value: 'v' }] });
  const row = sink.getListing(full.sourceId);
  assert.equal(row.images.length, 0);
  assert.deepEqual(row.attributes.map(a => ({ ...a })), [{ group_name: 'g', name: 'n', value: 'v' }]);
  sink.close();
});

test('SqliteSink: summary-only listing is stored with list row details', async t => {
  const dir = tempDir(t);
  const { rows } = parseSearchResponse(fixture('divar/search-residential-sell.json'));
  const listing = toContractListing(normalizeDivarSummary(rows[0], 'residential-sell'), { crawledAt: CRAWLED_AT });
  const sink = new SqliteSink(path.join(dir, 'nested', 'divar.sqlite'));
  await sink.write(listing);
  const row = sink.getListing('gaTEST101');
  assert.equal(row.has_full_details, 0);
  assert.equal(row.price_toman, 27_500_000_000);
  assert.equal(JSON.parse(row.details_json).list_row_json.token, 'gaTEST101');
  assert.equal(row.raw_json, null);
  assert.equal(JSON.stringify(JSON.parse(row.details_json)).includes('tracker_session_id'), false);
  await sink.close();
});

test('JsonlSink appends one JSON object per line to a file', async t => {
  const file = path.join(tempDir(t), 'out', 'listings.jsonl');
  const sink = new JsonlSink(file);
  await sink.write({ a: 1 });
  await sink.write({ b: 'ب' });
  await sink.close();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines, [{ a: 1 }, { b: 'ب' }]);
  assert.equal(sink.written, 2);
});

test('JsonlSink writes to stdout when target is "-" and does not close it', async () => {
  const chunks = [];
  const stdout = new Writable({ write(chunk, enc, cb) { chunks.push(chunk.toString()); cb(); } });
  const sink = new JsonlSink('-', { stdout });
  await sink.write({ x: 1 });
  await sink.close();
  assert.equal(chunks.join(''), '{"x":1}\n');
  assert.equal(stdout.writableEnded, false);
});

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

const ok = n => new Response(JSON.stringify({ received: n, created: n, updated: 0, rejected: [] }), { status: 200 });

test('HttpSink batches with bearer auth and flushes the remainder on close', async () => {
  const fetch = fakeFetch([ok(2), ok(1)]);
  const sink = new HttpSink({ url: 'https://core.example/api/ingest/listings/', token: 'test-token', batchSize: 2, fetch, sleep: async () => {} });
  for (const id of ['a', 'b', 'c']) await sink.write({ sourceId: id });
  assert.equal(fetch.calls.length, 1);
  await sink.close();
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.deepEqual(fetch.calls[0].body, { schemaVersion: 1, listings: [{ sourceId: 'a' }, { sourceId: 'b' }] });
  assert.deepEqual(fetch.calls[1].body.listings, [{ sourceId: 'c' }]);
  assert.equal(sink.written, 3);
  assert.deepEqual(sink.totals, { batches: 2, received: 3, created: 3, updated: 0, rejected: 0 });
});

test('HttpSink retries 429/5xx/network errors with backoff', async () => {
  const sleeps = [];
  const fetch = fakeFetch([new Response('', { status: 503 }), new TypeError('socket hang up'), new Response('', { status: 429 }), ok(1)]);
  const sink = new HttpSink({ url: 'https://core.example/x', token: 't', fetch, backoffMs: 100, maxRetries: 4, sleep: async ms => { sleeps.push(ms); } });
  await sink.write({ sourceId: 'a' });
  await sink.flush();
  assert.equal(fetch.calls.length, 4);
  assert.deepEqual(sleeps, [100, 200, 400]);
});

test('HttpSink does not retry 4xx and keeps the batch buffered', async () => {
  const fetch = fakeFetch([new Response('{"error":"bad token"}', { status: 401 })]);
  const sink = new HttpSink({ url: 'https://core.example/x', token: 't', fetch, sleep: async () => {} });
  await sink.write({ sourceId: 'a' });
  await assert.rejects(sink.flush(), err => err.status === 401);
  assert.equal(fetch.calls.length, 1);
  assert.equal(sink.buffer.length, 1);
});

test('HttpSink validates options; createSinks builds several sinks', t => {
  assert.throws(() => new HttpSink({ token: 't' }), /SINK_URL/);
  assert.throws(() => new HttpSink({ url: 'https://x', token: 't', batchSize: 101 }), /batchSize/);
  const dir = tempDir(t);
  const sinks = createSinks({
    outputs: ['sqlite', 'jsonl'], dbPath: path.join(dir, 'd.sqlite'), jsonlPath: path.join(dir, 'o.jsonl'),
    sink: {}, http: {}
  });
  assert.deepEqual(sinks.map(s => s.name), ['sqlite', 'jsonl']);
  return Promise.all(sinks.map(s => s.close()));
});
