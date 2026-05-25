#!/usr/bin/env node
// One-off import script — run with: node add-jobs.js
// Adds new roles found in the 25 May 2026 job scan.
// Safe to run multiple times — skips companies already present.

var Database = require('better-sqlite3');
var path = require('path');

var dbPath = process.env.DB_PATH || path.join(__dirname, 'pipeline.db');
var db = new Database(dbPath);

var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var d = new Date();
var todayISO = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
var todayLabel = months[d.getMonth()] + ' ' + d.getDate();

var newJobs = [
  {
    company: 'Lumi',
    role: 'Head of Engineering',
    url: 'https://au.indeed.com/viewjob?jk=5b2371f04496d724',
    source: 'Indeed',
    tier: 'B',
    notes: 'Series C fintech (SME lending), ~150 employees, Sydney. Cloud-native microservices. Referral perks, parental leave.'
  },
  {
    company: 'Checkbox',
    role: 'VP of Software Engineering',
    url: 'https://au.indeed.com/viewjob?jk=c0f5bee7b428d0bf',
    source: 'Indeed',
    tier: 'A',
    notes: 'B2B SaaS - legal/compliance automation. VP title, AI-forward culture, building distributed teams. Salary packaging.'
  }
];

var getNextId = db.prepare("SELECT value FROM kv_store WHERE key = 'nextId'");
var setNextId = db.prepare("UPDATE kv_store SET value = ? WHERE key = 'nextId'");
var checkExists = db.prepare("SELECT id FROM companies WHERE company = ?");
var upsert = db.prepare(`
  INSERT INTO companies (id, company, role, tier, stage, data, updated_at)
  VALUES (?, ?, ?, ?, 'target', ?, CURRENT_TIMESTAMP)
`);

var nextIdRow = getNextId.get();
var nextId = nextIdRow ? parseInt(nextIdRow.value, 10) : 36;

var added = 0;
var skipped = 0;

for (var i = 0; i < newJobs.length; i++) {
  var job = newJobs[i];
  var existing = checkExists.get(job.company);
  if (existing) {
    console.log('  SKIP   ' + job.company + ' (already in pipeline as id=' + existing.id + ')');
    skipped++;
    continue;
  }

  var data = JSON.stringify({
    url: job.url,
    source: job.source,
    contact: '',
    next: '',
    notes: job.notes,
    linked_documents: '',
    jd: '',
    added: todayISO,
    score: null,
    activity: [{ date: todayLabel, text: 'Added to pipeline (target)' }]
  });

  upsert.run(nextId, job.company, job.role, job.tier, data);
  console.log('  ADDED  id=' + nextId + '  ' + job.company + ' - ' + job.role);
  nextId++;
  added++;
}

setNextId.run(String(nextId));
db.close();

console.log('\nDone: ' + added + ' added, ' + skipped + ' skipped. nextId now ' + nextId + '.');
