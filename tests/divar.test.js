const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const {
  parseSearchResponse, parsePostDetail, parseMoneyText, parsePublisherFromBottomText, parseLocationLine, normalizeKey
} = require('../src/divar/parser');
const {
  normalizeDivarSummary, normalizeDivarDetails, parseFloorValue, listingTypeFor, stripPrivateFields, redactPhones
} = require('../src/divar/normalize');
const { DivarAdapter } = require('../src/divar/adapter');

test('parseMoneyText handles labels, free and full-mortgage', () => {
  assert.equal(parseMoneyText('ودیعه: ۷۰۰,۰۰۰,۰۰۰ تومان'), 700_000_000);
  assert.equal(parseMoneyText('رهن کامل'), 0);
  assert.equal(parseMoneyText('رایگان'), 0);
  assert.equal(parseMoneyText('توافقی'), null);
});

test('parsePublisherFromBottomText distinguishes agencies from relative times', () => {
  assert.equal(parsePublisherFromBottomText('آژانس نمونه در شهرک غرب'), 'آژانس نمونه');
  assert.equal(parsePublisherFromBottomText('لحظاتی پیش در صادقیه'), null);
  assert.equal(parsePublisherFromBottomText('در نصرت'), null);
  assert.equal(parsePublisherFromBottomText('آژانس آژانس املاک نمونه در ولنجک'), 'آژانس املاک نمونه', 'doubled prefix collapsed');
});

test('parseLocationLine keeps ZWNJ in names', () => {
  const loc = parseLocationLine('هفته پیش در تهران، جنت\u200cآباد شمالی، خیابان نمونه');
  assert.deepEqual(loc, { city: 'تهران', district: 'جنت\u200cآباد شمالی', addressHint: 'خیابان نمونه' });
});

test('normalizeKey strips ZWNJ only for matching', () => {
  assert.equal(normalizeKey('تصویر\u200cها برای همین ملک است؟'), 'تصویرها برای همین ملک است؟');
  assert.equal(normalizeKey('علي كريمي'), 'علی کریمی');
});

test('parseFloorValue', () => {
  assert.deepEqual(parseFloorValue('۲ از ۵'), { floor: 2, totalFloors: 5 });
  assert.deepEqual(parseFloorValue('همکف'), { floor: 0 });
  assert.deepEqual(parseFloorValue('زیرهمکف'), { floor: -1 });
});

test('listingTypeFor maps category slugs', () => {
  assert.equal(listingTypeFor('residential-rent'), 'RENT');
  assert.equal(listingTypeFor('apartment-sell'), 'BUY');
  assert.equal(listingTypeFor('plot-old'), 'BUY');
});

test('search response yields rows and pagination cursor', () => {
  const parsed = parseSearchResponse(fixture('divar/search-residential-sell.json'));
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.hasNextPage, true);
  assert.ok(parsed.paginationData.last_post_date);

  const summary = normalizeDivarSummary(parsed.rows[0], 'residential-sell');
  assert.equal(summary.source, 'divar');
  assert.equal(summary.sourceId, 'gaTEST101');
  assert.equal(summary.listingType, 'BUY');
  assert.equal(summary.priceToman, 27_500_000_000);
  assert.equal(summary.neighborhoodName, 'زنجان جنوبی');
  assert.equal(summary.publisherName, 'آژانس نمونه');
  assert.equal(summary.url, 'https://divar.ir/v/gaTEST101');
  assert.equal(summary.imageCount, 10);
  assert.equal(summary.hasFullDetails, false);

  assert.equal(normalizeDivarSummary(parsed.rows[1], 'residential-sell').publisherName, 'آژانس املاک نمونه');
  assert.equal(normalizeDivarSummary(parsed.rows[2], 'residential-sell').publisherName, null);
});

