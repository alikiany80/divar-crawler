const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

const JALALI_MONTHS = {
  'فروردین': 1, 'اردیبهشت': 2, 'خرداد': 3, 'تیر': 4, 'مرداد': 5, 'شهریور': 6,
  'مهر': 7, 'آبان': 8, 'آذر': 9, 'دی': 10, 'بهمن': 11, 'اسفند': 12
};

function toEnglishDigits(str) {
  if (str === null || str === undefined) return str;
  return String(str)
    .replace(/[۰-۹]/g, d => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)));
}

/** Parse the first integer in a Persian/English string ("۱۹,۰۰۰ تومان" -> 19000). Returns null if none. */
function parseInteger(str) {
  if (str === null || str === undefined) return null;
  const cleaned = toEnglishDigits(String(str)).replace(/[,٬،\u200f\u200e]/g, '');
  const match = cleaned.match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

/** Parse a decimal number ("3.0 متر" -> 3). */
function parseDecimal(str) {
  if (str === null || str === undefined) return null;
  const cleaned = toEnglishDigits(String(str)).replace(/[,٬\u200f\u200e]/g, '').replace('٫', '.');
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** Jalali (Shamsi) -> Gregorian. Algorithm from jalaali-js (MIT). */
function jalaliToGregorian(jy, jm, jd) {
  jy += 1595;
  let days = -355668 + (365 * jy) + (Math.floor(jy / 33) * 8) + Math.floor(((jy % 33) + 3) / 4) + jd
    + (jm < 7 ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthDays = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  while (gm <= 12 && gd > monthDays[gm]) {
    gd -= monthDays[gm];
    gm++;
  }
  return { gy, gm, gd };
}

/**
 * Parse a Persian date like "۲۵ تیر ۱۴۰۵، ۱۱:۵۶" (Tehran local time) into an ISO UTC string.
 * Iran has no DST since 2022, so UTC+03:30 is fixed.
 */
function parsePersianDateTime(str) {
  if (!str) return null;
  const normalized = toEnglishDigits(str);
  const match = normalized.match(/(\d{1,2})\s+([\u0600-\u06FF]+)\s+(\d{4})(?:[،,\s]+(\d{1,2}):(\d{2}))?/);
  if (!match) return null;
  const month = JALALI_MONTHS[match[2]];
  if (!month) return null;
  const { gy, gm, gd } = jalaliToGregorian(Number(match[3]), month, Number(match[1]));
  const hh = Number(match[4] || 0);
  const mm = Number(match[5] || 0);
  const utcMs = Date.UTC(gy, gm - 1, gd, hh, mm) - (3.5 * 60 * 60 * 1000);
  return new Date(utcMs).toISOString();
}

/** Current Jalali year (used to derive building age). */
function currentJalaliYear(now = new Date()) {
  // Jalali new year falls on Mar 20/21; approximate with Mar 21.
  const gy = now.getUTCFullYear();
  const beforeNowruz = now.getUTCMonth() < 2 || (now.getUTCMonth() === 2 && now.getUTCDate() < 21);
  return gy - (beforeNowruz ? 622 : 621);
}

module.exports = {
  toEnglishDigits,
  parseInteger,
  parseDecimal,
  jalaliToGregorian,
  parsePersianDateTime,
  currentJalaliYear
};
