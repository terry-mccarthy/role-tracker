var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var fs = require('fs');
var path = require('path');

// ── Helpers ─────────────────────────────────────────────────────────────

var TEST_DB = path.join(__dirname, 'test-roundtrip.db');

function startServer() {
  return new Promise(function(resolve, reject) {
    try { fs.unlinkSync(TEST_DB); } catch(e) {}
    var proc = require('child_process').spawn('node', ['-e', `
      process.env.DB_PATH = '${TEST_DB}';
      process.env.PORT = '0';
      require('./server.js');
    `], { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] });
    var started = false;
    var buf = '';
    var timer = setTimeout(function() {
      if (!started) { proc.kill(); reject(new Error('Server did not start. Output: ' + buf)); }
    }, 5000);
    proc.stdout.on('data', function(d) { buf += d.toString(); });
    proc.stderr.on('data', function(d) { buf += d.toString(); });
    proc.stdout.on('data', function(d) {
      if (started) return;
      var m = d.toString().match(/localhost:(\d+)/);
      if (m) { started = true; clearTimeout(timer); resolve({ proc: proc, port: parseInt(m[1], 10) }); }
    });
  });
}

function stopServer(s) {
  if (s && s.proc) try { s.proc.kill('SIGTERM'); } catch(e) {}
  try { fs.unlinkSync(TEST_DB); } catch(e) {}
}

function apiPost(host, port, path, body) {
  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify(body);
    var opts = {
      hostname: host, port: port, path: path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    var req = http.request(opts, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function apiGet(host, port, path) {
  return new Promise(function(resolve, reject) {
    http.get('http://' + host + ':' + port + path, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    }).on('error', reject);
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

test('score round-trip: save company, add score, retrieve', async function(t) {
  var s;
  try {
    s = await startServer();

    // Step 1: Save a company
    var saveRes = await apiPost('localhost', s.port, '/api/save', {
      id: 1, company: 'Acme', role: 'Engineering Manager', tier: 'A', stage: 'target'
    });
    assert.equal(saveRes.status, 200);
    assert.equal(JSON.parse(saveRes.body).success, true);

    // Step 2: Save a score for that company
    var score = {
      overall: 8,
      verdict: 'Strong fit across most dimensions',
      hard_nos_pass: true,
      dimensions: [
        { name: 'Lifestyle', weight: '25%', score: 8, detail: 'Good lifestyle fit' }
      ],
      tensions: ['Commute vs office days'],
      discovery_items: ['Confirm hybrid policy'],
      scored_at: '2026-05-25',
      jd: 'Engineering Manager at Acme...'
    };

    var scoreRes = await apiPost('localhost', s.port, '/api/save-score', {
      id: 1, score: score
    });
    assert.equal(scoreRes.status, 200);
    assert.equal(JSON.parse(scoreRes.body).success, true);

    // Step 3: Retrieve company and verify score is present
    var getRes = await apiGet('localhost', s.port, '/api/companies');
    assert.equal(getRes.status, 200);
    var data = JSON.parse(getRes.body);
    assert.equal(data.companies.length, 1);

    var company = data.companies[0];
    assert.equal(company.id, 1);
    assert.equal(company.tier, 'A', 'Score 8 should map to tier A');

    // Parse the data JSON blob to get the score
    var storedData = JSON.parse(company.data);
    assert.ok(storedData.score, 'Score should be present in company data');
    assert.equal(storedData.score.overall, 8);
    assert.equal(storedData.score.verdict, 'Strong fit across most dimensions');
    assert.equal(storedData.score.hard_nos_pass, true);
    assert.equal(storedData.score.scored_at, '2026-05-25');
    assert.ok(storedData.jd, 'JD should be stored alongside score');
    assert.equal(storedData.jd.indexOf('Acme') !== -1, true);
  } finally {
    stopServer(s);
  }
});

test('score round-trip: score for non-existent company is silently handled', async function(t) {
  var s;
  try {
    s = await startServer();

    var score = { overall: 5, verdict: 'Ok' };
    var res = await apiPost('localhost', s.port, '/api/save-score', {
      id: 999, score: score
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).success, true);

    // Verify no phantom company was created
    var getRes = await apiGet('localhost', s.port, '/api/companies');
    assert.equal(JSON.parse(getRes.body).companies.length, 0);
  } finally {
    stopServer(s);
  }
});

test('score round-trip: score updates tier correctly', async function(t) {
  var s;
  try {
    s = await startServer();

    await apiPost('localhost', s.port, '/api/save', {
      id: 1, company: 'BetaCorp', role: 'Dev', tier: 'B', stage: 'target'
    });

    // Score 9 → tier A
    await apiPost('localhost', s.port, '/api/save-score', {
      id: 1, score: { overall: 9, verdict: 'Excellent fit' }
    });

    var getRes = await apiGet('localhost', s.port, '/api/companies');
    var company = JSON.parse(getRes.body).companies[0];
    assert.equal(company.tier, 'A', 'Score 9 should upgrade tier to A');

    // Score 5 → tier C
    await apiPost('localhost', s.port, '/api/save-score', {
      id: 1, score: { overall: 5, verdict: 'Mediocre fit' }
    });

    getRes = await apiGet('localhost', s.port, '/api/companies');
    company = JSON.parse(getRes.body).companies[0];
    assert.equal(company.tier, 'C', 'Score 5 should downgrade tier to C');

    // Score 3 → tier D
    await apiPost('localhost', s.port, '/api/save-score', {
      id: 1, score: { overall: 3, verdict: 'Poor fit' }
    });

    getRes = await apiGet('localhost', s.port, '/api/companies');
    company = JSON.parse(getRes.body).companies[0];
    assert.equal(company.tier, 'D', 'Score 3 should set tier to D');
  } finally {
    stopServer(s);
  }
});

test('score round-trip: multiple companies each retain independent scores', async function(t) {
  var s;
  try {
    s = await startServer();

    // Save 3 companies
    await apiPost('localhost', s.port, '/api/save', { id: 1, company: 'Acme', role: 'EM', tier: 'A', stage: 'target' });
    await apiPost('localhost', s.port, '/api/save', { id: 2, company: 'Globex', role: 'Engineer', tier: 'B', stage: 'warm' });
    await apiPost('localhost', s.port, '/api/save', { id: 3, company: 'Initech', role: 'PM', tier: 'C', stage: 'screen' });

    // Score them
    await apiPost('localhost', s.port, '/api/save-score', { id: 1, score: { overall: 8, verdict: 'Good' } });
    await apiPost('localhost', s.port, '/api/save-score', { id: 2, score: { overall: 6, verdict: 'Okay' } });
    await apiPost('localhost', s.port, '/api/save-score', { id: 3, score: { overall: 4, verdict: 'Weak' } });

    // Verify each has its own score
    var getRes = await apiGet('localhost', s.port, '/api/companies');
    var companies = JSON.parse(getRes.body).companies;
    assert.equal(companies.length, 3);

    var scores = companies.map(function(c) {
      var d = JSON.parse(c.data);
      return { id: c.id, overall: d.score ? d.score.overall : null, tier: c.tier };
    });

    assert.equal(scores[0].id, 1); assert.equal(scores[0].overall, 8); assert.equal(scores[0].tier, 'A');
    assert.equal(scores[1].id, 2); assert.equal(scores[1].overall, 6); assert.equal(scores[1].tier, 'B');
    assert.equal(scores[2].id, 3); assert.equal(scores[2].overall, 4); assert.equal(scores[2].tier, 'C');
  } finally {
    stopServer(s);
  }
});
