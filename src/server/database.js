const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../pipeline.db');
const db = new Database(dbPath);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY,
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    tier TEXT,
    stage TEXT,
    data TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migrations: add columns if they don't exist yet
['culture_rating INTEGER', 'culture_notes TEXT'].forEach(function(col) {
  try { db.exec('ALTER TABLE companies ADD COLUMN ' + col); } catch(e) { /* already exists */ }
});

// Data migration: promote culture fields from JSON blob into dedicated columns
// Only runs for rows where the columns are still NULL but the blob has the data
(function migrateCultureColumns() {
  const rows = db.prepare('SELECT id, data FROM companies WHERE culture_rating IS NULL OR culture_notes IS NULL').all();
  const stmt = db.prepare('UPDATE companies SET culture_rating = ?, culture_notes = ? WHERE id = ?');
  for (const row of rows) {
    try {
      const blob = JSON.parse(row.data || '{}');
      if (blob.culture_rating || blob.culture_notes) {
        stmt.run(blob.culture_rating || null, blob.culture_notes || null, row.id);
      }
    } catch(e) { /* malformed blob — skip */ }
  }
})();

/**
 * Maps a numeric overall score (1–10) to a tier label (A/B/C/D).
 * Single source of truth — used by saveScore and by the frontend.
 */
function scoreTier(val) {
  if (val >= 8) return 'A';
  if (val >= 6) return 'B';
  if (val >= 4) return 'C';
  return 'D';
}

// Prepared statements (hoisted for reuse)
const stmtUpsertCompany = db.prepare(`
  INSERT INTO companies (id, company, role, tier, stage, data, culture_rating, culture_notes, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET
    company=excluded.company,
    role=excluded.role,
    tier=excluded.tier,
    stage=excluded.stage,
    data=excluded.data,
    culture_rating=excluded.culture_rating,
    culture_notes=excluded.culture_notes,
    updated_at=CURRENT_TIMESTAMP
`);

module.exports = {
  scoreTier,

  // Companies CRUD
  getAllCompanies: () => {
    return db.prepare('SELECT * FROM companies ORDER BY id ASC').all();
  },
  
  saveCompany: (company) => {
    const { id, company: name, role, tier, stage, updated_at, data: rawData, culture_rating, culture_notes, ...rest } = company;
    const data = JSON.stringify(rest);
    return stmtUpsertCompany.run(id, name, role, tier, stage, data, culture_rating || null, culture_notes || null);
  },

  deleteCompany: (id) => {
    return db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  },

  // Generic Key-Value store (for things like nextId, etc.)
  getKV: (key) => {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  setKV: (key, value) => {
    return db.prepare(
      'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    ).run(key, value);
  },
  
  // Bulk migration helper
  migrateCompanies: (companiesList, nextId) => {
    const transaction = db.transaction((list) => {
      for (const c of list) {
        const { id, company: name, role, tier, stage, updated_at, data: rawData, culture_rating, culture_notes, ...rest } = c;
        delete rest.data;
        delete rest.updated_at;
        stmtUpsertCompany.run(id, name, role, tier, stage, JSON.stringify(rest), culture_rating || null, culture_notes || null);
      }
      if (nextId) {
        db.prepare(
          'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
        ).run('nextId', nextId.toString());
      }
    });
    transaction(companiesList);
  },
  
  saveScore: (id, score) => {
    console.log('[DB] saveScore - id:', id, 'score:', score ? 'present' : 'null');
    const row = db.prepare('SELECT data, tier FROM companies WHERE id = ?').get(id);
    if (!row) {
      console.error('[DB] saveScore - No company found with ID:', id);
      return;
    }
    
    const data = JSON.parse(row.data);
    delete data.data;      // Clean up any old corrupted nested data
    delete data.updated_at;
    data.score = score;
    if (score.jd) data.jd = score.jd;
    
    // Use shared scoreTier helper — single source of truth
    const val = score.overall || score.overall_score;
    const tier = scoreTier(val);

    const stmt = db.prepare(
      'UPDATE companies SET data = ?, tier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    return stmt.run(JSON.stringify(data), tier, id);
  },

  /** Wipe all pipeline data (used by the Reset button). */
  resetAll: () => {
    db.transaction(() => {
      db.prepare('DELETE FROM companies').run();
      db.prepare("DELETE FROM kv_store WHERE key = 'nextId'").run();
    })();
  },
};
