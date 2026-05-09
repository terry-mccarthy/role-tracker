const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'pipeline.db');
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

module.exports = {
  // Companies CRUD
  getAllCompanies: () => {
    return db.prepare('SELECT * FROM companies ORDER BY id ASC').all();
  },
  
  saveCompany: (company) => {
    const { id, company: name, role, tier, stage, updated_at, data: rawData, ...rest } = company;
    const data = JSON.stringify(rest);
    
    const stmt = db.prepare(`
      INSERT INTO companies (id, company, role, tier, stage, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        company=excluded.company,
        role=excluded.role,
        tier=excluded.tier,
        stage=excluded.stage,
        data=excluded.data,
        updated_at=CURRENT_TIMESTAMP
    `);
    
    return stmt.run(id, name, role, tier, stage, data);
  },

  deleteCompany: (id) => {
    return db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  },

  // Generic Key-Value store (for things like nextId, etc. if needed)
  getKV: (key) => {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  setKV: (key, value) => {
    return db.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  },
  
  // Bulk migration helper
  migrateCompanies: (companiesList, nextId) => {
    const transaction = db.transaction((list) => {
      for (const c of list) {
        const { id, company: name, role, tier, stage, updated_at, data: rawData, ...rest } = c;
        delete rest.data; // Cleanup
        delete rest.updated_at;
        const insert = db.prepare(`
          INSERT INTO companies (id, company, role, tier, stage, data, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            company=excluded.company,
            role=excluded.role,
            tier=excluded.tier,
            stage=excluded.stage,
            data=excluded.data,
            updated_at=CURRENT_TIMESTAMP
        `);
        insert.run(id, name, role, tier, stage, JSON.stringify(rest));
      }
      if (nextId) {
        db.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('nextId', nextId.toString());
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
    delete data.data; // Clean up any old corrupted nested data
    delete data.updated_at;
    data.score = score;
    if (score.jd) data.jd = score.jd;
    
    // Auto-update tier (rank) based on score
    let tier = row.tier;
    const val = score.overall || score.overall_score;
    if (val >= 8) tier = 'A';
    else if (val >= 6) tier = 'B';
    else if (val >= 4) tier = 'C';
    else tier = 'D';

    const stmt = db.prepare('UPDATE companies SET data = ?, tier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    return stmt.run(JSON.stringify(data), tier, id);
  }
};
