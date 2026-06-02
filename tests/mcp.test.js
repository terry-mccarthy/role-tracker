var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var { spawn } = require('child_process');

// ── Helpers ─────────────────────────────────────────────────────────────

function startMockApi(handler) {
  return new Promise(function(resolve) {
    var server = http.createServer(function(req, res) {
      res.setHeader('Content-Type', 'application/json');
      handler(req, res);
    });
    server.listen(0, function() {
      resolve(server);
    });
  });
}

function getPort(server) {
  return server.address().port;
}

function startMcpServer(apiPort) {
  return new Promise(function(resolve, reject) {
    var proc = spawn('node', ['src/mcp/mcp-server-http.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        MCP_PORT: '0',
        API_BASE_URL: 'http://localhost:' + apiPort
      })
    });
    var started = false;
    proc.stderr.on('data', function(d) {
      var msg = d.toString();
      var m = msg.match(/listening on port (\d+)/);
      if (m && !started) {
        started = true;
        resolve({ proc: proc, port: parseInt(m[1], 10) });
      }
    });
    proc.stderr.on('error', reject);
    setTimeout(function() {
      if (!started) { proc.kill(); reject(new Error('MCP server did not start')); }
    }, 5000);
  });
}

function mcpConnect(host, port) {
  return new Promise(function(resolve, reject) {
    var sseReq = http.get('http://' + host + ':' + port + '/sse', function(sseRes) {
      var buf = '';
      sseRes.on('data', function(chunk) {
        buf += chunk.toString();
        var m = buf.match(/sessionId=([a-f0-9-]+)/);
        if (m) {
          resolve({ sessionId: m[1], sseReq: sseReq, sseRes: sseRes });
        }
      });
      sseRes.on('error', reject);
    });
    sseReq.on('error', reject);
    setTimeout(function() { reject(new Error('SSE connect timeout')); }, 3000);
  });
}

function mcpPostMessage(host, port, sessionId, message) {
  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify(message);
    var opts = {
      hostname: host,
      port: port,
      path: '/message?sessionId=' + sessionId,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    var req = http.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        resolve({ status: res.statusCode, body: body });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function waitForSseResult(sseRes, done) {
  return new Promise(function(resolve) {
    var buf = '';
    var timer = setTimeout(function() { resolve(null); }, 3000);
    sseRes.on('data', function(chunk) {
      if (done) return;
      buf += chunk.toString();
      // Look for a result JSON-RPC response
      var lines = buf.split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('data: ') === 0) {
          try {
            var parsed = JSON.parse(lines[i].slice(6));
            if (parsed.result || parsed.error) {
              clearTimeout(timer);
              done = true;
              resolve(parsed);
              return;
            }
          } catch(e) {}
        }
      }
    });
  });
}

function cleanup(api, mcp, conn) {
  if (conn && conn.sseReq) try { conn.sseReq.destroy(); } catch(e) {}
  if (mcp && mcp.proc) try { mcp.proc.kill(); } catch(e) {}
  if (api) try { api.close(); } catch(e) {}
}

// ── Tests ───────────────────────────────────────────────────────────────

