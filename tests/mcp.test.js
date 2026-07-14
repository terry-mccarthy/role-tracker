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

function parseDataLine(line) {
  if (line.indexOf('data: ') !== 0) return null;
  try {
    var parsed = JSON.parse(line.slice(6));
    if (parsed.result || parsed.error) return parsed;
  } catch(e) {}
  return null;
}

function waitForSseResult(sseRes, done) {
  return new Promise(function(resolve) {
    var buf = '';
    var timer = setTimeout(function() { resolve(null); }, 3000);
    sseRes.on('data', function(chunk) {
      if (done) return;
      buf += chunk.toString();
      var lines = buf.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var match = parseDataLine(lines[i]);
        if (match) { clearTimeout(timer); done = true; resolve(match); return; }
      }
    });
  });
}

function safeCleanup(obj, method) {
  if (!obj) return;
  try { obj[method](); } catch(e) {}
}

function cleanup(api, mcp, conn) {
  safeCleanup(conn && conn.sseReq, 'destroy');
  safeCleanup(mcp && mcp.proc, 'kill');
  safeCleanup(api, 'close');
}

function readBody(req, cb) {
  var body = '';
  req.on('data', function(c) { body += c; });
  req.on('end', function() { cb(JSON.parse(body)); });
}

function mockRoute(routes) {
  return function(req, res) {
    var key = req.method + ' ' + req.url;
    var fn = routes[key];
    if (fn) { fn(req, res); return; }
    res.statusCode = 404; res.end('{}');
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

test('mcp: list_jobs returns empty array when no companies exist', async function(t) {
  var api, mcp, conn;
  try {
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: [], nextId: 1 }));
      }
    }));
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
      { id:1, company:'Acme', role:'Engineer', stage:'closed', tier:'A', data:fakeData1, culture_rating:null, culture_notes:null, furthest_stage:'interview', updated_at:'2026-05-24' },
      { id:2, company:'Globex', role:'Manager', stage:'warm', tier:'B', data:fakeData2, culture_rating:null, culture_notes:null, furthest_stage:null, updated_at:'2026-05-23' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 3 }));
      }
    }));
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
    assert.equal(jobs[0].id, 1);
    assert.equal(jobs[0].company, 'Acme');
    assert.equal(jobs[0].role, 'Engineer');
    assert.equal(jobs[0].stage, 'closed');
    assert.equal(jobs[0].tier, 'A');
    assert.equal(jobs[0].url, 'https://acme.com/jobs');
    assert.equal(jobs[0].added, '2026-05-24');
    assert.equal(jobs[0].furthest_stage, 'interview');
    // slim response must NOT include heavy fields
    assert.equal(jobs[0].score, undefined);
    assert.equal(jobs[0].activity, undefined);
    assert.equal(jobs[0].culture_notes, undefined);
    assert.equal(jobs[0].source, undefined);
    assert.equal(jobs[1].company, 'Globex');
    assert.equal(jobs[1].stage, 'warm');
    assert.equal(jobs[1].furthest_stage, null);
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: add_job creates company and returns result', async function(t) {
  var api, mcp, conn;
  var savedPayload = null;
  try {
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: [], nextId: 5 }));
      },
      'POST /api/save': function(req, res) {
        readBody(req, function(body) { savedPayload = body; res.end(JSON.stringify({ success: true })); });
      },
      'POST /api/kv': function(req, res) {
        res.end(JSON.stringify({ success: true }));
      }
    }));
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
    assert.equal(savedPayload.furthest_stage, 'target');
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
    assert.ok(names.indexOf('get_job_details') !== -1);
    assert.ok(names.indexOf('edit_job') !== -1);
    assert.ok(names.indexOf('fetch_jd') !== -1);
    assert.ok(names.indexOf('score_job') !== -1);
    assert.ok(names.indexOf('export_pipeline') !== -1);
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: edit_job updates url field', async function(t) {
  var api, mcp, conn;
  var savedPayload = null;
  try {
    var fakeData = JSON.stringify({ url: 'https://old.com/jobs', added: '2026-06-01', activity: [] });
    var fakeCompanies = [
      { id: 3, company: 'TestCo', role: 'EM', stage: 'target', tier: 'B',
        data: fakeData, culture_rating: null, culture_notes: null, updated_at: '2026-06-01' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 4 }));
      },
      'POST /api/save': function(req, res) {
        readBody(req, function(body) { savedPayload = body; res.end(JSON.stringify({ success: true })); });
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'edit_job', arguments: { id: 3, url: 'https://new.com/jobs' } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result, 'Should receive a result');
    assert.ok(!result.result.isError, 'Should not error');
    assert.ok(savedPayload, 'Should call /api/save');
    assert.equal(savedPayload.url, 'https://new.com/jobs');
    assert.equal(savedPayload.id, 3);
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: edit_job updates stage field', async function(t) {
  var api, mcp, conn;
  var savedPayload = null;
  try {
    var fakeData = JSON.stringify({ url: 'https://old.com/jobs', added: '2026-06-01', activity: [] });
    var fakeCompanies = [
      { id: 4, company: 'StageCo', role: 'EM', stage: 'target', tier: 'B',
        data: fakeData, culture_rating: null, culture_notes: null, updated_at: '2026-06-01' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 5 }));
      },
      'POST /api/save': function(req, res) {
        readBody(req, function(body) { savedPayload = body; res.end(JSON.stringify({ success: true })); });
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'edit_job', arguments: { id: 4, stage: 'interview' } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result, 'Should receive a result');
    assert.ok(!result.result.isError, 'Should not error');
    assert.ok(savedPayload, 'Should call /api/save');
    assert.equal(savedPayload.stage, 'interview');
    assert.equal(savedPayload.id, 4);
    assert.equal(savedPayload.furthest_stage, 'interview', 'furthest_stage should live-update as stage advances');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: edit_job does not regress furthest_stage when stage moves backward', async function(t) {
  var api, mcp, conn;
  var savedPayload = null;
  try {
    var fakeData = JSON.stringify({ url: 'https://old.com/jobs', added: '2026-06-01', activity: [] });
    var fakeCompanies = [
      { id: 12, company: 'RegressCo', role: 'EM', stage: 'interview', tier: 'B',
        data: fakeData, culture_rating: null, culture_notes: null, furthest_stage: 'interview', updated_at: '2026-06-01' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 13 }));
      },
      'POST /api/save': function(req, res) {
        readBody(req, function(body) { savedPayload = body; res.end(JSON.stringify({ success: true })); });
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'edit_job', arguments: { id: 12, stage: 'screen' } }
    });
    assert.equal(postRes.status, 202);
    await waitForSseResult(conn.sseRes);
    assert.ok(savedPayload, 'Should call /api/save');
    assert.equal(savedPayload.stage, 'screen');
    assert.equal(savedPayload.furthest_stage, 'interview', 'furthest_stage should not regress when stage is corrected backward');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: edit_job errors on unknown id', async function(t) {
  var api, mcp, conn;
  try {
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: [], nextId: 1 }));
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'edit_job', arguments: { id: 999, url: 'https://example.com' } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result);
    assert.ok(result.result.isError, 'Should return an error for unknown id');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: fetch_jd fetches from url and saves jd', async function(t) {
  var api, mcp, conn;
  var savedPayload = null;
  try {
    var fakeData = JSON.stringify({ url: 'https://example.com/job', added: '2026-06-01', activity: [], jd: '' });
    var fakeCompanies = [
      { id: 5, company: 'FetchCo', role: 'Dev', stage: 'target', tier: 'B',
        data: fakeData, culture_rating: null, culture_notes: null, updated_at: '2026-06-01' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 6 }));
      },
      'POST /proxy/jina-reader': function(req, res) {
        readBody(req, function() {
          res.setHeader('Content-Type', 'text/plain');
          res.end('Engineering Manager role. Lead a team of 20 engineers. Remote-friendly.');
        });
      },
      'POST /api/save': function(req, res) {
        readBody(req, function(body) { savedPayload = body; res.end(JSON.stringify({ success: true })); });
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'fetch_jd', arguments: { id: 5 } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result, 'Should receive a result');
    assert.ok(!result.result.isError, 'Should not error');
    var content = JSON.parse(result.result.content[0].text);
    assert.equal(content.id, 5);
    assert.ok(content.jd_length > 0, 'Should report JD length');
    assert.ok(savedPayload, 'Should call /api/save');
    assert.ok(savedPayload.jd && savedPayload.jd.length > 0, 'Saved job should have JD');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: fetch_jd errors when no url set', async function(t) {
  var api, mcp, conn;
  try {
    var fakeData = JSON.stringify({ url: '', added: '2026-06-01', activity: [] });
    var fakeCompanies = [
      { id: 6, company: 'NoUrlCo', role: 'Dev', stage: 'target', tier: 'B',
        data: fakeData, culture_rating: null, culture_notes: null, updated_at: '2026-06-01' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 7 }));
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'fetch_jd', arguments: { id: 6 } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result);
    assert.ok(result.result.isError, 'Should return an error when no URL set');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: score_job scores and saves result', async function(t) {
  var api, mcp, conn;
  var scoredPayload = null;
  try {
    var fakeJd = 'Engineering Manager at TechCorp. Lead 20 engineers. Fully remote. AUD 300k.';
    var fakeProfile = '# Eval Profile\n## Scoring weights\n| Dimension | Weight |\n|---|---|\n| Lifestyle | 25% |';
    var fakeData = JSON.stringify({ url: 'https://techcorp.com/em', added: '2026-06-01', activity: [], jd: fakeJd });
    var fakeCompanies = [
      { id: 7, company: 'TechCorp', role: 'EM', stage: 'target', tier: 'B',
        data: fakeData, culture_rating: null, culture_notes: null, updated_at: '2026-06-01' }
    ];
    var fakeScoreJson = JSON.stringify({
      overall_score: 8, overall_verdict: 'Strong fit',
      hard_nos_pass: true, hard_nos_detail: 'None triggered',
      dimensions: [{ name: 'Lifestyle', weight: '25%', score: 8, detail: 'Good balance' }],
      tensions: [], discovery_items: [], extraction: {}
    });
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 8 }));
      },
      'GET /config/evaluation-profile.md': function(req, res) {
        res.setHeader('Content-Type', 'text/markdown');
        res.end(fakeProfile);
      },
      'POST /proxy/anthropic': function(req, res) {
        readBody(req, function() {
          res.end(JSON.stringify({ content: [{ type: 'text', text: fakeScoreJson }] }));
        });
      },
      'POST /api/save-score': function(req, res) {
        readBody(req, function(body) { scoredPayload = body; res.end(JSON.stringify({ success: true })); });
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'score_job', arguments: { id: 7 } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result, 'Should receive a result');
    assert.ok(!result.result.isError, 'Should not error: ' + JSON.stringify(result.result));
    var content = JSON.parse(result.result.content[0].text);
    assert.equal(content.id, 7);
    assert.equal(content.overall_score, 8);
    assert.ok(scoredPayload, 'Should call /api/save-score');
    assert.equal(scoredPayload.id, 7);
    assert.ok(scoredPayload.score, 'Payload should include score');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: score_job errors when no jd stored', async function(t) {
  var api, mcp, conn;
  try {
    var fakeData = JSON.stringify({ url: 'https://techcorp.com/em', added: '2026-06-01', activity: [], jd: '' });
    var fakeCompanies = [
      { id: 8, company: 'TechCorp', role: 'EM', stage: 'target', tier: 'B',
        data: fakeData, culture_rating: null, culture_notes: null, updated_at: '2026-06-01' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 9 }));
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'score_job', arguments: { id: 8 } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result);
    assert.ok(result.result.isError, 'Should return an error when no JD stored');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: add_job defaults optional fields', async function(t) {
  var api, mcp, conn;
  var savedPayload = null;
  try {
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: [], nextId: 10 }));
      },
      'POST /api/save': function(req, res) {
        readBody(req, function(body) { savedPayload = body; res.end(JSON.stringify({ success: true })); });
      },
      'POST /api/kv': function(req, res) {
        res.end(JSON.stringify({ success: true }));
      }
    }));
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

