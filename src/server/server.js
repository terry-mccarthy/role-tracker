var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var db = require('./database');

// ── CONFIGURATION ────────────────────────────────────────────────────────
// API keys are read from environment variables — never from the browser client.
// Set these in your .env file (already gitignored) or export them in your shell:
//   TAVILY_API_KEY=tvly-...
//   ANTHROPIC_API_KEY=sk-ant-...
//   OPENROUTER_API_KEY=sk-or-...
var TAVILY_KEY     = process.env.TAVILY_API_KEY     || '';
var ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || '';
var OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

// OLLAMA_HOST lets Docker Compose point the proxy at the ollama service.
// Defaults to localhost for native dev.
var _ollamaHostRaw = process.env.OLLAMA_HOST || 'http://localhost:11434';
if (_ollamaHostRaw.indexOf('://') === -1) { _ollamaHostRaw = 'http://' + _ollamaHostRaw; }
var _ollamaUrl     = new URL(_ollamaHostRaw);
var OLLAMA_HOSTNAME = _ollamaUrl.hostname;
var OLLAMA_PORT    = parseInt(_ollamaUrl.port, 10) || 11434;

var MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown'
};

var PORT = process.env.PORT !== undefined ? parseInt(process.env.PORT, 10) : 3000;
var LOG_FILE = path.join(__dirname, '../../pipeline.log');
var PROFILE_PATH = process.env.PROFILE_PATH || path.join(__dirname, '../../config/evaluation-profile.md');
var MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB request body limit

function logToFile(msg) {
  var timestamp = new Date().toISOString();
  var line = '[' + timestamp + '] ' + msg + '\n';
  fs.appendFileSync(LOG_FILE, line);
  console.log(line.trim());
}

logToFile('--- Server Starting ---');

// ── HELPERS ──────────────────────────────────────────────────────────────

/** Accumulate the request body, enforcing a max size limit. */
function readBody(req, res, cb) {
  var body = '';
  req.on('data', function(chunk) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      res.writeHead(413);
      res.end(JSON.stringify({ error: 'Request body too large' }));
      req.destroy();
    }
  });
  req.on('end', function() { cb(body); });
}

/** Parse JSON body, sending a 400 response and returning null on failure. */
function parseBody(body, res) {
  try {
    return JSON.parse(body);
  } catch(e) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return null;
  }
}

/** Respond 503 when a required API key is not configured. */
function sendMissingKey(res, keyName) {
  res.writeHead(503);
  res.end(JSON.stringify({ error: keyName + ' not configured on server. Add it to your .env file.' }));
}

/** Extract the `model` field from a JSON body, or 'unknown' on failure. */
function extractModel(body) {
  try {
    var parsed = JSON.parse(body);
    if (parsed.model) return parsed.model;
  } catch(e) {}
  return 'unknown';
}

/** Forward an HTTPS request and buffer the full JSON response back to the client. */
function bufferJsonProxy(res, options, payload) {
  var proxyReq = https.request(options, function(proxyRes) {
    var data = '';
    proxyRes.on('data', function(chunk) { data += chunk; });
    proxyRes.on('end', function() {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });
  proxyReq.on('error', function(err) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });
  proxyReq.write(payload);
  proxyReq.end();
}

// ── PROXY HANDLERS ─────────────────────────────────────────────────────────
// Each handler returns true if it consumed the request, false to pass through.

function tavilyOptions(apiPath, payload) {
  return {
    hostname: 'api.tavily.com',
    path: apiPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + TAVILY_KEY,
      'Content-Length': Buffer.byteLength(payload)
    }
  };
}

function handleTavilyExtract(req, res) {
  if (!(req.url === '/proxy/tavily' && req.method === 'POST')) return false;
  if (!TAVILY_KEY) { sendMissingKey(res, 'TAVILY_API_KEY'); return true; }
  readBody(req, res, function(body) {
    var parsed = parseBody(body, res);
    if (!parsed) return;
    var payload = JSON.stringify({ urls: parsed.urls, extract_depth: parsed.extract_depth || 'advanced' });
    bufferJsonProxy(res, tavilyOptions('/extract', payload), payload);
  });
  return true;
}

