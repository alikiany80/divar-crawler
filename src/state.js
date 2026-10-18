/**
 * Crawl state: which listings were already seen and whether full details were stored.
 * Lets `--mode=recent` stop early and skip detail fetches with any sink (sqlite, jsonl, http).
 */
const crypto = require('node:crypto');
const { openDatabase, transaction, runMigrations } = require('./db');

const MIGRATIONS = [
  {
    version: 1,
    name: 'seen',
    up(db) {
      db.exec(`
        CREATE TABLE seen (
          source_id TEXT PRIMARY KEY,
          has_full_details INTEGER NOT NULL DEFAULT 0,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          content_hash TEXT
        );
        CREATE INDEX idx_seen_last_seen_at ON seen(last_seen_at);
      `);
    }
  }
];

/** Stable hash of a contract listing, ignoring the per-run crawledAt timestamp. */
function contentHash(listing) {
  const { crawledAt, ...rest } = listing;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

class StateStore {
  constructor(dbPath) {
    this.db = openDatabase(dbPath);
    runMigrations(this.db, 'state', MIGRATIONS);
    this.stmts = {
      get: this.db.prepare('SELECT source_id, has_full_details, first_seen_at, last_seen_at, content_hash FROM seen WHERE source_id = ?'),
      upsert: this.db.prepare(`
        INSERT INTO seen (source_id, has_full_details, first_seen_at, last_seen_at, content_hash)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (source_id) DO UPDATE SET
          has_full_details = MAX(seen.has_full_details, excluded.has_full_details),
          last_seen_at = excluded.last_seen_at,
          content_hash = COALESCE(excluded.content_hash, seen.content_hash)
      `)
    };
  }

  get(sourceId) {
    const row = this.stmts.get.get(String(sourceId));
    return row ? { ...row, has_full_details: row.has_full_details === 1 } : null;
  }

  isKnown(sourceId) {
    return this.get(sourceId) !== null;
  }

  needsDetails(sourceId) {
    const row = this.get(sourceId);
    return !row || !row.has_full_details;
  }

  /** Record listings as seen in one transaction: [{ sourceId, hasFullDetails, contentHash }]. */
  markSeen(entries, { now = new Date().toISOString() } = {}) {
    if (!entries.length) return;
    transaction(this.db, () => {
      for (const e of entries) {
        this.stmts.upsert.run(String(e.sourceId), e.hasFullDetails ? 1 : 0, now, now, e.contentHash || null);
      }
    });
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM seen').get().n;
  }

  close() {
    this.db.close();
  }
}

module.exports = { StateStore, contentHash };
