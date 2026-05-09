const Database = require('better-sqlite3');
const db = new Database('pipeline.db');

// Restore Clio's culture data from logs
const clioId = 2;
const row = db.prepare('SELECT data FROM companies WHERE id = ?').get(clioId);

if (row) {
  const data = JSON.parse(row.data);
  data.culture_rating = 2;
  data.culture_notes = "Clio has a generally positive culture with a strong emphasis on being 'human and high-performing.' Pros include great benefits, a collaborative environment, and interesting work in legal tech. Cons mentioned often relate to the fast pace of growth and some growing pains in communication as they scale globally.";
  
  db.prepare('UPDATE companies SET data = ? WHERE id = ?').run(JSON.stringify(data), clioId);
  console.log('Restored Clio culture data.');
}

console.log('Done.');