function handleTavilySearch(req, res) {
  if (!(req.url === '/proxy/tavily-search' && req.method === 'POST')) return false;
  if (!TAVILY_KEY) { sendMissingKey(res, 'TAVILY_API_KEY'); return true; }
  readBody(req, res, function(body) {
    var parsed = parseBody(body, res);
    if (!parsed) return;
    var payload = JSON.stringify({ query: parsed.query, search_depth: 'basic', max_results: 5, include_images: false });
    bufferJsonProxy(res, tavilyOptions('/search', payload), payload);
  });
  return true;
}

function handleJinaReader(req, res) {
  if (!(req.url === '/proxy/jina-reader' && req.method === 'POST')) return false;
  readBody(req, res, function(body) {
    var parsed = parseBody(body, res);
    if (!parsed) return;
    if (!parsed.url) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'url is required' }));
      return;
    }
    var targetUrl = 'https://r.jina.ai/' + encodeURIComponent(parsed.url);
    https.get(targetUrl, function(proxyRes) {
      var data = '';
      proxyRes.on('data', function(chunk) { data += chunk; });
      proxyRes.on('end', function() {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(data);
      });
    }).on('error', function(err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
    });
  });
  return true;
}

function handleAnthropic(req, res) {
  if (!(req.url === '/proxy/anthropic' && req.method === 'POST')) return false;
  if (!ANTHROPIC_KEY) { sendMissingKey(res, 'ANTHROPIC_API_KEY'); return true; }
  readBody(req, res, function(body) {
    // Forward the request body as-is; only the auth header is added server-side
    var options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    bufferJsonProxy(res, options, body);
  });
  return true;
}

function handleOpenRouter(req, res) {
  if (!(req.url === '/proxy/openrouter' && req.method === 'POST')) return false;
  if (!OPENROUTER_KEY) { sendMissingKey(res, 'OPENROUTER_API_KEY'); return true; }
  readBody(req, res, function(body) {
    logToFile('OpenRouter proxy -> model=' + extractModel(body) + ' (' + body.length + ' bytes)');
    var options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENROUTER_KEY,
        'HTTP-Referer': 'http://localhost:' + PORT,
        'X-Title': 'job-pipeline',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    var proxyReq = https.request(options, function(proxyRes) {
      logToFile('OpenRouter proxy <- status=' + proxyRes.statusCode);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', function(err) {
      logToFile('OpenRouter Proxy Error: ' + err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'OpenRouter proxy error: ' + err.message }));
    });
    proxyReq.write(body);
    proxyReq.end();
  });
  return true;
}

