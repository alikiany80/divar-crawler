const { createLogger } = require('./logger');

const log = createLogger('http');

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} on ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  setCookiesFromHeaders(headers) {
    const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
    for (const cookieStr of setCookies) {
      const parts = cookieStr.split(';')[0].split('=');
      if (parts.length >= 2) {
        this.cookies.set(parts[0].trim(), parts.slice(1).join('=').trim());
      }
    }
  }

  getCookieHeader() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Polite HTTP client: per-instance throttling, request timeout, cookie jar, manual redirects,
 * retries with backoff on network errors / 5xx, and longer backoff on 429 (rate limit).
 * Only used for idempotent reads (GET, and search POSTs that do not mutate state).
 */
class HttpClient {
  constructor(options = {}) {
    this.jar = new CookieJar();
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    this.delayMs = options.delayMs ?? 300;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? 15000;
    this.defaultHeaders = options.headers || {};
    this.lastRequestTime = 0;
    this.sleep = options.sleep || sleep;
    this.fetchImpl = options.fetch || fetch;
    this.stats = { requests: 0, retries: 0, rateLimited: 0 };
  }

  async throttle() {
    if (this.delayMs <= 0) return;
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.delayMs) await this.sleep(this.delayMs - elapsed);
  }

  buildHeaders(extra) {
    const headers = {
      'User-Agent': this.userAgent,
      'Accept-Language': 'fa,en-US;q=0.9,en;q=0.8',
      ...this.defaultHeaders,
      ...(extra || {})
    };
    const cookieHeader = this.jar.getCookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;
    return headers;
  }

  /** Single attempt following up to 5 redirects. */
  async fetchOnce(url, options) {
    let currentUrl = url;
    for (let redirects = 0; redirects <= 5; redirects++) {
      await this.throttle();
      const res = await this.fetchImpl(currentUrl, {
        method: options.method || 'GET',
        body: options.body,
        headers: this.buildHeaders(options.headers),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      this.lastRequestTime = Date.now();
      this.stats.requests++;
      this.jar.setCookiesFromHeaders(res.headers);

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      return res;
    }
    throw new Error(`Too many redirects for ${url}`);
  }

  retryDelay(res, attempt) {
    if (res && res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
      return this.rateLimitBackoffMs * attempt;
    }
    return 1000 * 2 ** (attempt - 1);
  }

  async request(url, options = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let res = null;
      try {
        res = await this.fetchOnce(url, options);
      } catch (err) {
        lastError = err;
      }

      if (res) {
        if (res.status === 429) this.stats.rateLimited++;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) return res;
        lastError = new HttpError(res.status, url);
        await res.arrayBuffer().catch(() => {});
      }

      if (attempt < this.maxRetries) {
        const wait = this.retryDelay(res, attempt);
        this.stats.retries++;
        log.warn('retrying request', {
          url, attempt, status: res?.status, error: res ? undefined : lastError?.message, waitMs: wait
        });
        await this.sleep(wait);
      }
    }
    throw lastError || new Error(`Failed to fetch ${url}`);
  }

  async ensureOk(res, url) {
    if (!res.ok) {
      await res.arrayBuffer().catch(() => {});
      throw new HttpError(res.status, url);
    }
    return res;
  }

  async getJson(url, options = {}) {
    const res = await this.request(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    await this.ensureOk(res, url);
    return res.json();
  }

  async postJson(url, body, options = {}) {
    const res = await this.request(url, {
      ...options,
      method: 'POST',
      body: JSON.stringify(body),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    await this.ensureOk(res, url);
    return res.json();
  }

  async getText(url, options = {}) {
    const res = await this.request(url, options);
    await this.ensureOk(res, url);
    return res.text();
  }
}

module.exports = { HttpClient, HttpError, CookieJar };