test('mcp: list_jobs returns empty array when no companies exist', async function(t) {
  var api, mcp, conn;
  try {
    api = await startMockApi(function(req, res) {
      if (req.url === '/api/companies' && req.method === 'GET')
        res.end(JSON.stringify({ companies: [], nextId: 1 }));
      else { res.statusCode = 404; res.end('{}'); }
    });
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_jobs', arguments: {} }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result, 'Should receive a result');
    assert.ok(result.result, 'Result should have .result');
    var content = result.result.content;
    assert.ok(content && content[0].type === 'text');
    var jobs = JSON.parse(content[0].text);
    assert.equal(jobs.length, 0);
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: list_jobs returns companies from API', async function(t) {
  var api, mcp, conn;
  try {
    var fakeData1 = JSON.stringify({url:'https://acme.com/jobs',source:'LinkedIn',added:'2026-05-24',activity:[{date:'24 May',text:'Added'}],score:null});
    var fakeData2 = JSON.stringify({url:'',source:'Seek',added:'2026-05-23',activity:[],score:null});
    var fakeCompanies = [
      { id:1, company:'Acme', role:'Engineer', stage:'target', tier:'A', data:fakeData1, culture_rating:null, culture_notes:null, updated_at:'2026-05-24' },
      { id:2, company:'Globex', role:'Manager', stage:'warm', tier:'B', data:fakeData2, culture_rating:null, culture_notes:null, updated_at:'2026-05-23' }
    ];
    api = await startMockApi(function(req, res) {
      if (req.url === '/api/companies' && req.method === 'GET')
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 3 }));
      else { res.statusCode = 404; res.end('{}'); }
    });
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_jobs', arguments: {} }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result);
    var content = result.result.content;
    var jobs = JSON.parse(content[0].text);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].company, 'Acme');
    assert.equal(jobs[0].role, 'Engineer');
    assert.equal(jobs[0].stage, 'target');
    assert.equal(jobs[0].url, 'https://acme.com/jobs');
    assert.equal(jobs[0].source, 'LinkedIn');
    assert.equal(jobs[1].company, 'Globex');
    assert.equal(jobs[1].stage, 'warm');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: add_job creates company and returns result', async function(t) {
  var api, mcp, conn;
  var savedPayload = null;
  try {
    api = await startMockApi(function(req, res) {
      if (req.url === '/api/companies' && req.method === 'GET')
        res.end(JSON.stringify({ companies: [], nextId: 5 }));
      else if (req.url === '/api/save' && req.method === 'POST') {
        var body = '';
        req.on('data', function(c) { body += c; });
        req.on('end', function() { savedPayload = JSON.parse(body); res.end(JSON.stringify({ success: true })); });
      } else if (req.url === '/api/kv' && req.method === 'POST')
        res.end(JSON.stringify({ success: true }));
      else { res.statusCode = 404; res.end('{}'); }
    });
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'add_job', arguments: { company:'TestCo', role:'Engineering Manager', url:'https://testco.com/jobs/em', source:'LinkedIn', notes:'Great fit', tier:'A' } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result);
    var content = result.result.content;
    var addResult = JSON.parse(content[0].text);
    assert.equal(addResult.id, 5);
    assert.equal(addResult.company, 'TestCo');
    assert.equal(addResult.role, 'Engineering Manager');
    assert.equal(addResult.stage, 'target');
    assert.ok(savedPayload);
    assert.equal(savedPayload.id, 5);
    assert.equal(savedPayload.company, 'TestCo');
    assert.equal(savedPayload.role, 'Engineering Manager');
    assert.equal(savedPayload.tier, 'A');
    assert.equal(savedPayload.stage, 'target');
    assert.equal(savedPayload.url, 'https://testco.com/jobs/em');
    assert.equal(savedPayload.source, 'LinkedIn');
    assert.equal(savedPayload.notes, 'Great fit');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: add_job errors on missing required fields', async function(t) {
  var api, mcp, conn;
  try {
    api = await startMockApi(function(req, res) {
      res.end(JSON.stringify({ companies: [], nextId: 1 }));
    });
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'add_job', arguments: { url:'https://example.com' } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result);
    assert.ok(result.result && result.result.isError, 'Should return an error');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: tools/list returns tool definitions', async function(t) {
  var api, mcp, conn;
  try {
    api = await startMockApi(function(req, res) {
      res.end(JSON.stringify({ companies: [], nextId: 1 }));
    });
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/list'
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result);
    var tools = result.result.tools;
    assert.ok(tools, 'Should have tools array');
    var names = tools.map(function(t) { return t.name; });
    assert.ok(names.indexOf('list_jobs') !== -1);
    assert.ok(names.indexOf('add_job') !== -1);
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: add_job defaults optional fields', async function(t) {
  var api, mcp, conn;
  var savedPayload = null;
  try {
    api = await startMockApi(function(req, res) {
      if (req.url === '/api/companies' && req.method === 'GET')
        res.end(JSON.stringify({ companies: [], nextId: 10 }));
      else if (req.url === '/api/save' && req.method === 'POST') {
        var body = '';
        req.on('data', function(c) { body += c; });
        req.on('end', function() { savedPayload = JSON.parse(body); res.end(JSON.stringify({ success: true })); });
      } else if (req.url === '/api/kv' && req.method === 'POST')
        res.end(JSON.stringify({ success: true }));
      else { res.statusCode = 404; res.end('{}'); }
    });
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'add_job', arguments: { company:'MinimalCo', role:'Dev' } }
    });
    assert.equal(postRes.status, 202);
    await waitForSseResult(conn.sseRes);
    assert.ok(savedPayload);
    assert.equal(savedPayload.tier, 'B');
    assert.equal(savedPayload.url, '');
    assert.equal(savedPayload.source, '');
    assert.equal(savedPayload.notes, '');
    assert.equal(savedPayload.stage, 'target');
  } finally {
    cleanup(api, mcp, conn);
  }
});