test('apartment sell detail is fully normalized', () => {
  const raw = fixture('divar/post-apartment-sell.json');
  const n = normalizeDivarDetails(parsePostDetail(raw), raw);
  assert.equal(n.sourceId, 'gaTEST001');
  assert.equal(n.title, 'آپارتمان نمونه ۱۰۸ متری');
  assert.equal(n.listingType, 'BUY');
  assert.equal(n.propertyType, 'APARTMENT');
  assert.equal(n.priceToman, 36_800_000_000, 'price from the "قیمت کل" row, not webengage.price');
  assert.equal(n.pricePerMeter, 340_740_000);
  assert.equal(n.areaM2, 108);
  assert.equal(n.rooms, 2);
  assert.equal(n.yearBuilt, 1396);
  assert.equal(n.floor, 4);
  assert.equal(n.totalFloors, 5);
  assert.equal(n.unitsPerFloor, 2);
  assert.equal(n.parkingCount, 1);
  assert.equal(n.hasElevator, true);
  assert.equal(n.hasStorage, true);
  assert.equal(n.hasBalcony, true);
  assert.equal(n.cityName, 'تهران');
  assert.equal(n.neighborhoodName, 'جنت\u200cآباد شمالی');
  assert.equal(n.locationIsExact, false);
  assert.ok(n.latitude > 35 && n.longitude > 51);
  assert.equal(n.publishedAt, '2026-10-18T08:49:00.000Z');
  assert.equal(n.sourceUpdatedAt, '2026-10-18T08:50:00.000Z');
  assert.equal(n.publisherKind, 'AGENCY');
  assert.equal(n.images.length, 7);
  assert.equal(n.coverImageUrl, 'https://example.com/img/1.jpg');
  assert.ok(n.description.startsWith('توضیحات نمونه برای تست.'));
  assert.ok(n.attributes.length > 20);
  assert.equal(n.details.category_slug, 'apartment-sell');
  assert.equal(n.details.deed_type, 'تک\u200cبرگ', 'ZWNJ kept in display values');
  assert.equal(n.details.location_radius_m, 500);
  assert.equal(n.details.raw_json.webengage.token, 'gaTEST001');
});

test('apartment rent detail extracts deposit, rent and convertibility', () => {
  const raw = fixture('divar/post-apartment-rent.json');
  const n = normalizeDivarDetails(parsePostDetail(raw), raw);
  assert.equal(n.sourceId, 'gaTEST002');
  assert.equal(n.listingType, 'RENT');
  assert.equal(n.priceToman, 1_000_000_000);
  assert.equal(n.rentToman, 45_000_000);
  assert.equal(n.pricePerMeter, null);
  assert.equal(n.locationIsExact, true);
  assert.equal(n.details.is_rent_convertible, true);
  assert.equal(n.details.convertible_deposit_toman, 1_050_000_000);
  assert.equal(n.details.convertible_rent_toman, 43_500_000);
  assert.equal(n.publisherKind, 'PERSONAL');
  assert.ok(n.attributes.some(a => a.name === 'مناسب برای' && a.value === 'خانواده'));
});

test('villa detail keeps land area and villa-specific rows as attributes', () => {
  const raw = fixture('divar/post-villa-sell.json');
  const n = normalizeDivarDetails(parsePostDetail(raw), raw);
  assert.equal(n.sourceId, 'gaTEST003');
  assert.equal(n.propertyType, 'VILLA');
  assert.equal(n.areaM2, 140);
  assert.equal(n.landAreaM2, 285);
  assert.equal(n.totalFloors, 1);
  assert.equal(n.priceToman, 90_000_000_000, 'not the float-artifact webengage.price 89999998976');
  assert.equal(n.images.length, 16);
  assert.equal(n.publishedAt, '2026-10-11T12:30:00.000Z');
  assert.ok(n.attributes.some(a => a.name === 'نوع بنا' && a.value === 'ویلایی مستقل'));
});

test('parsePostDetail rejects non-post payloads', () => {
  assert.throws(() => parsePostDetail({ error: 'x' }), /missing sections/);
});

test('stripPrivateFields drops contact blocks, owner ids and tracking ids from stored payloads', () => {
  const raw = {
    contact: { contact_uuid: 'x' },
    sections: [
      { section_name: 'TITLE', widgets: [{ action_log: { a: 1 }, data: { title: 't' } }] },
      { section_name: 'BUSINESS_SECTION', widgets: [{ data: { request_data: { hashed_post_owner_user_id: 'h' } } }] }
    ],
    row: { tracker_session_id: 's', ad_instance_id: 'i', token: 'gaTEST001' }
  };
  assert.deepEqual(stripPrivateFields(raw), {
    sections: [{ section_name: 'TITLE', widgets: [{ data: { title: 't' } }] }],
    row: { token: 'gaTEST001' }
  });

  const withContact = { ...fixture('divar/post-apartment-sell.json'), contact: { contact_uuid: 'secret' } };
  const n = normalizeDivarDetails(parsePostDetail(withContact), withContact);
  assert.equal(JSON.stringify(n).includes('contact_uuid'), false);
});