test('mcp: get_job_details returns full record for known id', async function(t) {
  var api, mcp, conn;
  try {
    var fakeData = JSON.stringify({
      url: 'https://acme.com/jobs',
      source: 'LinkedIn',
      notes: 'Great fit',
      added: '2026-05-24',
      score: 82,
      activity: [{ date: '24 May', text: 'Added' }]
    });
    var fakeCompanies = [
      { id: 7, company: 'Acme', role: 'Engineer', stage: 'target', tier: 'A',
        data: fakeData, culture_rating: 4, culture_notes: 'Good vibes', updated_at: '2026-05-24' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 8 }));
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_job_details', arguments: { id: 7 } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result);
    assert.ok(result.result, 'Should have result');
    var job = JSON.parse(result.result.content[0].text);
    assert.equal(job.id, 7);
    assert.equal(job.company, 'Acme');
    assert.equal(job.score, 82);
    assert.deepEqual(job.activity, [{ date: '24 May', text: 'Added' }]);
    assert.equal(job.culture_notes, 'Good vibes');
    assert.equal(job.source, 'LinkedIn');
    assert.equal(job.notes, 'Great fit');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: get_job_details includes furthest_stage', async function(t) {
  var api, mcp, conn;
  try {
    var fakeData = JSON.stringify({
      url: '', source: '', notes: '', added: '2026-05-24', score: null, activity: []
    });
    var fakeCompanies = [
      { id: 9, company: 'ClosedCo', role: 'EM', stage: 'closed', tier: 'B',
        data: fakeData, culture_rating: null, culture_notes: null, furthest_stage: 'interview', updated_at: '2026-05-24' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 10 }));
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_job_details', arguments: { id: 9 } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result);
    var job = JSON.parse(result.result.content[0].text);
    assert.equal(job.furthest_stage, 'interview');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: edit_job preserves furthest_stage on unrelated field edits', async function(t) {
  var api, mcp, conn;
  var savedPayload = null;
  try {
    var fakeData = JSON.stringify({ url: 'https://old.com/jobs', added: '2026-06-01', activity: [] });
    var fakeCompanies = [
      { id: 10, company: 'PreserveCo', role: 'EM', stage: 'closed', tier: 'B',
        data: fakeData, culture_rating: null, culture_notes: null, furthest_stage: 'offer', updated_at: '2026-06-01' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 11 }));
      },
      'POST /api/save': function(req, res) {
        readBody(req, function(body) { savedPayload = body; res.end(JSON.stringify({ success: true })); });
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'edit_job', arguments: { id: 10, contact: 'Jane Doe' } }
    });
    assert.equal(postRes.status, 202);
    await waitForSseResult(conn.sseRes);
    assert.ok(savedPayload, 'Should call /api/save');
    assert.equal(savedPayload.furthest_stage, 'offer', 'furthest_stage should survive an unrelated edit');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: fetch_jd preserves furthest_stage', async function(t) {
  var api, mcp, conn;
  var savedPayload = null;
  try {
    var fakeData = JSON.stringify({ url: 'https://example.com/job', added: '2026-06-01', activity: [], jd: '' });
    var fakeCompanies = [
      { id: 11, company: 'FetchPreserveCo', role: 'Dev', stage: 'closed', tier: 'B',
        data: fakeData, culture_rating: null, culture_notes: null, furthest_stage: 'screen', updated_at: '2026-06-01' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 12 }));
      },
      'POST /proxy/jina-reader': function(req, res) {
        readBody(req, function() {
          res.setHeader('Content-Type', 'text/plain');
          res.end('Some JD text.');
        });
      },
      'POST /api/save': function(req, res) {
        readBody(req, function(body) { savedPayload = body; res.end(JSON.stringify({ success: true })); });
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'fetch_jd', arguments: { id: 11 } }
    });
    assert.equal(postRes.status, 202);
    await waitForSseResult(conn.sseRes);
    assert.ok(savedPayload, 'Should call /api/save');
    assert.equal(savedPayload.furthest_stage, 'screen', 'furthest_stage should survive a fetch_jd save');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: get_job_details returns error for unknown id', async function(t) {
  var api, mcp, conn;
  try {
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: [], nextId: 1 }));
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_job_details', arguments: { id: 999 } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result);
    assert.ok(result.result && result.result.isError, 'Should return an error for unknown id');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: export_pipeline returns full job data with metadata', async function(t) {
  var api, mcp, conn;
  try {
    var fakeData1 = JSON.stringify({
      url: 'https://acme.com/jobs', source: 'LinkedIn', contact: 'Jane', notes: 'Great culture',
      added: '2026-06-01', score: { overall_score: 8, overall_verdict: 'Strong fit' },
      activity: [{ date: 'Jun 1', text: 'Added' }], jd: 'Long JD text here'
    });
    var fakeData2 = JSON.stringify({
      url: '', source: 'Seek', contact: '', notes: '',
      added: '2026-06-02', score: null, activity: [], jd: ''
    });
    var fakeCompanies = [
      { id: 1, company: 'Acme', role: 'EM', stage: 'interview', tier: 'A',
        data: fakeData1, culture_rating: 4, culture_notes: 'Good vibes', furthest_stage: 'screen', updated_at: '2026-06-10' },
      { id: 2, company: 'Globex', role: 'Manager', stage: 'target', tier: 'B',
        data: fakeData2, culture_rating: null, culture_notes: null, furthest_stage: null, updated_at: '2026-06-02' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 3 }));
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'export_pipeline', arguments: {} }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result, 'Should receive a result');
    assert.ok(!result.result.isError, 'Should not error');
    var data = JSON.parse(result.result.content[0].text);
    assert.equal(data.total, 2);
    assert.ok(data.exported_at, 'Should include export date');
    assert.deepEqual(data.by_stage, { interview: 1, target: 1 });
    assert.deepEqual(data.by_tier, { A: 1, B: 1 });
    assert.equal(data.jobs.length, 2);
    // full fields present
    var job1 = data.jobs[0];
    assert.equal(job1.id, 1);
    assert.equal(job1.company, 'Acme');
    assert.equal(job1.source, 'LinkedIn');
    assert.equal(job1.contact, 'Jane');
    assert.equal(job1.notes, 'Great culture');
    assert.equal(job1.culture_rating, 4);
    assert.equal(job1.culture_notes, 'Good vibes');
    assert.equal(job1.furthest_stage, 'screen');
    assert.ok(job1.score, 'Should include score object');
    assert.equal(job1.score.overall_score, 8);
    assert.ok(Array.isArray(job1.activity), 'Should include activity array');
    // jd excluded by default
    assert.equal(job1.jd, undefined, 'JD should be excluded by default');
    assert.equal(data.evaluation_profile, undefined, 'Profile should be excluded by default');
  } finally {
    cleanup(api, mcp, conn);
  }
});

