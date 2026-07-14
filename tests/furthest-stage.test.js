var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var fs = require('fs');
var path = require('path');

// ── Helpers ─────────────────────────────────────────────────────────────

var TEST_DB = path.join(__dirname, 'test-furthest-stage.db');

function startServer() {
  return new Promise(function(resolve, reject) {
    var proc = require('child_process').spawn('node', ['-e', `
      process.env.DB_PATH = '${TEST_DB}';
      process.env.PORT = '0';
      require('./src/server/server.js');
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
}

function cleanupDb() {
  try { fs.unlinkSync(TEST_DB); } catch(e) {}
}

function apiPost(port, apiPath, body) {
  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify(body);
    var opts = {
      hostname: 'localhost', port: port, path: apiPath, method: 'POST',
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

function apiGet(port, apiPath) {
  return new Promise(function(resolve, reject) {
    http.get('http://localhost:' + port + apiPath, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    }).on('error', reject);
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

test('furthest_stage: saving a closed company persists an explicit furthest_stage', async function(t) {
  var s;
  cleanupDb();
  try {
    s = await startServer();

    await apiPost(s.port, '/api/save', {
      id: 1, company: 'Acme', role: 'EM', tier: 'A', stage: 'closed', furthest_stage: 'interview'
    });

    var getRes = await apiGet(s.port, '/api/companies');
    var company = JSON.parse(getRes.body).companies[0];
    assert.equal(company.furthest_stage, 'interview');
  } finally {
    stopServer(s);
    cleanupDb();
  }
});

test('furthest_stage: legacy closed companies without furthest_stage are backfilled from activity text on startup', async function(t) {
  var s;
  cleanupDb();
  try {
    // First boot: import a "legacy" closed company the way old data looked —
    // stage already 'closed', no furthest_stage, only activity text to go on.
    s = await startServer();
    await apiPost(s.port, '/api/migrate', {
      companies: [{
        id: 1, company: 'Globex', role: 'Staff Eng', tier: 'B', stage: 'closed',
        activity: [
          { date: '1 Jun', text: 'Marked as closed' },
          { date: '20 May', text: 'Advanced to Screen' },
          { date: '10 May', text: 'Advanced to Warming Up' }
        ]
      }],
      nextId: 2
    });
    stopServer(s);

    // Second boot: the backfill migration should run and fill furthest_stage in.
    s = await startServer();
    var getRes = await apiGet(s.port, '/api/companies');
    var company = JSON.parse(getRes.body).companies[0];
    assert.equal(company.furthest_stage, 'screen');
  } finally {
    stopServer(s);
    cleanupDb();
  }
});

test('furthest_stage: backfill sets non-closed companies to their current stage', async function(t) {
  var s;
  cleanupDb();
  try {
    s = await startServer();
    await apiPost(s.port, '/api/migrate', {
      companies: [{
        id: 1, company: 'Initech', role: 'PM', tier: 'C', stage: 'screen',
        activity: [{ date: '1 Jun', text: 'Advanced to Screen' }]
      }],
      nextId: 2
    });
    stopServer(s);

    // Second boot: an open company still sitting mid-funnel should get
    // furthest_stage backfilled to its current stage — nothing is lost for
    // open jobs the way it is for closed ones, so no inference needed.
    s = await startServer();
    var getRes = await apiGet(s.port, '/api/companies');
    var company = JSON.parse(getRes.body).companies[0];
    assert.equal(company.furthest_stage, 'screen');
  } finally {
    stopServer(s);
    cleanupDb();
  }
});
