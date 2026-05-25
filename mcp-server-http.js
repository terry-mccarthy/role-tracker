#!/usr/bin/env node
var http = require('http');
var { Server } = require('@modelcontextprotocol/sdk/server/index.js');
var { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
var { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

var PORT = parseInt(process.env.MCP_PORT || '3100', 10);
// Point this at the web app's HTTP API (Docker internal DNS or localhost)
var API_BASE = process.env.API_BASE_URL || 'http://app:3000';

function apiUrl(path) {
  return API_BASE + path;
}

function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function todayLabel() {
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var d = new Date();
  return months[d.getMonth()] + ' ' + d.getDate();
}

function apiGet(path) {
  return new Promise(function(resolve, reject) {
    var urlObj = new URL(apiUrl(path));
    var opts = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };
    var req = http.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        if (res.statusCode !== 200) return reject(new Error('GET ' + path + ' returned ' + res.statusCode));
        resolve(JSON.parse(body));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function apiPost(path, data) {
  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify(data);
    var urlObj = new URL(apiUrl(path));
    var opts = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
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
        if (res.statusCode !== 200) return reject(new Error('POST ' + path + ' returned ' + res.statusCode));
        resolve(JSON.parse(body));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getAllJobs() {
  var result = await apiGet('/api/companies');
  return (result.companies || []).map(function(r) {
    var data = {};
    try { data = JSON.parse(r.data || '{}'); } catch(e) {}
    return {
      id: r.id,
      company: r.company,
      role: r.role,
      tier: r.tier,
      stage: r.stage,
      url: data.url || '',
      source: data.source || '',
      contact: data.contact || '',
      notes: data.notes || '',
      jd: data.jd || '',
      added: data.added || '',
      score: data.score || null,
      activity: data.activity || [],
      culture_rating: r.culture_rating,
      culture_notes: r.culture_notes,
      updated_at: r.updated_at
    };
  });
}

async function addJob(fields) {
  var result = await apiGet('/api/companies');
  var nextId = result.nextId || 1;
  var todayStr = todayISO();
  var todayLabelStr = todayLabel();

  var company = {
    id: nextId,
    company: fields.company,
    role: fields.role,
    tier: fields.tier || 'B',
    stage: 'target',
    url: fields.url || '',
    source: fields.source || '',
    contact: '',
    next: '',
    notes: fields.notes || '',
    linked_documents: '',
    jd: '',
    added: todayStr,
    score: null,
    activity: [
      { date: todayLabelStr, text: 'Added to pipeline (target)' }
    ]
  };

  await apiPost('/api/save', company);

  // Bump nextId via KV store
  await apiPost('/api/kv', { key: 'nextId', value: String(nextId + 1) });

  return { id: nextId, company: fields.company, role: fields.role, stage: 'target' };
}

var server = new Server(
  { name: 'job-pipeline-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async function() {
  return {
    tools: [
      {
        name: 'list_jobs',
        description: 'Retrieve all job entries in the pipeline. Use this to check for duplicates before adding a new job.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'add_job',
        description: 'Add a new job to the pipeline in the Target List stage. Use list_jobs first to check for duplicates.',
        inputSchema: {
          type: 'object',
          properties: {
            company: { type: 'string', description: 'Company name' },
            role: { type: 'string', description: 'Job title / role' },
            url: { type: 'string', description: 'Job posting URL' },
            source: { type: 'string', description: 'Where you found this (e.g. LinkedIn, Seek, Network)' },
            notes: { type: 'string', description: 'Optional notes about the role' },
            tier: { type: 'string', description: 'Priority tier (A, B, C, D). Defaults to B.' }
          },
          required: ['company', 'role']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async function(request) {
  var name = request.params.name;
  var args = request.params.arguments || {};

  if (name === 'list_jobs') {
    try {
      var jobs = await getAllJobs();
      return { content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Failed to fetch jobs: ' + e.message }] };
    }
  }

  if (name === 'add_job') {
    if (!args.company || !args.role) {
      return { isError: true, content: [{ type: 'text', text: 'Missing required fields: company, role' }] };
    }
    try {
      var result = await addJob(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Failed to add job: ' + e.message }] };
    }
  }

  return { isError: true, content: [{ type: 'text', text: 'Unknown tool: ' + name }] };
});

var transports = {};

http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/sse' && req.method === 'GET') {
    var transport = new SSEServerTransport('/message', res);
    transports[transport.sessionId] = transport;
    res.on('close', function() {
      delete transports[transport.sessionId];
    });
    server.connect(transport);
    return;
  }

  if (req.url.indexOf('/message') === 0 && req.method === 'POST') {
    var urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    var sessionId = urlObj.searchParams.get('sessionId') || urlObj.searchParams.get('session_id');
    var transport = transports[sessionId];
    if (transport) {
      transport.handlePostMessage(req, res);
    } else {
      res.writeHead(404);
      res.end('Session not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found - use /sse for MCP connection');
}).listen(PORT, function() {
  var actualPort = this.address().port;
  console.error('MCP HTTP server listening on port ' + actualPort + ', API: ' + API_BASE);
});
