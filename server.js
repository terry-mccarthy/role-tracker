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
var TAVILY_KEY     = process.env.TAVILY_API_KEY     || '';
var ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || '';

var MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown'
};

var PORT = 3000;
var LOG_FILE = path.join(__dirname, 'pipeline.log');
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

// ── HTTP SERVER ──────────────────────────────────────────────────────────

http.createServer(function(req, res) {
  logToFile(req.method + ' ' + req.url);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── PROXY: Tavily Extract ─────────────────────────────────────────────

  if (req.url === '/proxy/tavily' && req.method === 'POST') {
    if (!TAVILY_KEY) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'TAVILY_API_KEY not configured on server. Add it to your .env file.' }));
      return;
    }
    readBody(req, res, function(body) {
      var parsed = parseBody(body, res);
      if (!parsed) return;

      var payload = JSON.stringify({ urls: parsed.urls, extract_depth: parsed.extract_depth || 'advanced' });
      var options = {
        hostname: 'api.tavily.com',
        path: '/extract',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + TAVILY_KEY,
          'Content-Length': Buffer.byteLength(payload)
        }
      };

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
    });
    return;
  }

  // ── PROXY: Tavily Search ──────────────────────────────────────────────

  if (req.url === '/proxy/tavily-search' && req.method === 'POST') {
    if (!TAVILY_KEY) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'TAVILY_API_KEY not configured on server. Add it to your .env file.' }));
      return;
    }
    readBody(req, res, function(body) {
      var parsed = parseBody(body, res);
      if (!parsed) return;

      var payload = JSON.stringify({ query: parsed.query, search_depth: 'basic', max_results: 5, include_images: false });
      var options = {
        hostname: 'api.tavily.com',
        path: '/search',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + TAVILY_KEY,
          'Content-Length': Buffer.byteLength(payload)
        }
      };

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
    });
    return;
  }

  // ── PROXY: Anthropic (Claude) ─────────────────────────────────────────

  if (req.url === '/proxy/anthropic' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on server. Add it to your .env file.' }));
      return;
    }
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
      proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  // ── PROXY: Ollama (local LLM) ─────────────────────────────────────────

  if (req.url.startsWith('/proxy/ollama')) {
    var ollamaPath = req.url.replace('/proxy/ollama', '');
    if (!ollamaPath) ollamaPath = '/';

    var options = {
      hostname: 'localhost',
      port: 11434,
      path: ollamaPath,
      method: req.method,
      headers: req.headers
    };

    // Remove headers that might cause CORS or host issues
    delete options.headers['host'];
    delete options.headers['origin'];
    delete options.headers['referer'];

    var proxyReq = http.request(options, function(proxyRes) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', function(err) {
      logToFile('Ollama Proxy Error: ' + err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Ollama proxy error: ' + err.message }));
    });

    req.pipe(proxyReq);
    return;
  }

  // ── DATABASE API ──────────────────────────────────────────────────────
  
  if (req.url === '/api/companies' && req.method === 'GET') {
    var companies = db.getAllCompanies();
    var nextId = db.getKV('nextId') || '1';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ companies: companies, nextId: parseInt(nextId, 10) }));
    return;
  }

  if (req.url === '/api/save' && req.method === 'POST') {
    readBody(req, res, function(body) {
      try {
        var company = JSON.parse(body);
        db.saveCompany(company);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/delete' && req.method === 'POST') {
    readBody(req, res, function(body) {
      try {
        var parsed = JSON.parse(body);
        db.deleteCompany(parsed.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/reset' && req.method === 'POST') {
    try {
      db.resetAll();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/api/migrate' && req.method === 'POST') {
    readBody(req, res, function(body) {
      logToFile('[Server] /api/migrate received data');
      try {
        var parsed = JSON.parse(body);
        db.migrateCompanies(parsed.companies, parsed.nextId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/save-score' && req.method === 'POST') {
    readBody(req, res, function(body) {
      try {
        var parsed = JSON.parse(body);
        logToFile('[Server] /api/save-score - id: ' + parsed.id + ' score: ' + (parsed.score ? 'present' : 'null'));
        db.saveScore(parsed.id, parsed.score);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/kv' && req.method === 'POST') {
    readBody(req, res, function(body) {
      try {
        var parsed = JSON.parse(body);
        db.setKV(parsed.key, parsed.value);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/log' && req.method === 'POST') {
    readBody(req, res, function(body) {
      try {
        var parsed = JSON.parse(body);
        logToFile('[Frontend] ' + (parsed.level || 'INFO') + ': ' + parsed.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── STATIC FILE SERVING ───────────────────────────────────────────────

  var filePath = req.url === '/' ? '/pipeline.html' : req.url;
  // Strip query string
  filePath = filePath.split('?')[0];
  
  // Auto-append .html if there is no extension
  if (!path.extname(filePath)) {
    filePath += '.html';
  }
  
  var full = path.join(__dirname, 'src', filePath);

  fs.readFile(full, function(err, data) {
    if (err) {
      // Try serving from root (for config/, etc.)
      var rootFull = path.join(__dirname, filePath);
      fs.readFile(rootFull, function(err2, data2) {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        var ext = path.extname(rootFull);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data2);
      });
      return;
    }
    var ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, function() {
  if (!TAVILY_KEY)    logToFile('WARNING: TAVILY_API_KEY not set — URL fetching and culture research will be disabled.');
  if (!ANTHROPIC_KEY) logToFile('WARNING: ANTHROPIC_API_KEY not set — Anthropic provider will be disabled (Ollama still works).');
  logToFile('Serving on http://localhost:' + PORT);
});
