const { parseInteger, parseDecimal, currentJalaliYear, toEnglishDigits, parseRelativePersianDate } = require('../text');
const { normalizeKey, parseMoneyText, parsePublisherFromBottomText } = require('./parser');

const SOURCE = 'divar';
const WEB_BASE = 'https://divar.ir/v';

/** Divar category slug -> shared property type vocabulary (falls back to the slug itself). */
const PROPERTY_TYPES = {
  'apartment-sell': 'APARTMENT',
  'apartment-rent': 'APARTMENT',
  'house-villa-sell': 'VILLA',
  'house-villa-rent': 'VILLA',
  'plot-old': 'LAND',
  'pre-sell-home': 'PRESALE'
};

function listingTypeFor(category, webengage = {}) {
  const c = String(category || '');
  if (/-rent$/.test(c) || c === 'residential-rent') return 'RENT';
  if (/-sell$/.test(c) || c === 'residential-sell' || c === 'plot-old') return 'BUY';
  return Number(webengage.rent) > 0 || Number(webengage.credit) > 0 ? 'RENT' : 'BUY';
}

/** Attribute name (normalized) -> handler(value, out). Keys are compared after normalizeKey(). */
const ATTRIBUTE_HANDLERS = new Map(Object.entries({
  'متراژ': (v, o) => { o.areaM2 = parseDecimal(v); },
  'متراژ زمین': (v, o) => { o.landAreaM2 = parseDecimal(v); },
  'ساخت': (v, o) => { o.yearBuilt = parseInteger(v); },
  'سال ساخت': (v, o) => { o.yearBuilt = parseInteger(v); },
  'اتاق': (v, o) => { o.rooms = /بدون/.test(v) ? 0 : parseInteger(v); },
  'قیمت کل': (v, o) => { o.priceToman = parseMoneyText(v); o.isPriceNegotiable = /توافقی/.test(v) || null; },
  'قیمت کل ملک': (v, o) => { o.priceToman = parseMoneyText(v); },
  'قیمت هر متر': (v, o) => { o.pricePerMeter = parseMoneyText(v); },
  'ودیعه': (v, o) => { o.priceToman = parseMoneyText(v); },
  'اجاره ماهانه': (v, o) => { o.rentToman = parseMoneyText(v); },
  'اجاره': (v, o) => { o.rentToman = parseMoneyText(v); },
  'طبقه': (v, o) => Object.assign(o, parseFloorValue(v)),
  'تعداد کل طبقات': (v, o) => { o.totalFloors = parseInteger(v); },
  'تعداد کل طبقات ساختمان': (v, o) => { o.totalFloors = parseInteger(v); },
  'تعداد طبقات بنا': (v, o) => { o.totalFloors = parseInteger(v); },
  'تعداد واحد در طبقه': (v, o) => { o.unitsPerFloor = parseInteger(v); },
  'تعداد پارکینگ': (v, o) => { o.parkingCount = parseInteger(v); if (o.parkingCount !== null) o.hasParking = o.parkingCount > 0; },
  'آسانسور': (v, o) => { o.hasElevator = yesNo(v); },
  'پارکینگ': (v, o) => { o.hasParking = yesNo(v); },
  'انباری': (v, o) => { o.hasStorage = yesNo(v); },
  'بالکن': (v, o) => { o.hasBalcony = yesNo(v); },
  'سند': (v, o) => { o.deedType = v; },
  'وضعیت سند': (v, o) => { o.deedType ??= v; },
  'جهت ساختمان': (v, o) => { o.buildingDirection = v; },
  'وضعیت سکونت': (v, o) => { o.occupancyStatus = v; },
  'ودیعه و اجاره': (v, o) => { o.isRentConvertible = !/غیر/.test(v); },
  'تصویرها برای همین ملک است؟': (v, o) => { o.imagesAreReal = yesNo(v); }
}).map(([k, fn]) => [normalizeKey(k), fn]));

