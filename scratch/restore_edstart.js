const Database = require('better-sqlite3');
const db = new Database('pipeline.db');

const edstart = {
  id: 1,
  company: 'EdStart',
  role: 'Senior Full-Stack Software Engineer (Kotlin, React)',
  tier: 'A',
  stage: 'target',
  data: JSON.stringify({
    source: 'Network',
    url: 'https://www.linkedin.com/jobs/view/4211110594/',
    contact: '',
    next: '',
    notes: '',
    linked_documents: '',
    jd: "Edstart is looking for a Senior Full-Stack Software Engineer (Kotlin, React)...", // Truncated for script, but better than nothing
    added: '2026-05-09',
    score: null,
    activity: [{ date: 'May 9', text: 'Added to pipeline (Restored)' }]
  })
};

db.prepare(`
  INSERT INTO companies (id, company, role, tier, stage, data, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`).run(edstart.id, edstart.company, edstart.role, edstart.tier, edstart.stage, edstart.data);

console.log('Restored Edstart successfully.');
