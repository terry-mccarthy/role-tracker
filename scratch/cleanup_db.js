const Database = require('better-sqlite3');
const db = new Database('pipeline.db');

const companies = db.prepare('SELECT * FROM companies').all();

for (const c of companies) {
  let currentData = c.data;
  let finalObj = {};
  
  // Recursively parse and merge
  function flatten(blob) {
    if (!blob) return;
    let parsed;
    try {
      parsed = typeof blob === 'string' ? JSON.parse(blob) : blob;
    } catch (e) {
      return;
    }
    
    // Merge everything except the nested 'data' and DB columns
    for (let key in parsed) {
      if (key !== 'data' && key !== 'id' && key !== 'updated_at') {
        finalObj[key] = parsed[key];
      }
    }
    
    // If there's a nested data blob, flatten it too
    if (parsed.data) {
      flatten(parsed.data);
    }
  }

  flatten(currentData);
  
  // Save the cleaned object
  db.prepare('UPDATE companies SET data = ? WHERE id = ?').run(JSON.stringify(finalObj), c.id);
  console.log(`Cleaned up company ${c.id}: ${c.company}`);
}

console.log('Database cleanup complete.');
