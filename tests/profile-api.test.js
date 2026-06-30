var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var fs = require('fs');
var path = require('path');

var TEST_DB = path.join(__dirname, 'test-profile-api.db');
var TEST_PROFILE = path.join(__dirname, 'test-evaluation-profile.md');

function startServer() {
  return new Promise(function(resolve, reject) {
    try { fs.unlinkSync(TEST_DB); } catch(e) {}
    fs.writeFileSync(TEST_PROFILE, '# Test Profile\n\n## Scoring weights\n| Dimension | Weight |\n|---|---|\n| Lifestyle | 100% |\n');
    var proc = require('child_process').spawn('node', ['-e', `
      process.env.DB_PATH = '${TEST_DB}';
      process.env.PROFILE_PATH = '${TEST_PROFILE}';
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
  try { fs.unlinkSync(TEST_DB); } catch(e) {}
  try { fs.unlinkSync(TEST_PROFILE); } catch(e) {}
}

function apiGet(port, urlPath) {
  return new Promise(function(resolve, reject) {
    http.get('http://localhost:' + port + urlPath, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    }).on('error', reject);
  });
}

function apiPost(port, urlPath, body) {
  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify(body);
    var opts = {
      hostname: 'localhost', port: port, path: urlPath, method: 'POST',
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

test('GET /api/profile returns evaluation profile content', async function() {
  var s;
  try {
    s = await startServer();
    var res = await apiGet(s.port, '/api/profile');
    assert.equal(res.status, 200);
    var body = JSON.parse(res.body);
    assert.ok(body.content.includes('# Test Profile'));
  } finally {
    stopServer(s);
  }
});

test('POST /api/profile saves new profile content', async function() {
  var s;
  try {
    s = await startServer();
    var newContent = '# Updated Profile\n\n## Scoring weights\n| Dimension | Weight |\n|---|---|\n| Compensation | 100% |\n';
    var res = await apiPost(s.port, '/api/profile', { content: newContent });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).success, true);

    var getRes = await apiGet(s.port, '/api/profile');
    assert.equal(JSON.parse(getRes.body).content, newContent);
  } finally {
    stopServer(s);
  }
});

test('POST /api/profile rejects empty content', async function() {
  var s;
  try {
    s = await startServer();
    var res = await apiPost(s.port, '/api/profile', { content: '' });
    assert.equal(res.status, 400);
  } finally {
    stopServer(s);
  }
});

test('POST /api/profile returns 500 when profile path is not writable', async function() {
  var s;
  var ROPath = path.join(__dirname, 'test-ro-profile.md');
  try {
    fs.writeFileSync(ROPath, '# Read Only Profile\n');
    fs.chmodSync(ROPath, 0o444);
    var proc = require('child_process').spawnSync('node', ['-e', `
      process.env.DB_PATH = '${TEST_DB}';
      process.env.PROFILE_PATH = '${ROPath}';
      process.env.PORT = '0';
      require('./src/server/server.js');
    `], { cwd: path.join(__dirname, '..'), timeout: 5000, encoding: 'utf8' });
    // Use startServer pattern with the read-only path
    s = await new Promise(function(resolve, reject) {
      try { fs.unlinkSync(TEST_DB); } catch(e) {}
      var cp = require('child_process').spawn('node', ['-e', `
        process.env.DB_PATH = '${TEST_DB}';
        process.env.PROFILE_PATH = '${ROPath}';
        process.env.PORT = '0';
        require('./src/server/server.js');
      `], { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] });
      var buf = '', started = false;
      var timer = setTimeout(function() { if (!started) { cp.kill(); reject(new Error('timeout')); } }, 5000);
      cp.stdout.on('data', function(d) {
        buf += d.toString();
        if (started) return;
        var m = d.toString().match(/localhost:(\d+)/);
        if (m) { started = true; clearTimeout(timer); resolve({ proc: cp, port: parseInt(m[1], 10) }); }
      });
      cp.stderr.on('data', function(d) { buf += d.toString(); });
    });
    var res = await apiPost(s.port, '/api/profile', { content: '# New Profile\n' });
    assert.equal(res.status, 500);
    var body = JSON.parse(res.body);
    assert.ok(body.error, 'Should return error message');
  } finally {
    stopServer(s);
    try { fs.chmodSync(ROPath, 0o644); fs.unlinkSync(ROPath); } catch(e) {}
  }
});
