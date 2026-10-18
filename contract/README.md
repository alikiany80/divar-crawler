# Real-estate listing contract v1

Single source of truth for the data exchanged between the public crawlers
(`kilid-crawler`, `divar-crawler`) and any consumer (database, backend, pipeline).
Each repo vendors a copy of `listing.v1.schema.json` at `contract/listing.v1.schema.json`
and has a test that validates its output/input against it.

## Transport

### JSONL (stdout or file)
One listing object per line, UTF-8, `schemaVersion: 1`.

### HTTP batch (crawler `--output=http`)
```
POST {SINK_URL}            e.g. https://backend.example/api/ingest/listings/
Authorization: Bearer {SINK_TOKEN}
Content-Type: application/json

{ "schemaVersion": 1, "listings": [ <listing>, ... ] }      # 1..100 listings
```
Responses:
- `200 {"received": n, "created": c, "updated": u, "rejected": [{"index": i, "error": "..."}]}`
- `400` malformed body / wrong schemaVersion · `401` bad token · `413` too many listings
Crawlers retry 5xx/429/network errors with backoff; 4xx are not retried.

## Rules
- Identity = `(source, sourceId)`; consumers upsert on it.
- `hasFullDetails: false` is a list summary: consumers must not overwrite known values with null.
- `images` / `attributes`: `null` or absent = unknown (keep existing); `[]` = explicitly none.
- Money in Toman; dates ISO-8601 UTC; Jalali year in `yearBuilt`.
- No personal contact data (phone numbers) is ever emitted.
- Breaking changes → new `listing.v2.schema.json`; consumers accept both during migration.
