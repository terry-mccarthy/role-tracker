var test = require('node:test');
var assert = require('node:assert/strict');
var { createCompanyRecord, computeFunnelStats, addInterviewNoteToCompany, logActivityToCompany } = require('../src/lib/pipeline.js');

// ── createCompanyRecord ───────────────────────────────────────────────

var BASE_FIELDS = {
  company: 'Acme', role: 'EM', tier: 'A', stage: 'target',
  source: 'Network', url: 'https://example.com', contact: 'Jane',
  next: 'Follow up', notes: 'Strong fit', jd: 'JD text here'
};

test('createCompanyRecord sets all fields', function() {
  var rec = createCompanyRecord(BASE_FIELDS, 42, '2026-05-07', '7 May');
  assert.equal(rec.id, 42);
  assert.equal(rec.company, 'Acme');
  assert.equal(rec.role, 'EM');
  assert.equal(rec.tier, 'A');
  assert.equal(rec.stage, 'target');
  assert.equal(rec.added, '2026-05-07');
  assert.equal(rec.score, null);
});

test('createCompanyRecord sets initial activity entry', function() {
  var rec = createCompanyRecord(BASE_FIELDS, 1, '2026-05-07', '7 May');
  assert.equal(rec.activity.length, 1);
  assert.equal(rec.activity[0].text, 'Added to pipeline');
  assert.equal(rec.activity[0].date, '7 May');
});

test('createCompanyRecord defaults optional fields to empty string', function() {
  var fields = { company: 'X', role: 'Y', tier: 'B', stage: 'warm', source: 'Network' };
  var rec = createCompanyRecord(fields, 1, '2026-05-07', '7 May');
  assert.equal(rec.url, '');
  assert.equal(rec.contact, '');
  assert.equal(rec.notes, '');
  assert.equal(rec.jd, '');
});

// ── computeFunnelStats ────────────────────────────────────────────────

function makeCompany(stage, source, tier) {
  return { stage: stage, source: source || 'Network', tier: tier || 'A' };
}

test('computeFunnelStats counts stages correctly', function() {
  var companies = [
    makeCompany('target'), makeCompany('target'), makeCompany('warm'),
    makeCompany('screen'), makeCompany('offer'), makeCompany('closed')
  ];
  var stats = computeFunnelStats(companies);
  assert.equal(stats.counts.target, 2);
  assert.equal(stats.counts.warm, 1);
  assert.equal(stats.counts.screen, 1);
  assert.equal(stats.counts.offer, 1);
  assert.equal(stats.counts.closed, 1);
});

test('computeFunnelStats screenCount includes screen+interview+offer', function() {
  var companies = [
    makeCompany('screen'), makeCompany('interview'), makeCompany('offer'),
    makeCompany('target'), makeCompany('closed')
  ];
  var stats = computeFunnelStats(companies);
  assert.equal(stats.screenCount, 3);
});

test('computeFunnelStats netConv is 0 with no network companies', function() {
  var stats = computeFunnelStats([makeCompany('target', 'Job Board')]);
  assert.equal(stats.netConv, 0);
});

test('computeFunnelStats calculates network conversion', function() {
  var companies = [
    makeCompany('screen', 'Network'),
    makeCompany('target', 'Network'),
    makeCompany('target', 'Network'),
    makeCompany('target', 'Network')
  ];
  var stats = computeFunnelStats(companies);
  assert.equal(stats.netConv, 25);
});

test('computeFunnelStats detects target_warm bottleneck', function() {
  var companies = [];
  for (var i = 0; i < 10; i++) companies.push(makeCompany('target'));
  companies.push(makeCompany('warm'));
  var stats = computeFunnelStats(companies);
  assert.equal(stats.bottleneck, 'target_warm');
});

test('computeFunnelStats detects warm_screen bottleneck', function() {
  var companies = [];
  for (var i = 0; i < 7; i++) companies.push(makeCompany('warm'));
  companies.push(makeCompany('screen'));
  var stats = computeFunnelStats(companies);
  assert.equal(stats.bottleneck, 'warm_screen');
});

test('computeFunnelStats returns null bottleneck for healthy pipeline', function() {
  var companies = [
    makeCompany('target'), makeCompany('target'),
    makeCompany('warm'), makeCompany('warm'),
    makeCompany('screen'), makeCompany('interview')
  ];
  var stats = computeFunnelStats(companies);
  assert.equal(stats.bottleneck, null);
});

test('computeFunnelStats counts tiers', function() {
  var companies = [
    makeCompany('target', 'Network', 'A'),
    makeCompany('target', 'Network', 'A'),
    makeCompany('warm',   'Network', 'B'),
    makeCompany('screen', 'Network', 'C')
  ];
  var stats = computeFunnelStats(companies);
  assert.equal(stats.tierA, 2);
  assert.equal(stats.tierB, 1);
  assert.equal(stats.tierC, 1);
});

test('computeFunnelStats handles empty array', function() {
  var stats = computeFunnelStats([]);
  assert.equal(stats.netConv, 0);
  assert.equal(stats.screenCount, 0);
  assert.equal(stats.bottleneck, null);
});

// ── addInterviewNoteToCompany ─────────────────────────────────────────

test('addInterviewNoteToCompany prepends note to empty array', function() {
  var c = { id: 1 };
  addInterviewNoteToCompany(c, 'Great chat', '14 May');
  assert.equal(c.interviewNotes.length, 1);
  assert.equal(c.interviewNotes[0].text, 'Great chat');
  assert.equal(c.interviewNotes[0].date, '14 May');
});

test('addInterviewNoteToCompany prepends to existing notes', function() {
  var c = { id: 1, interviewNotes: [{ date: '13 May', text: 'First note' }] };
  addInterviewNoteToCompany(c, 'Second note', '14 May');
  assert.equal(c.interviewNotes.length, 2);
  assert.equal(c.interviewNotes[0].text, 'Second note');
  assert.equal(c.interviewNotes[1].text, 'First note');
});

test('addInterviewNoteToCompany returns the company', function() {
  var c = { id: 1 };
  var result = addInterviewNoteToCompany(c, 'note', '14 May');
  assert.equal(result, c);
});

// ── logActivityToCompany ──────────────────────────────────────────────

test('logActivityToCompany prepends entry to empty array', function() {
  var c = { id: 1 };
  logActivityToCompany(c, 'Advanced to screen', '14 May');
  assert.equal(c.activity.length, 1);
  assert.equal(c.activity[0].text, 'Advanced to screen');
  assert.equal(c.activity[0].date, '14 May');
});

test('logActivityToCompany prepends to existing activity', function() {
  var c = { id: 1, activity: [{ date: '13 May', text: 'Added to pipeline' }] };
  logActivityToCompany(c, 'Called recruiter', '14 May');
  assert.equal(c.activity.length, 2);
  assert.equal(c.activity[0].text, 'Called recruiter');
  assert.equal(c.activity[1].text, 'Added to pipeline');
});

test('logActivityToCompany returns the company', function() {
  var c = { id: 1, activity: [] };
  var result = logActivityToCompany(c, 'note', '14 May');
  assert.equal(result, c);
});
