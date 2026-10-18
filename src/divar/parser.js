/**
 * Divar API payload parsing (pure functions, no I/O).
 *
 * Search:  POST https://api.divar.ir/v8/postlist/w/search  -> list_widgets[] of POST_ROW
 * Detail:  GET  https://api.divar.ir/v8/posts-v2/web/:token -> sections[] of widgets
 */
const { parseInteger, parsePersianDateTime } = require('../text');

/** Normalize Persian labels for robust comparisons (ZWNJ, RTL marks, Arabic yeh/kaf, hamza above). */
function normalizeKey(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[\u200c\u200d\u200e\u200f]/g, '')
    .replace(/\u0654/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanValue(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[\u200e\u200f]/g, '').trim();
}

// ---------------------------------------------------------------------------
// Search (list page)
// ---------------------------------------------------------------------------

/** Parse "ودیعه: ۷۰۰,۰۰۰,۰۰۰ تومان" style list-row text into a money value (0 for free/full mortgage). */
function parseMoneyText(text) {
  if (!text) return null;
  const t = normalizeKey(text);
  if (/رایگان|رهن کامل|مجانی/.test(t)) return 0;
  if (/توافقی/.test(t)) return null;
  return parseInteger(t.includes(':') ? t.split(':').slice(1).join(':') : t);
}

/** "آژانس نمونه در شهرک غرب" -> publisher "آژانس نمونه"; "لحظاتی پیش در صادقیه" -> null. */
function parsePublisherFromBottomText(text) {
  if (!text) return null;
  const t = cleanValue(text).replace(/\s+/g, ' ');
  const idx = t.lastIndexOf(' در ');
  if (t.startsWith('در ') || idx <= 0) return null;
  const head = t.slice(0, idx).trim();
  if (/(پیش|لحظاتی|دقایقی|ساعت|دیروز|پریروز|روز|هفته|ماه)$/.test(head)) return null;
  // Divar prefixes "آژانس" even when the agency name already starts with it.
  return head.replace(/^(\S+) \1 /, '$1 ') || null;
}

function extractPostRows(searchResponse) {
  const widgets = Array.isArray(searchResponse?.list_widgets) ? searchResponse.list_widgets : [];
  return widgets
    .filter(w => w?.widget_type === 'POST_ROW')
    .map(w => w.data)
    .filter(d => d?.action?.payload?.token || d?.token);
}

/**
 * Parse a search response.
 * Returns { rows, hasNextPage, paginationData, serverPayload }.
 */
function parseSearchResponse(searchResponse) {
  return {
    rows: extractPostRows(searchResponse),
    hasNextPage: Boolean(searchResponse?.pagination?.has_next_page),
    paginationData: searchResponse?.pagination?.data || null,
    serverPayload: searchResponse?.search_data?.server_payload || null
  };
}

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------

function sectionWidgets(post, name) {
  const section = (post.sections || []).find(s => s.section_name === name);
  return section?.widgets || [];
}

/**
 * Flatten LIST_DATA widgets (including modal pages behind SELECTOR_ROWs) into attributes
 * plus a few structured extras. Keeps every value so nothing from the post is lost.
 */
function collectListData(widgets) {
  const attributes = [];
  const features = []; // { title, available }
  let rentSlider = null;

  const walk = (list, group) => {
    let currentGroup = group;
    let pendingLabel = null;
    for (const w of list || []) {
      const d = w?.data || {};
      switch (w?.widget_type) {
        case 'GROUP_INFO_ROW':
          for (const item of d.items || []) attributes.push({ group: 'info', name: item.title, value: cleanValue(item.value) });
          break;
        case 'UNEXPANDABLE_ROW':
          attributes.push({ group: currentGroup, name: d.title, value: cleanValue(d.value) });
          break;
        case 'GROUP_FEATURE_ROW':
          for (const item of d.items || []) {
            features.push({ title: item.title, available: item.available === true });
            attributes.push({ group: 'features', name: item.title, value: item.available === true ? 'true' : '' });
          }
          break;
        case 'FEATURE_ROW':
          features.push({ title: d.title, available: true });
          attributes.push({ group: 'features', name: d.title, value: '' });
          break;
        case 'RENT_SLIDER':
          rentSlider = d;
          break;
        case 'TITLE_ROW':
        case 'SECTION_TITLE_ROW':
          currentGroup = d.text || d.title || currentGroup;
          break;
        case 'DESCRIPTION_ROW':
          pendingLabel = d.text || null;
          break;
        case 'WRAPPER_ROW':
          for (const chip of d.chip_list?.chips || []) {
            attributes.push({ group: currentGroup, name: pendingLabel || 'tags', value: cleanValue(chip.text) });
          }
          pendingLabel = null;
          break;
        default:
          break;
      }
      const modal = d.action?.payload?.modal_page;
      if (modal?.widget_list) walk(modal.widget_list, modal.title || d.title || currentGroup);
    }
  };

  walk(widgets, 'specs');
  return {
    attributes: attributes.filter(a => a.name),
    features,
    rentSlider
  };
}

