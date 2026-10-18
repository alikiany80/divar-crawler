const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInteger, parseDecimal, parsePersianDateTime, jalaliToGregorian, currentJalaliYear } = require('../src/text');

test('parseInteger handles Persian digits, separators and RTL marks', () => {
  assert.equal(parseInteger('\u200f۱۹,۰۰۰,۰۰۰,۰۰۰ تومان'), 19_000_000_000);
  assert.equal(parseInteger('+۴'), 4);
  assert.equal(parseInteger('بدون اتاق'), null);
  assert.equal(parseInteger(null), null);
});

test('parseDecimal parses decimals', () => {
  assert.equal(parseDecimal('3.0 متر'), 3);
  assert.equal(parseDecimal('۲۸۵ متر مربع'), 285);
});

test('jalaliToGregorian converts known dates', () => {
  assert.deepEqual(jalaliToGregorian(1405, 7, 26), { gy: 2026, gm: 10, gd: 18 });
  assert.deepEqual(jalaliToGregorian(1403, 1, 1), { gy: 2024, gm: 3, gd: 20 });
});

test('parsePersianDateTime returns UTC ISO from Tehran local time', () => {
  assert.equal(parsePersianDateTime('۲۶ مهر ۱۴۰۵، ۱۲:۱۹'), '2026-10-18T08:49:00.000Z');
  assert.equal(parsePersianDateTime('نامعتبر'), null);
});

test('currentJalaliYear around Nowruz', () => {
  assert.equal(currentJalaliYear(new Date('2026-10-18T00:00:00Z')), 1405);
  assert.equal(currentJalaliYear(new Date('2026-03-01T00:00:00Z')), 1404);
});
