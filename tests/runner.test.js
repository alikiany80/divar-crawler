const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { memorySink, tempDir } = require('./helpers');
const { CrawlRunner } = require('../src/runner');
const { StateStore } = require('../src/state');
const { HttpError, HttpClient } = require('../src/http-client');

function fakeAdapter(pages, { failDetailsFor = [] } = {}) {
  const detailCalls = [];
  return {
    name: 'divar',
    categories: ['buy'],
    detailCalls,
    async fetchPage(category, cursor) {
      const index = cursor ?? 0;
      const ids = pages[index] || [];
      return {
        items: ids.map(id => ({
          source: 'divar', sourceId: id, url: `https://divar.ir/v/${id}`, listingType: 'BUY', title: `t${id}`, hasFullDetails: false
        })),
        nextCursor: index + 1 < pages.length ? index + 1 : null,
        page: index + 1
      };
    },
    async fetchDetails(summary) {
      detailCalls.push(summary.sourceId);
      if (failDetailsFor.includes(summary.sourceId)) throw new HttpError(404, 'x');
      return { ...summary, description: 'full', hasFullDetails: true, images: [], attributes: [], details: { category_slug: 'apartment-sell' } };
    }
  };
}

const memoryState = () => new StateStore(':memory:');

test('recent crawl emits contract listings, dedupes tokens and isolates detail failures', async () => {
  const state = memoryState();
  const sink = memorySink();
  const adapter = fakeAdapter([['a', 'b'], ['c', 'a']], { failDetailsFor: ['c'] });
  const res = await new CrawlRunner(adapter, state, [sink]).crawl({ category: 'buy', maxPages: 5 });

  assert.deepEqual(res, {
    pagesCrawled: 2, listingsCrawled: 3, newListings: 3, updatedListings: 0, detailsFailed: 1, stopReason: 'last_page'
  });
  assert.deepEqual(sink.listings.map(l => [l.sourceId, l.hasFullDetails]), [['a', true], ['b', true], ['c', false]]);
  assert.ok(sink.listings.every(l => l.schemaVersion === 1 && l.crawledAt));
  assert.ok(sink.flushed >= 1);
  assert.equal(state.needsDetails('a'), false);
  assert.equal(state.needsDetails('c'), true, 'failed detail is retried next run');
  state.close();
});

test('second crawl stops when caught up and skips detail fetch for complete listings', async () => {
  const state = memoryState();
  const pages = [['a', 'b'], ['c', 'd'], ['e']];
  await new CrawlRunner(fakeAdapter(pages), state, [memorySink()]).crawl({ category: 'buy', maxPages: 5 });

  const adapter = fakeAdapter(pages);
  const sink = memorySink();
  const res = await new CrawlRunner(adapter, state, [sink]).crawl({ category: 'buy', maxPages: 5, stopAfterExisting: 2 });
  assert.equal(res.stopReason, 'caught_up');
  assert.equal(res.pagesCrawled, 1);
  assert.equal(res.updatedListings, 2);
  assert.deepEqual(adapter.detailCalls, []);
  assert.equal(sink.listings.length, 2, 'known listings still re-emitted as summaries (last seen)');
  state.close();
});

test('full mode ignores known listings; --no-details emits summaries only', async () => {
  const state = memoryState();
  const pages = [['a'], ['b']];
  await new CrawlRunner(fakeAdapter(pages), state, [memorySink()]).crawl({ category: 'buy' });
  const adapter = fakeAdapter(pages);
  const res = await new CrawlRunner(adapter, state, [memorySink()], { fetchDetails: false })
    .crawl({ category: 'buy', mode: 'full', stopAfterExisting: 1 });
  assert.equal(res.pagesCrawled, 2);
  assert.equal(res.stopReason, 'last_page');
  assert.deepEqual(adapter.detailCalls, []);
  state.close();
});

test('multiple sinks receive every listing', async () => {
  const state = memoryState();
  const s1 = memorySink();
  const s2 = memorySink();
  await new CrawlRunner(fakeAdapter([['a', 'b']]), state, [s1, s2]).crawl({ category: 'buy' });
  assert.equal(s1.listings.length, 2);
  assert.deepEqual(s1.listings, s2.listings);
  state.close();
});

test('failed page rethrows; unknown category and mode are rejected', async () => {
  const state = memoryState();
  const adapter = { ...fakeAdapter([]), fetchPage: async () => { throw new Error('boom'); } };
  await assert.rejects(new CrawlRunner(adapter, state, [memorySink()]).crawl({ category: 'buy' }), /boom/);
  await assert.rejects(new CrawlRunner(fakeAdapter([]), state, [memorySink()]).crawl({ category: 'land' }), /no category/);
  await assert.rejects(new CrawlRunner(fakeAdapter([]), state, [memorySink()]).crawl({ category: 'buy', mode: 'x' }), /Unknown mode/);
  assert.throws(() => new CrawlRunner(fakeAdapter([]), state, []), /at least one sink/);
  state.close();
});

test('StateStore persists across reopen and only upgrades has_full_details', t => {
  const dbPath = path.join(tempDir(t), 'state.sqlite');
  let state = new StateStore(dbPath);
  state.markSeen([{ sourceId: 'a', hasFullDetails: true, contentHash: 'h1' }, { sourceId: 'b', hasFullDetails: false }]);
  state.markSeen([{ sourceId: 'a', hasFullDetails: false }]);
  state.close();

  state = new StateStore(dbPath);
  assert.equal(state.count(), 2);
  assert.equal(state.get('a').has_full_details, true);
  assert.equal(state.get('a').content_hash, 'h1');
  assert.equal(state.needsDetails('b'), true);
  assert.equal(state.isKnown('zzz'), false);
  const mode = state.db.prepare('PRAGMA journal_mode').get().journal_mode;
  assert.equal(mode, 'wal');
  state.close();
});

test('HttpClient retries 429 with backoff then succeeds', async () => {
  const statuses = [429, 429, 200];
  const sleeps = [];
  const client = new HttpClient({
    delayMs: 0,
    maxRetries: 4,
    rateLimitBackoffMs: 5000,
    sleep: async ms => { sleeps.push(ms); },
    fetch: async () => {
      const status = statuses.shift();
      return new Response(status === 200 ? '{"ok":true}' : 'rate limited', { status });
    }
  });
  assert.deepEqual(await client.getJson('https://example.test/x'), { ok: true });
  assert.deepEqual(sleeps, [5000, 10000]);
  assert.deepEqual(client.stats, { requests: 3, retries: 2, rateLimited: 2 });
});

test('HttpClient does not retry 404', async () => {
  let calls = 0;
  const client = new HttpClient({
    delayMs: 0,
    sleep: async () => {},
    fetch: async () => { calls++; return new Response('nope', { status: 404 }); }
  });
  await assert.rejects(client.getJson('https://example.test/x'), err => err instanceof HttpError && err.status === 404);
  assert.equal(calls, 1);
});

test('HttpClient throttles consecutive requests by delayMs', async () => {
  const sleeps = [];
  const client = new HttpClient({
    delayMs: 1500,
    sleep: async ms => { sleeps.push(ms); },
    fetch: async () => new Response('{}', { status: 200 })
  });
  await client.getJson('https://example.test/a');
  await client.getJson('https://example.test/b');
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 1000 && sleeps[0] <= 1500);
});
