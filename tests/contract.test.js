const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSchema } = require('./helpers');
const { validate } = require('./schema-validator');
const { parseSearchResponse, parsePostDetail } = require('../src/divar/parser');
const { normalizeDivarSummary, normalizeDivarDetails } = require('../src/divar/normalize');
const { toContractListing } = require('../src/listing');

const schema = loadSchema();
const CRAWLED_AT = '2026-10-18T09:00:00.000Z';

function assertValid(listing, label) {
  const errors = validate(schema, listing);
  assert.deepEqual(errors, [], `${label} violates contract:\n${errors.join('\n')}`);
}

test('every search summary fixture maps to a valid contract listing', () => {
  const { rows } = parseSearchResponse(fixture('divar/search-residential-sell.json'));
  for (const row of rows) {
    const listing = toContractListing(normalizeDivarSummary(row, 'residential-sell'), { crawledAt: CRAWLED_AT });
    assertValid(listing, listing.sourceId);
    assert.equal(listing.hasFullDetails, false);
    assert.equal(listing.images, null, 'summary images unknown -> null');
    assert.equal(listing.attributes, null, 'summary attributes unknown -> null');
  }
});

for (const file of ['post-apartment-sell.json', 'post-apartment-rent.json', 'post-villa-sell.json']) {
  test(`detail fixture ${file} maps to a valid contract listing`, () => {
    const raw = fixture(`divar/${file}`);
    const listing = toContractListing(normalizeDivarDetails(parsePostDetail(raw), raw), { crawledAt: CRAWLED_AT });
    assertValid(listing, file);
    assert.equal(listing.schemaVersion, 1);
    assert.equal(listing.crawledAt, CRAWLED_AT);
    assert.ok(Array.isArray(listing.images) && listing.images.length > 0);
    assert.ok(Array.isArray(listing.attributes) && listing.attributes.length > 0);
    assert.equal(typeof listing.details.raw_json, 'object');
  });
}

test('toContractListing keeps only schema keys and nulls unknown values', () => {
  const listing = toContractListing({
    source: 'divar', sourceId: 'gaTEST900', url: 'https://divar.ir/v/gaTEST900', listingType: 'RENT',
    hasFullDetails: false, rooms: 2.4, priceToman: Number.NaN, somethingElse: 'dropped'
  }, { crawledAt: CRAWLED_AT });
  assertValid(listing, 'synthetic');
  assert.equal(listing.somethingElse, undefined);
  assert.equal(listing.rooms, 2);
  assert.equal(listing.priceToman, null);
  assert.equal(listing.title, null);
  assert.equal(listing.details, null);
  assert.throws(() => toContractListing({ source: 'divar', sourceId: 'x', listingType: 'SELL' }), /invalid listingType/);
});

test('schema validator catches violations', () => {
  const bad = { schemaVersion: 2, source: 'Divar!', sourceId: '', url: 'not a url', listingType: 'SELL', hasFullDetails: 'no', crawledAt: 'yesterday', rooms: 1.5, latitude: 200, extra: 1, images: [{}] };
  const errors = validate(schema, bad);
  for (const fragment of ['const', 'does not match', 'shorter', 'invalid uri', 'enum', 'type boolean', 'invalid date-time', 'type integer', 'maximum', "unexpected property 'extra'", "missing required 'url'"]) {
    assert.ok(errors.some(e => e.includes(fragment)), `expected an error containing '${fragment}', got:\n${errors.join('\n')}`);
  }
});
