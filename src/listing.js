/**
 * Normalized listing -> contract v1 object (contract/listing.v1.schema.json).
 * Keeps only schema keys, converts undefined/non-finite numbers to null, and leaves
 * images/attributes null when unknown (summary rows) so consumers keep existing values.
 */
const SCHEMA_VERSION = 1;

const NULLABLE_FIELDS = [
  'title', 'description', 'propertyType',
  'cityName', 'regionName', 'neighborhoodName', 'locationLabel', 'latitude', 'longitude', 'locationIsExact',
  'priceToman', 'rentToman', 'pricePerMeter', 'isPriceNegotiable',
  'areaM2', 'landAreaM2', 'rooms', 'yearBuilt', 'buildingAge', 'floor', 'totalFloors', 'unitsPerFloor',
  'parkingCount', 'hasParking', 'hasElevator', 'hasStorage', 'hasBalcony',
  'publisherKind', 'publisherName', 'coverImageUrl', 'imageCount', 'publishedAt', 'sourceUpdatedAt'
];

const INTEGER_FIELDS = new Set([
  'rooms', 'yearBuilt', 'buildingAge', 'floor', 'totalFloors', 'unitsPerFloor', 'parkingCount', 'imageCount'
]);

function cleanValue(field, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (INTEGER_FIELDS.has(field) && !Number.isInteger(value)) return Math.round(value);
  }
  return value;
}

function cleanImages(images) {
  if (!Array.isArray(images)) return null;
  return images
    .filter(img => img && typeof img.url === 'string' && img.url)
    .map(img => ({ url: img.url, thumbnailUrl: img.thumbnailUrl || null }));
}

function cleanAttributes(attributes) {
  if (!Array.isArray(attributes)) return null;
  return attributes
    .filter(a => a && a.name)
    .map(a => ({
      group: a.group === undefined || a.group === null ? '' : String(a.group),
      name: String(a.name),
      value: a.value === undefined || a.value === null ? '' : String(a.value)
    }));
}

function toContractListing(normalized, { crawledAt = new Date().toISOString() } = {}) {
  if (!normalized || !normalized.sourceId) throw new Error('Listing is missing sourceId');
  if (normalized.listingType !== 'BUY' && normalized.listingType !== 'RENT') {
    throw new Error(`Listing ${normalized.sourceId} has invalid listingType '${normalized.listingType}'`);
  }

  const out = {
    schemaVersion: SCHEMA_VERSION,
    source: normalized.source,
    sourceId: String(normalized.sourceId),
    url: normalized.url,
    crawledAt,
    hasFullDetails: normalized.hasFullDetails === true,
    listingType: normalized.listingType
  };
  for (const field of NULLABLE_FIELDS) out[field] = cleanValue(field, normalized[field]);
  out.images = cleanImages(normalized.images);
  out.attributes = cleanAttributes(normalized.attributes);
  out.details = normalized.details && typeof normalized.details === 'object' ? normalized.details : null;
  return out;
}

module.exports = { toContractListing, SCHEMA_VERSION, NULLABLE_FIELDS };