function yesNo(value) {
  const v = normalizeKey(value);
  if (/^(بله|دارد|هست|true)$/.test(v)) return true;
  if (/^(خیر|ندارد|نیست|false)$/.test(v)) return false;
  return null;
}

/** "۲ از ۵" -> {floor:2,totalFloors:5}; "همکف" -> 0; "زیرهمکف" -> -1. */
function parseFloorValue(value) {
  const v = normalizeKey(value);
  const out = {};
  if (/زیر ?همکف/.test(v)) out.floor = -1;
  else if (/همکف/.test(v)) out.floor = 0;
  else out.floor = parseInteger(v.split('از')[0]);
  const total = v.includes('از') ? parseInteger(v.split('از')[1]) : null;
  if (total !== null) out.totalFloors = total;
  return out;
}

/** Feature titles like "آسانسور" / "آسانسور ندارد" / "بالکن دارد". */
function applyFeature(title, out) {
  const t = normalizeKey(title);
  const negative = /ندارد$/.test(t);
  const value = !negative;
  if (t.startsWith('آسانسور')) out.hasElevator = value;
  else if (t.startsWith('پارکینگ')) out.hasParking = value;
  else if (t.startsWith('انباری')) out.hasStorage = value;
  else if (t.startsWith('بالکن')) out.hasBalcony = value;
  else if (t.includes('قابل تبدیل')) out.isRentConvertible = !/غیر/.test(t);
}

/** Map attributes + features onto normalized fields. Later rows win; features win over rows for amenities. */
function mapAttributes(attributes, features) {
  const out = {};
  for (const attr of attributes) {
    const handler = ATTRIBUTE_HANDLERS.get(normalizeKey(attr.name));
    if (handler && attr.value !== '') handler(attr.value, out);
  }
  for (const f of features) applyFeature(f.title, out);
  return out;
}

const nullIfUndefined = v => (v === undefined ? null : v);

/**
 * Keys never kept in stored payloads: contact blocks (even without phone numbers), owner/user ids
 * and tracking/session ids. Phone numbers are never requested (the contact endpoint is not called).
 */
const PRIVATE_KEYS = new Set([
  'contact', 'contact_uuid', 'hashed_post_owner_user_id', 'action_log', 'tracker_session_id',
  'ad_instance_id', 'trace_id', 'conversation_id'
]);

/**
 * Iranian phone numbers written by users in free text (mobile 09xx..., +98/0098 prefixes, landlines with area
 * code), in Persian, Arabic or Latin digits, optionally separated by spaces/dashes. Matching runs on a copy with
 * Latin digits (same string length, so indices line up with the original).
 */
const PHONE_PATTERN = /(?<![\d.])(?:(?:\+|00)98[\s-]?|0)9\d(?:[\s-]?\d){8}(?![\d.])|(?<![\d.])0[1-8]\d{1,2}[\s-]?\d{3,4}[\s-]?\d{4}(?![\d.])/g;
const PHONE_PLACEHOLDER = '[شماره حذف شد]';

