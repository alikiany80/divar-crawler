const { createLogger } = require('./logger');
const { HttpError } = require('./http-client');
const { toContractListing } = require('./listing');
const { contentHash } = require('./state');

/**
 * Crawl loop.
 *
 * Adapter contract:
 *   name: string
 *   categories: string[]                       e.g. ['buy', 'rent']
 *   fetchPage(category, cursor|null) -> { items, nextCursor|null, page }
 *   fetchDetails(summary) -> normalized listing
 *
 * Modes:
 *   recent: walk newest-first until `maxPages` or `stopAfterExisting` consecutive known listings.
 *   full:   walk up to `maxPages` regardless of known listings.
 * Details are fetched for new listings and for known ones still missing full details.
 * A failing detail fetch is isolated: the summary is emitted instead and counted in detailsFailed.
 */
class CrawlRunner {
  constructor(adapter, state, sinks, { fetchDetails = true, now = () => new Date().toISOString() } = {}) {
    if (!sinks || !sinks.length) throw new Error('CrawlRunner needs at least one sink');
    this.adapter = adapter;
    this.state = state;
    this.sinks = sinks;
    this.fetchDetails = fetchDetails;
    this.now = now;
  }

  async loadDetails(summary, log) {
    try {
      return await this.adapter.fetchDetails(summary);
    } catch (err) {
      // A removed/expired post is not a crawl failure; keep the summary.
      const level = err instanceof HttpError && (err.status === 404 || err.status === 410) ? 'info' : 'warn';
      log[level]('details fetch failed', { sourceId: summary.sourceId, error: err.message });
      return null;
    }
  }

  async emit(listing) {
    for (const sink of this.sinks) await sink.write(listing);
  }

  async crawl({ category, mode = 'recent', maxPages = 3, stopAfterExisting = 30 } = {}) {
    const source = this.adapter.name;
    if (!this.adapter.categories.includes(category)) {
      throw new Error(`Source '${source}' has no category '${category}' (available: ${this.adapter.categories.join(', ')})`);
    }
    if (mode !== 'recent' && mode !== 'full') throw new Error(`Unknown mode '${mode}'`);

    const log = createLogger('crawler', { source, category, mode });
    const stats = {
      pagesCrawled: 0, listingsCrawled: 0, newListings: 0, updatedListings: 0, detailsFailed: 0, stopReason: 'max_pages'
    };
    const seenThisRun = new Set();
    let consecutiveExisting = 0;
    let cursor = null;

    log.info('crawl started', { maxPages, stopAfterExisting, fetchDetails: this.fetchDetails });
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const { items, nextCursor, page } = await this.adapter.fetchPage(category, cursor);
      stats.pagesCrawled++;
      if (!items.length) { stats.stopReason = 'empty_page'; break; }

      for (const summary of items) {
        if (seenThisRun.has(summary.sourceId)) continue; // pinned/bumped posts repeat across pages
        seenThisRun.add(summary.sourceId);
        stats.listingsCrawled++;

        const known = this.state.get(summary.sourceId);
        let record = summary;
        if (this.fetchDetails && (!known || !known.has_full_details)) {
          const details = await this.loadDetails(summary, log);
          if (details) record = details;
          else stats.detailsFailed++;
        }

        const listing = toContractListing(record, { crawledAt: this.now() });
        await this.emit(listing);
        this.state.markSeen([{ sourceId: listing.sourceId, hasFullDetails: listing.hasFullDetails, contentHash: contentHash(listing) }]);

        if (known) {
          stats.updatedListings++;
          consecutiveExisting++;
        } else {
          stats.newListings++;
          consecutiveExisting = 0;
        }
      }

      const { stopReason, ...counts } = stats;
      log.info('page processed', { page: page ?? pageIndex, items: items.length, ...counts });

      if (mode === 'recent' && consecutiveExisting >= stopAfterExisting) { stats.stopReason = 'caught_up'; break; }
      if (!nextCursor) { stats.stopReason = 'last_page'; break; }
      cursor = nextCursor;
    }

    for (const sink of this.sinks) await sink.flush();
    log.info('crawl finished', stats);
    return stats;
  }
}

module.exports = { CrawlRunner };
