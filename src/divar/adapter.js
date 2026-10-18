const { HttpClient } = require('../http-client');
const { parseSearchResponse, parsePostDetail } = require('./parser');
const { normalizeDivarSummary, normalizeDivarDetails } = require('./normalize');

const API_BASE = 'https://api.divar.ir/v8';

/** Residential categories only (sell + rent), matching the scope agreed for this phase. */
const CATEGORIES = {
  buy: 'residential-sell',
  rent: 'residential-rent'
};

/**
 * Divar source adapter (public JSON API used by divar.ir web).
 * Cursor = { paginationData, serverPayload } returned by the previous search page.
 */
class DivarAdapter {
  constructor({ http = {}, delayMs = 1500, cityIds = ['1'], client } = {}) {
    this.name = 'divar';
    this.categories = Object.keys(CATEGORIES);
    this.cityIds = cityIds.map(String);
    this.client = client || new HttpClient({
      ...http,
      delayMs,
      headers: { Origin: 'https://divar.ir', Referer: 'https://divar.ir/' }
    });
  }

  buildSearchBody(categorySlug, cursor) {
    const body = {
      city_ids: this.cityIds,
      search_data: {
        form_data: { data: { category: { str: { value: categorySlug } } } }
      }
    };
    if (cursor?.serverPayload) body.search_data.server_payload = cursor.serverPayload;
    if (cursor?.paginationData) body.pagination_data = cursor.paginationData;
    return body;
  }

  async fetchPage(category, cursor) {
    const slug = CATEGORIES[category];
    if (!slug) throw new Error(`Unknown divar category '${category}'`);

    const response = await this.client.postJson(`${API_BASE}/postlist/w/search`, this.buildSearchBody(slug, cursor));
    const parsed = parseSearchResponse(response);
    const items = parsed.rows.map(row => normalizeDivarSummary(row, slug));
    const page = parsed.paginationData?.page ?? null;

    const nextCursor = parsed.hasNextPage && parsed.paginationData && items.length > 0
      ? { paginationData: parsed.paginationData, serverPayload: parsed.serverPayload || cursor?.serverPayload || null }
      : null;
    return { items, nextCursor, page };
  }

  async fetchDetails(summary) {
    const raw = await this.client.getJson(`${API_BASE}/posts-v2/web/${encodeURIComponent(summary.sourceId)}`);
    return normalizeDivarDetails(parsePostDetail(raw), raw, summary);
  }
}

module.exports = { DivarAdapter, CATEGORIES };