function redactPhones(text) {
  if (typeof text !== 'string' || !text) return text;
  const latin = toEnglishDigits(text);
  let out = '';
  let last = 0;
  for (const m of latin.matchAll(PHONE_PATTERN)) {
    out += text.slice(last, m.index) + PHONE_PLACEHOLDER;
    last = m.index + m[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Deep copy of a raw Divar payload without PRIVATE_KEYS and the business (owner) section, with phone
 * numbers redacted from every string.
 */
function stripPrivateFields(value) {
  if (typeof value === 'string') return redactPhones(value);
  if (Array.isArray(value)) {
    return value
      .filter(v => !(v && v.section_name === 'BUSINESS_SECTION'))
      .map(stripPrivateFields);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!PRIVATE_KEYS.has(k)) out[k] = stripPrivateFields(v);
    }
    return out;
  }
  return value;
}

/** Normalize a POST_ROW from the search list (summary). `category` is the crawled category slug. */
function normalizeDivarSummary(row, category) {
  const payload = row.action?.payload || {};
  const token = payload.token || row.token;
  const listingType = listingTypeFor(category);
  const top = row.top_description_text || null;
  const middle = row.middle_description_text || null;

  let priceToman = null;
  let rentToman = null;
  if (listingType === 'RENT') {
    priceToman = top && /ودیعه/.test(top) ? parseMoneyText(top) : null;
    rentToman = middle ? parseMoneyText(middle) : null;
  } else {
    priceToman = middle ? parseMoneyText(middle) : null;
  }

  return {
    source: SOURCE,
    sourceId: token,
    url: `${WEB_BASE}/${token}`,
    title: redactPhones(row.title || payload.web_info?.title || null),
    listingType,
    cityName: payload.web_info?.city_persian || null,
    neighborhoodName: payload.web_info?.district_persian || null,
    locationLabel: [payload.web_info?.city_persian, payload.web_info?.district_persian].filter(Boolean).join(' - ') || null,
    priceToman,
    rentToman,
    publisherName: redactPhones(parsePublisherFromBottomText(row.bottom_description_text)),
    coverImageUrl: row.image_url || null,
    imageCount: Number.isInteger(row.image_count) ? row.image_count : null,
    publishedAt: row._sortDate || parseRelativePersianDate(row.bottom_description_text) || null,
    hasFullDetails: false,
    details: {
      list_row_json: stripPrivateFields(row)
    }
  };
}

/** Normalize a parsed detail (see parser.parsePostDetail) plus the raw payload. */
function normalizeDivarDetails(parsed, rawPost, summary = null) {
  const category = parsed.analytics.cat3 || parsed.webengage.category || null;
  const parentCategory = parsed.analytics.cat2 || parsed.webengage.cat_2 || null;
  const listingType = listingTypeFor(parentCategory || category, parsed.webengage);
  const mapped = mapAttributes(parsed.attributes, parsed.features);
  const webengage = parsed.webengage;

  // Fallbacks from rentSlider or analytics payload
  const slider = parsed.rentSlider;
  if (listingType === 'RENT') {
    const sliderCredit = slider?.credit?.value ? Number(slider.credit.value) : null;
    const sliderRent = slider?.rent?.value ? Number(slider.rent.value) : null;
    if (mapped.priceToman === undefined) {
      if (Number.isFinite(sliderCredit) && sliderCredit > 0) mapped.priceToman = sliderCredit;
      else if (Number.isFinite(Number(webengage.credit))) mapped.priceToman = Number(webengage.credit);
    }
    if (mapped.rentToman === undefined) {
      if (Number.isFinite(sliderRent) && sliderRent > 0) mapped.rentToman = sliderRent;
      else if (Number.isFinite(Number(webengage.rent))) mapped.rentToman = Number(webengage.rent);
    }
  }

  if (mapped.pricePerMeter === undefined && listingType === 'BUY' && mapped.priceToman > 0 && mapped.areaM2 > 0) {
    mapped.pricePerMeter = Math.round(mapped.priceToman / mapped.areaM2);
  }

  const yearBuilt = nullIfUndefined(mapped.yearBuilt);
  const token = parsed.token || summary?.sourceId;
  const businessType = webengage.business_type || null;

  return {
    source: SOURCE,
    sourceId: token,
    url: parsed.webUrl || `${WEB_BASE}/${token}`,
    title: redactPhones(parsed.title),
    description: redactPhones(parsed.description),
    listingType,
    propertyType: PROPERTY_TYPES[category] || category,
    cityName: parsed.location.city || parsed.city.name || summary?.cityName || null,
    regionName: null,
    neighborhoodName: parsed.location.district || parsed.seo.web_info?.district_persian || summary?.neighborhoodName || null,
    locationLabel: [parsed.location.city, parsed.location.district, parsed.location.addressHint].filter(Boolean).join(' - ') || null,
    latitude: parsed.map?.latitude ?? null,
    longitude: parsed.map?.longitude ?? null,
    locationIsExact: parsed.map ? parsed.map.exact : null,
    priceToman: (() => {
      let p = nullIfUndefined(mapped.priceToman);
      return (p && p > 100_000_000 && p % 1000 !== 0) ? Math.round(p / 1000) * 1000 : p;
    })(),
    rentToman: (() => {
      let r = nullIfUndefined(mapped.rentToman);
      return (r && r < 500_000) ? null : r;
    })(),
    pricePerMeter: nullIfUndefined(mapped.pricePerMeter),
    isPriceNegotiable: nullIfUndefined(mapped.isPriceNegotiable),
    areaM2: nullIfUndefined(mapped.areaM2),
    landAreaM2: nullIfUndefined(mapped.landAreaM2),
    rooms: (() => {
      let rm = nullIfUndefined(mapped.rooms);
      return (rm !== null && (rm < 0 || rm > 10)) ? null : rm;
    })(),
    yearBuilt,
    buildingAge: yearBuilt ? currentJalaliYear() - yearBuilt : null,
    floor: nullIfUndefined(mapped.floor),
    totalFloors: nullIfUndefined(mapped.totalFloors),
    unitsPerFloor: nullIfUndefined(mapped.unitsPerFloor),
    parkingCount: nullIfUndefined(mapped.parkingCount),
    hasParking: nullIfUndefined(mapped.hasParking),
    hasElevator: nullIfUndefined(mapped.hasElevator),
    hasStorage: nullIfUndefined(mapped.hasStorage),
    hasBalcony: nullIfUndefined(mapped.hasBalcony),
    publisherKind: businessType === 'personal' ? 'PERSONAL' : (businessType ? 'AGENCY' : null),
    publisherName: summary?.publisherName || null,
    coverImageUrl: (parsed.images[0]?.url ? parsed.images[0].url.replace('/webp_post/', '/webp_thumbnail/') : (summary?.coverImageUrl || null)),
    imageCount: parsed.images.length,
    publishedAt: parsed.timeline.publishedAt || summary?.publishedAt || null,
    sourceUpdatedAt: parsed.timeline.updatedAt || summary?.sourceUpdatedAt || null,
    hasFullDetails: true,
    images: parsed.images,
    attributes: parsed.attributes.map(a => ({ ...a, value: redactPhones(a.value) })),
    details: {
      category_slug: category,
      parent_category_slug: parentCategory,
      category_title: parsed.seo.web_info?.category_slug_persian || parsed.breadcrumbs.at(-1) || null,
      city_slug: webengage.city || parsed.analytics.city || null,
      district_slug: webengage.district || null,
      address_hint: parsed.location.addressHint,
      location_radius_m: parsed.map?.radius ?? null,
      business_type: businessType,
      business_ref: webengage.business_ref || null,
      images_are_real: nullIfUndefined(mapped.imagesAreReal),
      deed_type: nullIfUndefined(mapped.deedType),
      building_direction: nullIfUndefined(mapped.buildingDirection),
      occupancy_status: nullIfUndefined(mapped.occupancyStatus),
      is_rent_convertible: nullIfUndefined(mapped.isRentConvertible),
      convertible_deposit_toman: slider ? parseInteger(slider.credit?.transformed_value) : null,
      convertible_rent_toman: slider ? parseInteger(slider.rent?.transformed_value) : null,
      last_bumped_at: parsed.timeline.lastBumpedAt,
      unavailable_after: parsed.seo.unavailable_after || null,
      tags_json: parsed.tags,
      breadcrumbs_json: parsed.breadcrumbs,
      list_row_json: summary?.details?.list_row_json || null,
      raw_json: stripPrivateFields(rawPost)
    }
  };
}

module.exports = {
  normalizeDivarSummary,
  normalizeDivarDetails,
  mapAttributes,
  parseFloorValue,
  listingTypeFor,
  stripPrivateFields,
  redactPhones
};
