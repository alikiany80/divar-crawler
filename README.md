# divar-crawler

A small crawler for **residential real-estate listings on [Divar](https://divar.ir)**: apartments, houses/villas
and similar, both buy (`residential-sell`) and rent (`residential-rent`). It turns each listing into one normalized
record that follows the [listing contract v1](contract/README.md) and writes it to SQLite, JSONL or an HTTP endpoint.

- Zero npm dependencies. Node.js >= 22.13 (uses the built-in `node:sqlite`, `fetch` and `node:test`).
- Polite by default: one request every 1.5 s, and it backs off on HTTP 429.
- Incremental: a `recent` crawl stops once it reaches listings it has already seen, and it only fetches detail
  pages for new listings or listings that are still incomplete.
- **No contact data.** Phone numbers and contact endpoints are never requested. Contact blocks, owner ids and
  tracking ids are removed from the raw payloads before they are stored.

## Install

```bash
git clone https://github.com/alikiany80/divar-crawler.git
cd divar-crawler
node bin/divar-crawler.js --help      # there is nothing to install
```

`npm link` (optional) puts a `divar-crawler` command on your PATH.

## Usage

```bash
# Default run: buy + rent, recent mode, 3 pages each, saved to data/divar.sqlite
node bin/divar-crawler.js

# Rent only, 1 page, saved to SQLite and to a JSONL file
node bin/divar-crawler.js --category=rent --pages=1 --output=sqlite,jsonl --jsonl=data/rent.jsonl

# Stream JSONL to stdout (logs go to stderr) and keep only list summaries
node bin/divar-crawler.js --category=buy --no-details --output=jsonl --jsonl=- | jq .title

# Push batches to an ingest API
SINK_URL=https://ingest.example/api/listings/ SINK_TOKEN=... node bin/divar-crawler.js --output=http
```

| Flag | Default | Meaning |
|---|---|---|
| `--category=buy\|rent\|all` | `all` | which category to crawl |
| `--mode=recent\|full` | `recent` | `recent` stops after `--stop-after` known listings in a row; `full` crawls every page up to `--pages` |
| `--pages=N` | 3 (`full`: 50) | maximum number of search pages per category |
| `--stop-after=N` | 30 | how many known listings in a row end a `recent` crawl |
| `--no-details` | off | skip detail pages and keep only list summaries |
| `--output=LIST` | `sqlite` | comma-separated list of `sqlite`, `jsonl`, `http` |
| `--db=PATH` | `data/divar.sqlite` | SQLite file for crawl state and the `sqlite` output |
| `--jsonl=-\|PATH` | `-` | JSONL target (`-` means stdout; a file is appended to) |

Exit codes: `0` success, `1` a crawl or a sink failed, `2` invalid configuration.
At the end of a run the crawler logs a `run summary` line on stderr with per-category stats
(`pagesCrawled`, `listingsCrawled`, `newListings`, `updatedListings`, `detailsFailed`, `stopReason`)
and HTTP counters (`requests`, `retries`, `rateLimited`).

## Outputs

- **sqlite**: a complete local database with these tables:
  - `listings`: every contract column, plus `details_json`, `raw_json`, `first_seen_at`, `last_seen_at` and `details_fetched_at`
  - `listing_images`
  - `listing_attributes`: every spec row from the page

  Rows are upserted on `source_id`. A summary never overwrites a known value with NULL.
- **jsonl**: one contract object per line.
- **http**: sends `POST {SINK_URL}` with `Authorization: Bearer {SINK_TOKEN}` and the body
  `{"schemaVersion":1,"listings":[...]}`. Batches hold 25 listings by default (maximum 100). The sink retries
  429, 5xx and network errors with backoff, but not other 4xx responses.

Crawl state (the `seen` table) is stored in the `--db` file whatever outputs you choose, so `recent` mode works with
JSONL or HTTP too.

### Record format

Each record follows [`contract/listing.v1.schema.json`](contract/listing.v1.schema.json):

- Money is in Toman. For rent listings, `priceToman` is the deposit and `rentToman` is the monthly rent.
- Areas are in m². Dates are ISO-8601 UTC. `yearBuilt` is a Jalali year.
- `hasFullDetails: false` means the record is a list summary. Its `images`/`attributes` are `null` (unknown).

The `details` object holds Divar-specific fields:

| Field | Meaning |
|---|---|
| `category_slug`, `parent_category_slug`, `category_title` | Divar category, e.g. `apartment-sell` / `residential-sell` |
| `city_slug`, `district_slug`, `address_hint` | location slugs and the free-text street hint |
| `location_radius_m` | radius of a fuzzy map point (null when exact) |
| `business_type`, `business_ref` | `personal`, `premium-panel`, ... (agency vs. personal) |
| `images_are_real`, `deed_type`, `building_direction`, `occupancy_status` | spec rows |
| `is_rent_convertible`, `convertible_deposit_toman`, `convertible_rent_toman` | rent/deposit conversion slider |
| `last_bumped_at`, `unavailable_after` | timeline |
| `tags_json`, `breadcrumbs_json` | arrays of strings |
| `list_row_json` | the search-list row (sanitized) |
| `raw_json` | the full detail payload (sanitized; detail records only) |

## Environment variables

See [.env.example](.env.example). Node can load that file with `node --env-file=.env bin/divar-crawler.js`.

| Variable | Default | |
|---|---|---|
| `DIVAR_DB_PATH` | `data/divar.sqlite` | used when `--db` is not given |
| `DIVAR_CITY_IDS` | `1` | comma-separated Divar city ids (1 = Tehran) |
| `DIVAR_DELAY_MS` | `1500` | minimum delay between requests |
| `HTTP_TIMEOUT_MS` | `20000` | timeout for each request |
| `HTTP_MAX_RETRIES` | `4` | attempts for network errors, 5xx and 429 |
| `HTTP_RATE_LIMIT_BACKOFF_MS` | `15000` | wait after a 429 is `this × attempt` (or `Retry-After` when sent) |
| `SINK_URL`, `SINK_TOKEN` | – | required only with `--output=http` |
| `SINK_BATCH_SIZE` | `25` | 1..100 |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`. Logs are JSON lines on **stderr** |

## Rate limits and etiquette

Divar's web API answers `HTTP 429` at about 2.5 requests per second. The default delay of 1.5 s keeps well under
that limit. On a 429 the client waits 15 s × attempt before retrying. **Do not lower `DIVAR_DELAY_MS` below
1000.** Crawl only what you need: prefer `recent` mode on a schedule over repeated `full` crawls.

## Legal

This project is for **personal and educational use**. Respect Divar's terms of service and `robots.txt`, and do not
republish listing content. The crawler collects **no contact data**: it never requests phone numbers, and the
contact sections of the payload are removed before storage.

## How it works

```
bin/divar-crawler.js    CLI entry
src/config.js           flags + env -> validated config
src/divar/adapter.js    POST /v8/postlist/w/search (paginated), GET /v8/posts-v2/web/:token
src/divar/parser.js     pure payload parsing (widgets -> fields)
src/divar/normalize.js  parsed post -> normalized listing
src/listing.js          normalized listing -> contract v1 object
src/runner.js           crawl loop (recent/full, dedupe, detail fetch, error isolation, stats)
src/state.js            seen-table state store (node:sqlite, WAL)
src/sinks/*.js          sqlite, jsonl, http outputs
src/http-client.js      throttle, timeouts, redirects, cookies, 429/5xx backoff
```

Pagination works like this: the next page request sends the previous response's `pagination.data` as
`pagination_data` and its `search_data.server_payload`. When a later page has no `search_data`, the previous
`server_payload` is reused.

## Tests

```bash
npm test        # = node --test "tests/**/*.test.js"
```

The tests use **sanitized** fixtures in `tests/fixtures/divar/`. These keep the real payload structure but contain
synthetic titles, descriptions, publisher names, tokens (`gaTEST…`) and image URLs (`example.com`). A contract test
checks that every normalized fixture validates against the schema. It uses the small in-repo validator in
`tests/schema-validator.js`.

---

## فارسی

**divar-crawler** آگهی‌های املاک مسکونی دیوار (خرید و اجاره) را جمع‌آوری می‌کند. هر آگهی را به یک رکورد
استاندارد مطابق [قرارداد v1](contract/README.md) تبدیل می‌کند و در SQLite، فایل JSONL یا یک API ذخیره می‌کند.

- نصب لازم نیست: فقط Node.js نسخهٔ 22.13 یا بالاتر.
- اجرا: `node bin/divar-crawler.js --category=rent --pages=1 --output=sqlite,jsonl --jsonl=data/rent.jsonl`
- شهر با `DIVAR_CITY_IDS` تعیین می‌شود (پیش‌فرض ۱ = تهران).
- بین درخواست‌ها ۱٫۵ ثانیه فاصله است و در صورت خطای 429 صبر می‌کند. لطفاً این فاصله را کم نکنید.
- **هیچ اطلاعات تماسی (شماره تلفن) دریافت یا ذخیره نمی‌شود.**
- فقط برای استفادهٔ شخصی و آموزشی است. قوانین و شرایط استفادهٔ دیوار را رعایت کنید.
- تست‌ها: `npm test`
