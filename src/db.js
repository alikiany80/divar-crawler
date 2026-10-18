/**
 * SQLite helpers shared by StateStore and SqliteSink (node:sqlite, no dependencies).
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openDatabase(dbPath) {
  if (!dbPath) throw new Error('openDatabase requires a path');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // temp_store=MEMORY: SQLite otherwise spills temp files to /var/tmp, which is not writable in
  // sandboxed/containerized deployments ("unable to open database file").
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
  `);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Apply versioned migrations for one component ("state", "sqlite_sink", ...).
 * migrations: [{ version, name, up(db) }] in ascending version order.
 */
function runMigrations(db, component, migrations) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      component TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (component, version)
    )
  `);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations WHERE component = ?').all(component).map(r => r.version)
  );
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    transaction(db, () => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (component, version, name, applied_at) VALUES (?, ?, ?, ?)')
        .run(component, m.version, m.name, new Date().toISOString());
    });
  }
}

/** SQLite bindings accept null/number/string/bigint/buffer only. */
function toSql(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

module.exports = { openDatabase, transaction, runMigrations, toSql };
