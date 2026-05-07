var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');

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

http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/proxy/tavily' && req.method === 'POST') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      var parsed;
      try { parsed = JSON.parse(body); } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      var apiKey = parsed.apiKey;
      var payload = JSON.stringify({ urls: parsed.urls, extract_depth: parsed.extract_depth || 'advanced' });

      var options = {
        hostname: 'api.tavily.com',
        path: '/extract',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
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

  var filePath = req.url === '/' ? '/pipeline.html' : req.url;
  // Strip query string
  filePath = filePath.split('?')[0];
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
  console.log('Serving on http://localhost:' + PORT);
});
