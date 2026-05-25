var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var fs = require('fs');
var path = require('path');

// ── Helpers ─────────────────────────────────────────────────────────────

var TEST_DB = path.join(__dirname, 'test-security.db');

function startServer(env) {
  return new Promise(function(resolve, reject) {
    try { fs.unlinkSync(TEST_DB); } catch(e) {}
    var port = 0; // let OS assign
    var proc = require('child_process').spawn('node', ['-e', `
      process.env.DB_PATH = '${TEST_DB}';
      process.env.PORT = '${port}';
      process.env.TAVILY_API_KEY = '${env.TAVILY_KEY || ''}';
      process.env.ANTHROPIC_API_KEY = '${env.ANTHROPIC_KEY || ''}';
      var srv = require('./server.js');
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
      if (m) {
        started = true;
        clearTimeout(timer);
        resolve({ proc: proc, port: parseInt(m[1], 10) });
      }
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
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    var req = http.request(opts, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
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
      res.on('end', function() { resolve({ status: res.statusCode, headers: res.headers, body: data }); });
    }).on('error', reject);
  });
}

function apiPostRaw(host, port, path, rawBody, contentType) {
  return new Promise(function(resolve, reject) {
    var opts = {
      hostname: host, port: port, path: path, method: 'POST',
      headers: {
        'Content-Type': contentType || 'application/json',
        'Content-Length': Buffer.byteLength(rawBody)
      }
    };
    var req = http.request(opts, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

test('body limit: rejects payload over 2MB', async function(t) {
  var s;
  try {
    s = await startServer({ TAVILY_KEY: '', ANTHROPIC_KEY: '' });
    // 2.5 MB string (just under the readBody buffer, then one more chunk)
    var big = '{"data":"' + 'x'.repeat(2 * 1024 * 1024) + '"}';
    var res = await apiPostRaw('localhost', s.port, '/api/save', big);
    assert.equal(res.status, 413, 'Should reject oversized payload');
    var parsed = JSON.parse(res.body);
    assert.ok(parsed.error, 'Should include error message');
  } finally {
    stopServer(s);
  }
});

test('invalid JSON returns 400', async function(t) {
  var s;
  try {
    s = await startServer({ TAVILY_KEY: '', ANTHROPIC_KEY: '' });
    var res = await apiPostRaw('localhost', s.port, '/api/save', 'not-json-at-all');
    assert.equal(res.status, 400);
    var parsed = JSON.parse(res.body);
    assert.ok(parsed.error, 'Should have error message');
    assert.ok(parsed.error.length > 0, 'Error should not be empty');
  } finally {
    stopServer(s);
  }
});

test('missing TAVILY_API_KEY returns 503 from proxy endpoints', async function(t) {
  var s;
  try {
    s = await startServer({ TAVILY_KEY: '', ANTHROPIC_KEY: '' });
    var res = await apiPost('localhost', s.port, '/proxy/tavily', { urls: ['https://example.com'] });
    assert.equal(res.status, 503);
    var parsed = JSON.parse(res.body);
    assert.ok(parsed.error.indexOf('TAVILY_API_KEY') !== -1);
  } finally {
    stopServer(s);
  }
});

test('missing ANTHROPIC_API_KEY returns 503 from proxy', async function(t) {
  var s;
  try {
    s = await startServer({ TAVILY_KEY: '', ANTHROPIC_KEY: '' });
    var res = await apiPostRaw('localhost', s.port, '/proxy/anthropic', '{}');
    assert.equal(res.status, 503);
    var parsed = JSON.parse(res.body);
    assert.ok(parsed.error.indexOf('ANTHROPIC_API_KEY') !== -1);
  } finally {
    stopServer(s);
  }
});

test('API endpoints never return API keys', async function(t) {
  var s;
  try {
    s = await startServer({ TAVILY_KEY: 'tvly-fake', ANTHROPIC_KEY: 'sk-ant-fake' });
    // GET /api/companies should not include keys
    var res = await apiGet('localhost', s.port, '/api/companies');
    assert.equal(res.status, 200);
    var data = JSON.parse(res.body);
    var bodyStr = JSON.stringify(data);
    assert.equal(bodyStr.indexOf('tvly-fake'), -1, 'Should not leak TAVILY key');
    assert.equal(bodyStr.indexOf('sk-ant-fake'), -1, 'Should not leak ANTHROPIC key');

    // Save a company with XSS payload
    var saveRes = await apiPost('localhost', s.port, '/api/save', {
      id: 1, company: '<script>alert("xss")</script>', role: 'EM', tier: 'A', stage: 'target'
    });
    assert.equal(saveRes.status, 200);

    // Retrieve and verify stored data is raw, not executed
    var getRes = await apiGet('localhost', s.port, '/api/companies');
    var companies = JSON.parse(getRes.body).companies;
    assert.equal(companies[0].company, '<script>alert("xss")</script>',
      'Data should be stored and returned raw with no sanitization loss');
  } finally {
    stopServer(s);
  }
});

test('CORS headers allow cross-origin requests', async function(t) {
  var s;
  try {
    s = await startServer({ TAVILY_KEY: '', ANTHROPIC_KEY: '' });
    var res = await apiGet('localhost', s.port, '/api/companies');
    assert.equal(res.headers['access-control-allow-origin'], '*');
  } finally {
    stopServer(s);
  }
});

test('OPTIONS preflight returns 204 with CORS headers', async function(t) {
  var s;
  try {
    s = await startServer({ TAVILY_KEY: '', ANTHROPIC_KEY: '' });
    var res = await new Promise(function(resolve, reject) {
      var opts = {
        hostname: 'localhost', port: s.port, path: '/api/companies', method: 'OPTIONS'
      };
      var req = http.request(opts, function(res) {
        resolve({ status: res.statusCode, headers: res.headers });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
  } finally {
    stopServer(s);
  }
});

test('static file traversal prevention (../)', async function(t) {
  var s;
  try {
    s = await startServer({ TAVILY_KEY: '', ANTHROPIC_KEY: '' });
    // Attempt path traversal via URL encoding
    var res = await apiGet('localhost', s.port, '/..%2f..%2f.env');
    // Should either get 404 or the static file serving, but never the actual .env content
    if (res.status === 200) {
      var body = res.body;
      // Double-check we didn't get the actual .env file content
      assert.equal(body.indexOf('TAVILY_API_KEY'), -1, 'Should not serve .env content');
    } else {
      assert.equal(res.status, 404);
    }
  } finally {
    stopServer(s);
  }
});