test('DivarAdapter sends pagination cursor and reuses server_payload when page 2 lacks it', async () => {
  const calls = [];
  const page1 = fixture('divar/search-residential-sell.json');
  const { search_data: _omit, ...page2 } = page1;
  const responses = [page1, page2, page2];
  const client = {
    postJson: async (url, body) => { calls.push({ url, body }); return responses.shift(); },
    getJson: async url => { calls.push({ url }); return fixture('divar/post-apartment-sell.json'); }
  };
  const adapter = new DivarAdapter({ client, cityIds: ['1'] });
  const first = await adapter.fetchPage('buy', null);
  assert.equal(first.items.length, 3);
  assert.ok(first.nextCursor);
  const second = await adapter.fetchPage('buy', first.nextCursor);
  await adapter.fetchPage('buy', second.nextCursor);

  assert.equal(calls[0].url, 'https://api.divar.ir/v8/postlist/w/search');
  assert.equal(calls[0].body.pagination_data, undefined);
  assert.deepEqual(calls[0].body.city_ids, ['1']);
  assert.equal(calls[0].body.search_data.form_data.data.category.str.value, 'residential-sell');
  assert.deepEqual(calls[1].body.pagination_data, page1.pagination.data);
  assert.deepEqual(calls[1].body.search_data.server_payload, page1.search_data.server_payload);
  assert.deepEqual(calls[2].body.search_data.server_payload, page1.search_data.server_payload, 'reused from page 1');

  const details = await adapter.fetchDetails(first.items[0]);
  assert.equal(calls.at(-1).url, 'https://api.divar.ir/v8/posts-v2/web/gaTEST101');
  assert.equal(details.hasFullDetails, true);
  assert.equal(details.publisherName, 'آژانس نمونه', 'publisher carried over from summary');
  await assert.rejects(adapter.fetchPage('commercial', null), /Unknown divar category/);
});

test('DivarAdapter maps rent category to residential-rent', async () => {
  let body = null;
  const client = { postJson: async (url, b) => { body = b; return { list_widgets: [] }; } };
  const res = await new DivarAdapter({ client, cityIds: ['1', '2'] }).fetchPage('rent', null);
  assert.equal(body.search_data.form_data.data.category.str.value, 'residential-rent');
  assert.deepEqual(body.city_ids, ['1', '2']);
  assert.deepEqual(res.items, []);
  assert.equal(res.nextCursor, null);
});

test('redactPhones removes phone numbers from free text but keeps prices, areas and coordinates', () => {
  const R = '[شماره حذف شد]';
  assert.equal(redactPhones('تماس: ۰۹۱۲۰۰۰۰۰۰۰ فقط پیامک'), `تماس: ${R} فقط پیامک`);
  assert.equal(redactPhones('0912 000 0000'), R);
  assert.equal(redactPhones('+98 912 000 0000'), R);
  assert.equal(redactPhones('تلفن ۰۲۱-۴۴۰۰۰۰۰۰'), `تلفن ${R}`);
  assert.equal(redactPhones('۳۶,۸۰۰,۰۰۰,۰۰۰ تومان'), '۳۶,۸۰۰,۰۰۰,۰۰۰ تومان');
  assert.equal(redactPhones('۱۰۸ متر، ساخت ۱۳۹۶'), '۱۰۸ متر، ساخت ۱۳۹۶');
  assert.deepEqual(stripPrivateFields({ longitude: 51.435091234567, s: '35.70912345678901' }), { longitude: 51.435091234567, s: '35.70912345678901' });
  assert.equal(redactPhones(null), null);

  const raw = fixture('divar/post-apartment-rent.json');
  const desc = raw.sections.find(s => s.section_name === 'DESCRIPTION').widgets.find(w => w.widget_type === 'DESCRIPTION_ROW');
  desc.data.text += '\nتماس ۰۹۱۲۰۰۰۰۰۰۰';
  const n = normalizeDivarDetails(parsePostDetail(raw), raw);
  assert.ok(n.description.endsWith(`تماس ${R}`));
  assert.equal(/۰۹۱۲۰۰۰۰۰۰۰/.test(JSON.stringify(n)), false, 'also redacted inside raw_json');
});