function handleOllama(req, res) {
  if (!req.url.startsWith('/proxy/ollama')) return false;
  var ollamaPath = req.url.replace('/proxy/ollama', '') || '/';
  // Accumulate body first, then proxy once fully received
  var reqBody = '';
  req.on('data', function(chunk) { reqBody += chunk.toString(); });
  req.on('end', function() {
    logToFile('Ollama proxy -> ' + ollamaPath + ' model=' + extractModel(reqBody) + ' (' + reqBody.length + ' bytes)');
    var options = {
      hostname: OLLAMA_HOSTNAME,
      port: OLLAMA_PORT,
      path: ollamaPath,
      method: req.method,
      headers: req.headers
    };
    delete options.headers['host'];
    delete options.headers['origin'];
    delete options.headers['referer'];

    var proxyReq = http.request(options, function(proxyRes) {
      logToFile('Ollama proxy <- ' + ollamaPath + ' status=' + proxyRes.statusCode);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', function(err) {
      logToFile('Ollama Proxy Error: ' + err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Ollama proxy error: ' + err.message }));
    });
    proxyReq.end(reqBody);
  });
  return true;
}

// ── DATABASE API HANDLERS ────────────────────────────────────────────────

/** Read the body, JSON-parse it, run `mutate`, and reply success/400. */
function dbWrite(req, res, mutate) {
  readBody(req, res, function(body) {
    try {
      var parsed = JSON.parse(body);
      mutate(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// POST routes that mutate the DB and return { success: true }.
var API_WRITE_ROUTES = {
  '/api/save':       function(p) { db.saveCompany(p); },
  '/api/delete':     function(p) { db.deleteCompany(p.id); },
  '/api/migrate':    function(p) { logToFile('[Server] /api/migrate received data'); db.migrateCompanies(p.companies, p.nextId); },
  '/api/save-score': function(p) { logToFile('[Server] /api/save-score - id: ' + p.id + ' score: ' + (p.score ? 'present' : 'null')); db.saveScore(p.id, p.score); },
  '/api/kv':         function(p) { db.setKV(p.key, p.value); },
  '/api/log':        function(p) { logToFile('[Frontend] ' + (p.level || 'INFO') + ': ' + p.message); }
};

function handleApiCompanies(req, res) {
  if (!(req.url === '/api/companies' && req.method === 'GET')) return false;
  var nextId = db.getKV('nextId') || '1';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ companies: db.getAllCompanies(), nextId: parseInt(nextId, 10) }));
  return true;
}

function handleApiReset(req, res) {
  if (!(req.url === '/api/reset' && req.method === 'POST')) return false;
  try {
    db.resetAll();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
  return true;
}

function handleApiProfile(req, res) {
  if (req.url !== '/api/profile') return false;
  if (req.method === 'GET') {
    fs.readFile(PROFILE_PATH, 'utf8', function(err, data) {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not read profile: ' + err.message }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: data }));
    });
    return true;
  }
  if (req.method === 'POST') {
    readBody(req, res, function(rawBody) {
      var body = parseBody(rawBody, res);
      if (!body) return;
      var content = body.content;
      if (!content || !content.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'content is required' }));
        return;
      }
      fs.writeFile(PROFILE_PATH, content, 'utf8', function(err) {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not write profile: ' + err.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    });
    return true;
  }
  return false;
}

function handleApiWrite(req, res) {
  if (req.method !== 'POST') return false;
  var mutate = API_WRITE_ROUTES[req.url];
  if (!mutate) return false;
  dbWrite(req, res, mutate);
  return true;
}

// ── STATIC FILE SERVING ────────────────────────────────────────────────────

function serveStatic(req, res) {
  var filePath = req.url === '/' ? '/pipeline.html' : req.url;
  // Strip query string
  filePath = filePath.split('?')[0];
  // Browsers request /favicon.ico by default; redirect to our PNG icon
  if (filePath === '/favicon.ico') filePath = '/assets/jobsearch-icon.png';
  // Auto-append .html if there is no extension
  if (!path.extname(filePath)) filePath += '.html';

  var full = path.join(__dirname, '..', filePath);
  fs.readFile(full, function(err, data) {
    if (err) {
      // Try serving from root (for config/, etc.)
      var rootFull = path.join(__dirname, '../..', filePath);
      fs.readFile(rootFull, function(err2, data2) {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(rootFull)] || 'application/octet-stream' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
  return true;
}

// ── HTTP SERVER ──────────────────────────────────────────────────────────

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Ordered list of request handlers; the first to return true owns the request.
var ROUTES = [
  handleTavilyExtract,
  handleTavilySearch,
  handleJinaReader,
  handleAnthropic,
  handleOpenRouter,
  handleOllama,
  handleApiCompanies,
  handleApiReset,
  handleApiProfile,
  handleApiWrite,
  serveStatic
];

http.createServer(function(req, res) {
  logToFile(req.method + ' ' + req.url);
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  for (var i = 0; i < ROUTES.length; i++) {
    if (ROUTES[i](req, res)) return;
  }
}).listen(PORT, function() {
  var actualPort = this.address().port;
  if (!TAVILY_KEY)    logToFile('WARNING: TAVILY_API_KEY not set — URL fetching and culture research will be disabled.');
  if (!ANTHROPIC_KEY) logToFile('WARNING: ANTHROPIC_API_KEY not set — Anthropic provider will be disabled (Ollama still works).');
  if (!OPENROUTER_KEY) logToFile('WARNING: OPENROUTER_API_KEY not set — OpenRouter provider will be disabled.');
  logToFile('Serving on http://localhost:' + actualPort);
});
