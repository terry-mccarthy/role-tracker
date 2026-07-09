var test = require('node:test');
var assert = require('node:assert/strict');
var { createCompanyRecord, computeFunnelStats, addInterviewNoteToCompany, logActivityToCompany, parseCultureResponse, filterCompanies } = require('../src/lib/pipeline.js');

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
  assert.equal(rec.activity[0].text, 'Added to pipeline (target)');
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

test('computeFunnelStats cumulative counts include downstream stages', function() {
  var companies = [
    makeCompany('target'), makeCompany('warm'),
    makeCompany('screen'), makeCompany('interview'), makeCompany('offer')
  ];
  var c = computeFunnelStats(companies).cumulative;
  assert.equal(c.target, 5);
  assert.equal(c.warm, 4);
  assert.equal(c.screen, 3);
  assert.equal(c.interview, 2);
  assert.equal(c.offer, 1);
});

test('computeFunnelStats cumulative never produces >100% conversion for mid-funnel adds', function() {
  // Simulates adding 10 companies directly to warm with only 1 in target
  var companies = [makeCompany('target')];
  for (var i = 0; i < 10; i++) companies.push(makeCompany('warm'));
  var c = computeFunnelStats(companies).cumulative;
  var convRate = Math.round((c.warm / c.target) * 100);
  assert.ok(convRate <= 100, 'conversion rate should not exceed 100% (got ' + convRate + '%)');
});

test('computeFunnelStats cumulative excludes closed companies', function() {
  var companies = [
    makeCompany('target'), makeCompany('offer'), makeCompany('closed')
  ];
  var c = computeFunnelStats(companies).cumulative;
  assert.equal(c.target, 2);
  assert.equal(c.offer, 1);
});

// ── filterCompanies ───────────────────────────────────────────────────

test('filterCompanies returns full list when query is empty', function() {
  var list = [{ company: 'Acme', role: 'Engineer', contact: '' }];
  assert.deepEqual(filterCompanies(list, ''), list);
  assert.deepEqual(filterCompanies(list, null), list);
});

test('filterCompanies matches on company name', function() {
  var list = [
    { company: 'Acme', role: 'Engineer', contact: '' },
    { company: 'Globex', role: 'Manager', contact: '' }
  ];
  var result = filterCompanies(list, 'acme');
  assert.equal(result.length, 1);
  assert.equal(result[0].company, 'Acme');
});

test('filterCompanies matches on role', function() {
  var list = [
    { company: 'Acme', role: 'Senior Engineer', contact: '' },
    { company: 'Globex', role: 'Product Manager', contact: '' }
  ];
  var result = filterCompanies(list, 'product');
  assert.equal(result.length, 1);
  assert.equal(result[0].company, 'Globex');
});

test('filterCompanies matches on contact', function() {
  var list = [
    { company: 'Acme', role: 'Engineer', contact: 'Sarah Chen' },
    { company: 'Globex', role: 'Manager', contact: 'Bob Smith' }
  ];
  var result = filterCompanies(list, 'sarah');
  assert.equal(result.length, 1);
  assert.equal(result[0].company, 'Acme');
});

test('filterCompanies is case-insensitive', function() {
  var list = [{ company: 'Canva', role: 'Engineering Manager', contact: 'Alice' }];
  assert.equal(filterCompanies(list, 'CANVA').length, 1);
  assert.equal(filterCompanies(list, 'engineering MANAGER').length, 1);
  assert.equal(filterCompanies(list, 'ALICE').length, 1);
});

test('filterCompanies returns empty array when nothing matches', function() {
  var list = [{ company: 'Acme', role: 'Engineer', contact: 'Bob' }];
  assert.equal(filterCompanies(list, 'zzznomatch').length, 0);
});

test('filterCompanies handles missing contact field', function() {
  var list = [{ company: 'Acme', role: 'Engineer' }];
  assert.doesNotThrow(function() { filterCompanies(list, 'sarah'); });
  assert.equal(filterCompanies(list, 'acme').length, 1);
});

