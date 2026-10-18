/**
 * SqliteSink: full local database of contract listings (default sink for standalone use).
 * Upserts on source_id; summaries (hasFullDetails=false) never overwrite known values with NULL.
 */
const { openDatabase, transaction, runMigrations, toSql } = require('../db');

/** Contract field -> listings column. */
const COLUMNS = [
  ['url', 'url'],
  ['title', 'title'],
  ['description', 'description'],
  ['listingType', 'listing_type'],
  ['propertyType', 'property_type'],
  ['cityName', 'city_name'],
  ['regionName', 'region_name'],
  ['neighborhoodName', 'neighborhood_name'],
  ['locationLabel', 'location_label'],
  ['latitude', 'latitude'],
  ['longitude', 'longitude'],
  ['locationIsExact', 'location_is_exact'],
  ['priceToman', 'price_toman'],
  ['rentToman', 'rent_toman'],
  ['pricePerMeter', 'price_per_meter'],
  ['isPriceNegotiable', 'is_price_negotiable'],
  ['areaM2', 'area_m2'],
  ['landAreaM2', 'land_area_m2'],
  ['rooms', 'rooms'],
  ['yearBuilt', 'year_built'],
  ['buildingAge', 'building_age'],
  ['floor', 'floor'],
  ['totalFloors', 'total_floors'],
  ['unitsPerFloor', 'units_per_floor'],
  ['parkingCount', 'parking_count'],
  ['hasParking', 'has_parking'],
  ['hasElevator', 'has_elevator'],
  ['hasStorage', 'has_storage'],
  ['hasBalcony', 'has_balcony'],
  ['publisherKind', 'publisher_kind'],
  ['publisherName', 'publisher_name'],
  ['coverImageUrl', 'cover_image_url'],
  ['imageCount', 'image_count'],
  ['publishedAt', 'published_at'],
  ['sourceUpdatedAt', 'source_updated_at']
];

const MIGRATIONS = [
  {
    version: 1,
    name: 'listings',
    up(db) {
      db.exec(`
        CREATE TABLE listings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL UNIQUE,
          url TEXT,
          title TEXT,
          description TEXT,
          listing_type TEXT NOT NULL CHECK (listing_type IN ('BUY', 'RENT')),
          property_type TEXT,
          city_name TEXT,
          region_name TEXT,
          neighborhood_name TEXT,
          location_label TEXT,
          latitude REAL,
          longitude REAL,
          location_is_exact INTEGER,
          price_toman INTEGER,
          rent_toman INTEGER,
          price_per_meter INTEGER,
          is_price_negotiable INTEGER,
          area_m2 REAL,
          land_area_m2 REAL,
          rooms INTEGER,
          year_built INTEGER,
          building_age INTEGER,
          floor INTEGER,
          total_floors INTEGER,
          units_per_floor INTEGER,
          parking_count INTEGER,
          has_parking INTEGER,
          has_elevator INTEGER,
          has_storage INTEGER,
          has_balcony INTEGER,
          publisher_kind TEXT,
          publisher_name TEXT,
          cover_image_url TEXT,
          image_count INTEGER,
          published_at TEXT,
          source_updated_at TEXT,
          has_full_details INTEGER NOT NULL DEFAULT 0,
          details_json TEXT,
          raw_json TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          details_fetched_at TEXT
        );
        CREATE INDEX idx_listings_type_price ON listings(listing_type, price_toman);
        CREATE INDEX idx_listings_area ON listings(area_m2);
        CREATE INDEX idx_listings_neighborhood ON listings(neighborhood_name);
        CREATE INDEX idx_listings_published_at ON listings(published_at);
        CREATE INDEX idx_listings_last_seen_at ON listings(last_seen_at);

        CREATE TABLE listing_images (
          listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          url TEXT NOT NULL,
          thumbnail_url TEXT,
          PRIMARY KEY (listing_id, position)
        );

        CREATE TABLE listing_attributes (
          listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
          group_name TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL,
          value TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (listing_id, group_name, name, value)
        );
        CREATE INDEX idx_listing_attributes_name ON listing_attributes(name, value);
      `);
    }
  }
];

