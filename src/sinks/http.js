/**
 * HttpSink: POST batches of contract listings to an ingest endpoint
 * ({ schemaVersion: 1, listings: [...] } with `Authorization: Bearer <token>`).
 * Retries 429/5xx/network errors with exponential backoff; 4xx responses are not retried.
 */
const { createLogger } = require('../logger');
const { SCHEMA_VERSION } = require('../listing');

const log = createLogger('sink.http');
const MAX_BATCH = 100;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class HttpSinkError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'HttpSinkError';
    this.status = status;
  }
}

class HttpSink {
  constructor({
    url, token, batchSize = 25, timeoutMs = 20000, maxRetries = 4, backoffMs = 1000,
    fetch: fetchImpl = fetch, sleep: sleepImpl = sleep
  } = {}) {
    if (!url) throw new Error('HttpSink requires SINK_URL');
    if (!token) throw new Error('HttpSink requires SINK_TOKEN');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
      throw new Error(`HttpSink batchSize must be 1..${MAX_BATCH}`);
    }
    this.name = 'http';
    this.url = url;
    this.token = token;
    this.batchSize = batchSize;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.backoffMs = backoffMs;
    this.fetchImpl = fetchImpl;
    this.sleep = sleepImpl;
    this.buffer = [];
    this.written = 0;
    this.totals = { batches: 0, received: 0, created: 0, updated: 0, rejected: 0 };
  }

  async write(listing) {
    this.buffer.push(listing);
    if (this.buffer.length >= this.batchSize) await this.flush();
  }

  async flush() {
    while (this.buffer.length) {
      const batch = this.buffer.slice(0, this.batchSize);
      await this.send(batch);
      this.buffer.splice(0, batch.length);
      this.written += batch.length;
    }
  }

  async send(listings) {
    const body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, listings });
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let res = null;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (err) {
        lastError = new HttpSinkError(`network error: ${err.message}`);
      }

      if (res) {
        if (res.ok) return this.handleResponse(res, listings.length);
        const text = await res.text().catch(() => '');
        lastError = new HttpSinkError(`sink responded ${res.status}: ${text.slice(0, 300)}`, res.status);
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) throw lastError;
      }

      if (attempt < this.maxRetries) {
        const waitMs = this.backoffMs * 2 ** (attempt - 1);
        log.warn('retrying sink batch', { attempt, status: res?.status ?? null, error: lastError.message, waitMs });
        await this.sleep(waitMs);
      }
    }
    throw lastError;
  }

  async handleResponse(res, size) {
    const data = await res.json().catch(() => ({}));
    const rejected = Array.isArray(data.rejected) ? data.rejected : [];
    this.totals.batches++;
    this.totals.received += Number(data.received) || 0;
    this.totals.created += Number(data.created) || 0;
    this.totals.updated += Number(data.updated) || 0;
    this.totals.rejected += rejected.length;
    log.info('sink batch accepted', {
      size, received: data.received ?? null, created: data.created ?? null, updated: data.updated ?? null,
      rejected: rejected.length
    });
    for (const r of rejected.slice(0, 10)) log.warn('sink rejected listing', { index: r.index, error: r.error });
    return data;
  }

  async close() {
    await this.flush();
    log.info('sink totals', this.totals);
  }
}

module.exports = { HttpSink, HttpSinkError, MAX_BATCH };
