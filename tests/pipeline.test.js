var test = require('node:test');
var assert = require('node:assert/strict');
var { createCompanyRecord, computeFunnelStats, computeClosedStats, addInterviewNoteToCompany, logActivityToCompany, closeCompanyRecord, inferFurthestStage, bumpFurthestStage, parseCultureResponse, filterCompanies, daysSince } = require('../src/lib/pipeline.js');

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

test('createCompanyRecord initializes furthest_stage to the starting stage', function() {
  var rec = createCompanyRecord(BASE_FIELDS, 1, '2026-05-07', '7 May');
  assert.equal(rec.furthest_stage, 'target');
});

test('createCompanyRecord initializes furthest_stage for a non-default starting stage', function() {
  var fields = { company: 'X', role: 'Y', tier: 'B', stage: 'screen', source: 'Network' };
  var rec = createCompanyRecord(fields, 1, '2026-05-07', '7 May');
  assert.equal(rec.furthest_stage, 'screen');
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

// ── computeClosedStats ────────────────────────────────────────────────

function makeClosedCompany(furthestStage) {
  return { stage: 'closed', furthest_stage: furthestStage };
}

test('computeClosedStats ignores open companies', function() {
  var companies = [makeCompany('target'), makeCompany('interview')];
  var stats = computeClosedStats(companies);
  assert.equal(stats.total, 0);
});

test('computeClosedStats counts closed companies grouped by furthest_stage reached', function() {
  var companies = [
    makeClosedCompany('target'), makeClosedCompany('target'),
    makeClosedCompany('warm'),
    makeClosedCompany('interview'), makeClosedCompany('interview'), makeClosedCompany('interview'),
    makeCompany('screen') // still open, should not be counted
  ];
  var stats = computeClosedStats(companies);
  assert.equal(stats.total, 6);
  assert.equal(stats.byStage.target, 2);
  assert.equal(stats.byStage.warm, 1);
  assert.equal(stats.byStage.screen, 0);
  assert.equal(stats.byStage.interview, 3);
  assert.equal(stats.byStage.offer, 0);
});

test('computeClosedStats falls back to target for closed companies missing furthest_stage', function() {
  var companies = [makeClosedCompany(null), makeClosedCompany(undefined)];
  var stats = computeClosedStats(companies);
  assert.equal(stats.total, 2);
  assert.equal(stats.byStage.target, 2);
});

test('computeClosedStats handles empty array', function() {
  var stats = computeClosedStats([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.byStage.target, 0);
  assert.equal(stats.byStage.offer, 0);
});

// ── daysSince ────────────────────────────────────────────────────────

test('daysSince computes whole days between a past date and now', function() {
  var past = new Date(Date.now() - 3 * 86400000 - 1000); // just over 3 days ago
  assert.equal(daysSince(past.toISOString()), 3);
});

test('daysSince returns 0 for a date earlier today', function() {
  assert.equal(daysSince(new Date().toISOString()), 0);
});

test('daysSince returns null for missing or invalid date input', function() {
  assert.equal(daysSince(undefined), null);
  assert.equal(daysSince(null), null);
  assert.equal(daysSince(''), null);
  assert.equal(daysSince('not-a-date'), null);
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

// ── closeCompanyRecord ──────────────────────────────────────────────

test('closeCompanyRecord sets stage to closed', function() {
  var c = { id: 1, stage: 'interview', activity: [] };
  closeCompanyRecord(c, 'Interviewing', 'Ghosted after final round', '14 May');
  assert.equal(c.stage, 'closed');
});

test('closeCompanyRecord logs the furthest stage reached and the reason', function() {
  var c = { id: 1, stage: 'interview', activity: [] };
  closeCompanyRecord(c, 'Interviewing', 'Ghosted after final round', '14 May');
  assert.equal(c.activity.length, 1);
  assert.equal(c.activity[0].date, '14 May');
  assert.ok(c.activity[0].text.indexOf('Interviewing') !== -1, 'should mention furthest stage');
  assert.ok(c.activity[0].text.indexOf('Ghosted after final round') !== -1, 'should mention reason');
});

test('closeCompanyRecord prepends to existing activity', function() {
  var c = { id: 1, stage: 'screen', activity: [{ date: '10 May', text: 'Advanced to screen' }] };
  closeCompanyRecord(c, 'Screen', 'Position filled internally', '14 May');
  assert.equal(c.activity.length, 2);
  assert.equal(c.activity[1].text, 'Advanced to screen');
});

test('closeCompanyRecord defaults to "No reason given" when reason is blank', function() {
  var c = { id: 1, stage: 'target', activity: [] };
  closeCompanyRecord(c, 'Target List', '', '14 May');
  assert.ok(c.activity[0].text.indexOf('No reason given') !== -1);
});

test('closeCompanyRecord defaults to "No reason given" when reason is null', function() {
  var c = { id: 1, stage: 'target', activity: [] };
  closeCompanyRecord(c, 'Target List', null, '14 May');
  assert.ok(c.activity[0].text.indexOf('No reason given') !== -1);
});

test('closeCompanyRecord trims whitespace-only reason to "No reason given"', function() {
  var c = { id: 1, stage: 'target', activity: [] };
  closeCompanyRecord(c, 'Target List', '   ', '14 May');
  assert.ok(c.activity[0].text.indexOf('No reason given') !== -1);
});

test('closeCompanyRecord initializes activity array if missing', function() {
  var c = { id: 1, stage: 'warm' };
  closeCompanyRecord(c, 'Warming Up', 'No response', '14 May');
  assert.equal(c.activity.length, 1);
});

test('closeCompanyRecord returns the company', function() {
  var c = { id: 1, stage: 'offer', activity: [] };
  var result = closeCompanyRecord(c, 'Offer', 'Comp too low', '14 May');
  assert.equal(result, c);
});

test('closeCompanyRecord captures the pre-close stage as furthest_stage', function() {
  var c = { id: 1, stage: 'interview', activity: [] };
  closeCompanyRecord(c, 'Interviewing', 'Ghosted after final round', '14 May');
  assert.equal(c.furthest_stage, 'interview');
});

test('closeCompanyRecord does not regress furthest_stage if it was already ahead', function() {
  var c = { id: 1, stage: 'interview', furthest_stage: 'offer', activity: [] };
  closeCompanyRecord(c, 'Interviewing', 'Ghosted after final round', '14 May');
  assert.equal(c.furthest_stage, 'offer');
});

// ── bumpFurthestStage ─────────────────────────────────────────────────

test('bumpFurthestStage sets an unset furthest_stage to the candidate', function() {
  assert.equal(bumpFurthestStage(null, 'target'), 'target');
  assert.equal(bumpFurthestStage(undefined, 'screen'), 'screen');
});

test('bumpFurthestStage advances when the candidate is further along', function() {
  assert.equal(bumpFurthestStage('target', 'warm'), 'warm');
  assert.equal(bumpFurthestStage('warm', 'offer'), 'offer');
});

test('bumpFurthestStage never regresses to an earlier stage', function() {
  assert.equal(bumpFurthestStage('interview', 'screen'), 'interview');
  assert.equal(bumpFurthestStage('offer', 'target'), 'offer');
});

test('bumpFurthestStage is a no-op when the candidate equals the current stage', function() {
  assert.equal(bumpFurthestStage('interview', 'interview'), 'interview');
});

test('bumpFurthestStage ignores "closed" as a candidate (not a real funnel stage)', function() {
  assert.equal(bumpFurthestStage('offer', 'closed'), 'offer');
  assert.equal(bumpFurthestStage(null, 'closed'), null);
});

// ── inferFurthestStage ──────────────────────────────────────────────

test('inferFurthestStage picks the highest stage keyword found in activity text', function() {
  var activity = [
    { date: '14 May', text: 'Closed at Interviewing — Reason: Ghosted' },
    { date: '10 May', text: 'Advanced to Interviewing' },
    { date: '5 May', text: 'Advanced to Screen' }
  ];
  assert.equal(inferFurthestStage(activity), 'interview');
});

test('inferFurthestStage prefers offer over interview when both are present', function() {
  var activity = [
    { date: '14 May', text: 'Closed at Offer — Reason: Comp too low' },
    { date: '10 May', text: 'Advanced to Interviewing' }
  ];
  assert.equal(inferFurthestStage(activity), 'offer');
});

test('inferFurthestStage defaults to target when no stage keyword matches', function() {
  var activity = [{ date: '14 May', text: 'Closed at Target List — Reason: No response' }];
  assert.equal(inferFurthestStage(activity), 'target');
});

test('inferFurthestStage defaults to target for empty or missing activity', function() {
  assert.equal(inferFurthestStage([]), 'target');
  assert.equal(inferFurthestStage(null), 'target');
  assert.equal(inferFurthestStage(undefined), 'target');
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