/** Split contract `details` into details_json (source fields) and raw_json (original payload). */
function splitDetails(details) {
  if (!details) return { detailsJson: null, rawJson: null };
  const { raw_json: raw, ...rest } = details;
  return { detailsJson: rest, rawJson: raw ?? null };
}

class SqliteSink {
  constructor(dbPath) {
    this.name = 'sqlite';
    this.dbPath = dbPath;
    this.db = openDatabase(dbPath);
    runMigrations(this.db, 'sqlite_sink', MIGRATIONS);
    this.written = 0;

    const cols = COLUMNS.map(([, c]) => c);
    const updates = cols.map(c => `${c} = COALESCE(excluded.${c}, listings.${c})`).join(',\n        ');
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO listings (source, source_id, ${cols.join(', ')}, has_full_details, details_json, raw_json,
          first_seen_at, last_seen_at, details_fetched_at)
        VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id) DO UPDATE SET
        ${updates},
        has_full_details = MAX(listings.has_full_details, excluded.has_full_details),
        details_json = CASE WHEN excluded.has_full_details = 1 OR listings.details_json IS NULL
          THEN COALESCE(excluded.details_json, listings.details_json) ELSE listings.details_json END,
        raw_json = COALESCE(excluded.raw_json, listings.raw_json),
        last_seen_at = excluded.last_seen_at,
        details_fetched_at = COALESCE(excluded.details_fetched_at, listings.details_fetched_at)
        RETURNING id
      `),
      deleteImages: this.db.prepare('DELETE FROM listing_images WHERE listing_id = ?'),
      insertImage: this.db.prepare('INSERT OR IGNORE INTO listing_images (listing_id, position, url, thumbnail_url) VALUES (?, ?, ?, ?)'),
      deleteAttributes: this.db.prepare('DELETE FROM listing_attributes WHERE listing_id = ?'),
      insertAttribute: this.db.prepare('INSERT OR IGNORE INTO listing_attributes (listing_id, group_name, name, value) VALUES (?, ?, ?, ?)')
    };
  }

  /** Upsert one contract listing atomically (row + images + attributes). */
  upsert(listing, { now = new Date().toISOString() } = {}) {
    return transaction(this.db, () => {
      const full = listing.hasFullDetails ? 1 : 0;
      const { detailsJson, rawJson } = splitDetails(listing.details);
      const { id } = this.stmts.upsert.get(
        listing.source, listing.sourceId,
        ...COLUMNS.map(([field]) => toSql(listing[field])),
        full, toSql(detailsJson), toSql(rawJson),
        now, now, full ? now : null
      );
      if (Array.isArray(listing.images)) {
        this.stmts.deleteImages.run(id);
        listing.images.forEach((img, i) => this.stmts.insertImage.run(id, i, img.url, img.thumbnailUrl || null));
      }
      if (Array.isArray(listing.attributes)) {
        this.stmts.deleteAttributes.run(id);
        for (const a of listing.attributes) this.stmts.insertAttribute.run(id, a.group, a.name, a.value);
      }
      return Number(id);
    });
  }

  async write(listing) {
    this.upsert(listing);
    this.written++;
  }

  async flush() {}

  async close() {
    this.db.close();
  }

  getListing(sourceId) {
    const row = this.db.prepare('SELECT * FROM listings WHERE source_id = ?').get(String(sourceId));
    if (!row) return null;
    return {
      ...row,
      images: this.db.prepare('SELECT position, url, thumbnail_url FROM listing_images WHERE listing_id = ? ORDER BY position').all(row.id),
      attributes: this.db.prepare('SELECT group_name, name, value FROM listing_attributes WHERE listing_id = ?').all(row.id)
    };
  }

  stats() {
    return { ...this.db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(has_full_details), 0) AS withFullDetails FROM listings
    `).get() };
  }
}

module.exports = { SqliteSink, COLUMNS };