test('filterCompanies matches by id: prefix', function() {
  var list = [
    { id: 5, company: 'Acme', role: 'Engineer' },
    { id: 10, company: 'Globex', role: 'Manager' }
  ];
  var result = filterCompanies(list, 'id:5');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 5);
});

test('filterCompanies id: returns empty when id not found', function() {
  var list = [
    { id: 5, company: 'Acme', role: 'Engineer' },
    { id: 10, company: 'Globex', role: 'Manager' }
  ];
  assert.equal(filterCompanies(list, 'id:999').length, 0);
});

test('filterCompanies id: with no number returns empty', function() {
  var list = [
    { id: 5, company: 'Acme', role: 'Engineer' }
  ];
  assert.equal(filterCompanies(list, 'id:').length, 0);
});

test('filterCompanies id: with non-numeric value returns empty', function() {
  var list = [
    { id: 5, company: 'Acme', role: 'Engineer' }
  ];
  assert.equal(filterCompanies(list, 'id:abc').length, 0);
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
  var c = { id: 1, activity: [{ date: '13 May', text: 'Added to pipeline (target)' }] };
  logActivityToCompany(c, 'Called recruiter', '14 May');
  assert.equal(c.activity.length, 2);
  assert.equal(c.activity[0].text, 'Called recruiter');
  assert.equal(c.activity[1].text, 'Added to pipeline (target)');
});

test('logActivityToCompany returns the company', function() {
  var c = { id: 1, activity: [] };
  var result = logActivityToCompany(c, 'note', '14 May');
  assert.equal(result, c);
});

// ── parseCultureResponse ──────────────────────────────────────────────

test('parseCultureResponse parses valid JSON', function() {
  var raw = '{"rating": 4, "summary": "Great culture."}';
  var r = parseCultureResponse(raw);
  assert.equal(r.rating, 4);
  assert.equal(r.summary, 'Great culture.');
});

test('parseCultureResponse extracts JSON from surrounding prose', function() {
  var raw = 'Here is the result:\n{"rating": 3, "summary": "Mixed reviews."}\nDone.';
  var r = parseCultureResponse(raw);
  assert.equal(r.rating, 3);
  assert.equal(r.summary, 'Mixed reviews.');
});

test('parseCultureResponse handles backtick-delimited summary', function() {
  var raw = '{"rating": 3, "summary": `* Good culture.\n* Remote friendly.`}';
  var r = parseCultureResponse(raw);
  assert.equal(r.rating, 3);
  assert.ok(r.summary.indexOf('Good culture') !== -1);
  assert.ok(r.summary.indexOf('Remote friendly') !== -1);
});

test('parseCultureResponse handles backtick with embedded double quotes', function() {
  var raw = '{"rating": 2, "summary": `Employees say "management is poor".`}';
  var r = parseCultureResponse(raw);
  assert.equal(r.rating, 2);
  assert.ok(r.summary.indexOf('management is poor') !== -1);
});

test('parseCultureResponse returns null for empty input', function() {
  assert.equal(parseCultureResponse(''), null);
  assert.equal(parseCultureResponse(null), null);
});

test('parseCultureResponse returns null when no JSON object found', function() {
  assert.equal(parseCultureResponse('no json here'), null);
});

test('parseCultureResponse coerces rating to integer', function() {
  var raw = '{"rating": "4", "summary": "Good."}';
  var r = parseCultureResponse(raw);
  assert.equal(r.rating, 4);
  assert.equal(typeof r.rating, 'number');
});

test('parseCultureResponse handles unescaped newlines in summary', function() {
  var raw = '{\n  "rating": 3,\n  "summary": "Line one.\nLine two.\nLine three."\n}';
  var r = parseCultureResponse(raw);
  assert.ok(r !== null, 'should not return null');
  assert.equal(r.rating, 3);
  assert.ok(r.summary.indexOf('Line one') !== -1);
  assert.ok(r.summary.indexOf('Line two') !== -1);
});