test('mcp: export_pipeline includes jd and profile when requested', async function(t) {
  var api, mcp, conn;
  try {
    var fakeData = JSON.stringify({
      url: 'https://acme.com/jobs', source: 'LinkedIn', contact: '', notes: '',
      added: '2026-06-01', score: null, activity: [], jd: 'Full JD text for analysis'
    });
    var fakeCompanies = [
      { id: 1, company: 'Acme', role: 'EM', stage: 'target', tier: 'A',
        data: fakeData, culture_rating: null, culture_notes: null, updated_at: '2026-06-01' }
    ];
    api = await startMockApi(mockRoute({
      'GET /api/companies': function(req, res) {
        res.end(JSON.stringify({ companies: fakeCompanies, nextId: 2 }));
      },
      'GET /config/evaluation-profile.md': function(req, res) {
        res.setHeader('Content-Type', 'text/markdown');
        res.end('# Evaluation Profile\n## Scoring weights\n| Dim | 100% |');
      }
    }));
    mcp = await startMcpServer(getPort(api));
    conn = await mcpConnect('localhost', mcp.port);
    var postRes = await mcpPostMessage('localhost', mcp.port, conn.sessionId, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'export_pipeline', arguments: { include_jd: true, include_profile: true } }
    });
    assert.equal(postRes.status, 202);
    var result = await waitForSseResult(conn.sseRes);
    assert.ok(result, 'Should receive a result');
    assert.ok(!result.result.isError, 'Should not error');
    var data = JSON.parse(result.result.content[0].text);
    assert.equal(data.jobs[0].jd, 'Full JD text for analysis');
    assert.ok(data.evaluation_profile, 'Should include evaluation profile');
    assert.ok(data.evaluation_profile.indexOf('Scoring weights') !== -1);
  } finally {
    cleanup(api, mcp, conn);
  }
});