/** "۳ ماه پیش در تهران، نارمک، خیابان نمونه" -> { city, district, addressHint } */
function parseLocationLine(title) {
  if (!title) return { city: null, district: null, addressHint: null };
  const t = cleanValue(title).replace(/\s+/g, ' ');
  const idx = t.indexOf(' در ');
  const place = idx >= 0 ? t.slice(idx + 4) : t;
  const parts = place.split(/[،,]/).map(s => s.trim()).filter(Boolean);
  return {
    city: parts[0] || null,
    district: parts[1] || null,
    addressHint: parts.slice(2).join('، ') || null
  };
}

/** Parse "انتشار آگهی: ...\nآخرین نردبان: ...\nآخرین به‌روز‌رسانی: ..." */
function parseTimeline(text) {
  const out = { publishedAt: null, lastBumpedAt: null, updatedAt: null };
  if (!text) return out;
  for (const line of String(text).split('\n')) {
    const [label, ...rest] = line.split(':');
    const key = normalizeKey(label);
    const value = parsePersianDateTime(rest.join(':'));
    if (key.includes('انتشار')) out.publishedAt = value;
    else if (key.includes('نردبان')) out.lastBumpedAt = value;
    else if (key.includes('به روز') || key.includes('بهروز')) out.updatedAt = value;
  }
  return out;
}

function parseTitleSection(widgets) {
  const out = { title: null, locationLine: null, timeline: null };
  for (const w of widgets) {
    if (w.widget_type === 'LEGEND_TITLE_ROW') out.title = w.data?.title || null;
    if (w.widget_type === 'EXPANDABLE_SECTION') {
      out.locationLine = w.data?.title || null;
      const rows = w.data?.widget_list || [];
      out.timeline = rows.map(r => r.data?.text).filter(Boolean).join('\n');
    }
  }
  return out;
}

function parseImages(widgets) {
  const carousel = widgets.find(w => w.widget_type === 'IMAGE_CAROUSEL');
  return (carousel?.data?.items || [])
    .map(i => ({ url: i.image?.url, thumbnailUrl: i.image?.thumbnail_url || null }))
    .filter(i => i.url);
}

function parseMap(widgets) {
  const map = widgets.find(w => w.widget_type === 'MAP_ROW')?.data?.location;
  if (!map) return null;
  if (map.exact_data?.point) {
    return { latitude: map.exact_data.point.latitude, longitude: map.exact_data.point.longitude, exact: true, radius: null };
  }
  if (map.fuzzy_data?.point) {
    return {
      latitude: map.fuzzy_data.point.latitude,
      longitude: map.fuzzy_data.point.longitude,
      exact: false,
      radius: map.fuzzy_data.radius ?? null
    };
  }
  return null;
}

/**
 * Parse a posts-v2 detail response into a source-neutral intermediate structure.
 * Throws if the payload is not a post (e.g. HTML error page parsed upstream).
 */
function parsePostDetail(post) {
  if (!post || !Array.isArray(post.sections)) throw new Error('Invalid Divar post payload: missing sections');

  const titleSection = parseTitleSection(sectionWidgets(post, 'TITLE'));
  const descriptionRow = sectionWidgets(post, 'DESCRIPTION').find(w => w.widget_type === 'DESCRIPTION_ROW');
  const breadcrumb = sectionWidgets(post, 'BREADCRUMB').find(w => w.widget_type === 'BREADCRUMB')?.data;
  const tags = (sectionWidgets(post, 'TAGS').find(w => w.widget_type === 'WRAPPER_ROW')?.data?.chip_list?.chips || [])
    .map(c => c.text).filter(Boolean);
  const listData = collectListData(sectionWidgets(post, 'LIST_DATA'));

  return {
    token: post.webengage?.token || null,
    title: titleSection.title || post.share?.title || null,
    description: descriptionRow?.data?.text || null,
    location: parseLocationLine(titleSection.locationLine),
    timeline: parseTimeline(titleSection.timeline),
    images: parseImages(sectionWidgets(post, 'IMAGE')),
    map: parseMap(sectionWidgets(post, 'MAP')),
    breadcrumbs: (breadcrumb?.parent_items || []).map(i => i.title).filter(Boolean),
    tags,
    ...listData,
    analytics: post.analytics || {},
    webengage: post.webengage || {},
    seo: post.seo || {},
    city: post.city || {},
    webUrl: post.share?.web_url || null
  };
}

module.exports = {
  normalizeKey,
  parseMoneyText,
  parsePublisherFromBottomText,
  parseSearchResponse,
  parsePostDetail,
  parseLocationLine,
  parseTimeline,
  collectListData,
  cleanValue
};
