#!/usr/bin/env node
var http = require('http');
var { Server } = require('@modelcontextprotocol/sdk/server/index.js');
var { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
var { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
var scoring = require('../lib/scoring');
var parse = require('../lib/parse');

var PORT = parseInt(process.env.MCP_PORT || '3100', 10);
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

// ── HTTP helpers ──────────────────────────────────────────────────────────

function apiGet(path) {
  return new Promise(function(resolve, reject) {
    var urlObj = new URL(apiUrl(path));
    var opts = {
      hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname,
      method: 'GET', headers: { 'Accept': 'application/json' }
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

function apiGetText(path) {
  return new Promise(function(resolve, reject) {
    var urlObj = new URL(apiUrl(path));
    var opts = { hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, method: 'GET' };
    var req = http.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        if (res.statusCode !== 200) return reject(new Error('GET ' + path + ' returned ' + res.statusCode));
        resolve(body);
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
      hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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

function apiPostText(path, data) {
  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify(data);
    var urlObj = new URL(apiUrl(path));
    var opts = {
      hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    var req = http.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        if (res.statusCode !== 200) return reject(new Error('POST ' + path + ' returned ' + res.statusCode));
        resolve(body);
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Small helpers ─────────────────────────────────────────────────────────

function safeParse(str) {
  try { return JSON.parse(str || '{}') || {}; } catch(e) { return {}; }
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function mcpErr(msg) {
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

// ── Business logic ────────────────────────────────────────────────────────

var BLOB_DEFAULTS = { url: '', source: '', contact: '', notes: '', added: '', score: null, activity: [] };
var EDITABLE_TOP_FIELDS = ['company', 'role', 'tier', 'stage'];
var EDITABLE_BLOB_FIELDS = ['url', 'source', 'contact', 'notes'];
var JOB_FIELD_DEFAULTS = { url: '', source: '', notes: '', tier: 'B' };

function buildJobFields(fields) {
  var out = Object.assign({}, JOB_FIELD_DEFAULTS);
  Object.keys(JOB_FIELD_DEFAULTS).forEach(function(k) {
    if (fields[k] !== undefined) out[k] = fields[k];
  });
  return out;
}

async function getAllJobs() {
  var result = await apiGet('/api/companies');
  return (result.companies || []).map(function(r) {
    var blob = safeParse(r.data);
    return { id: r.id, company: r.company, role: r.role, stage: r.stage, tier: r.tier,
             url: blob.url || '', added: blob.added || '', furthest_stage: r.furthest_stage };
  });
}

async function getJobDetails(id) {
  var result = await apiGet('/api/companies');
  var row = (result.companies || []).find(function(r) { return r.id === id; });
  if (!row) return null;
  var blob = Object.assign({}, BLOB_DEFAULTS, safeParse(row.data));
  return {
    id: row.id, company: row.company, role: row.role, stage: row.stage, tier: row.tier,
    url: blob.url, source: blob.source, contact: blob.contact, notes: blob.notes,
    added: blob.added, score: blob.score, activity: blob.activity,
    culture_rating: row.culture_rating, culture_notes: row.culture_notes,
    furthest_stage: row.furthest_stage, updated_at: row.updated_at
  };
}

async function addJob(fields) {
  var result = await apiGet('/api/companies');
  var nextId = result.nextId || 1;
  var jf = buildJobFields(fields);

  var company = {
    id: nextId, company: fields.company, role: fields.role,
    tier: jf.tier, stage: 'target',
    url: jf.url, source: jf.source, contact: '',
    next: '', notes: jf.notes, linked_documents: '', jd: '',
    added: todayISO(), score: null,
    activity: [{ date: todayLabel(), text: 'Added to pipeline (target)' }]
  };

  await apiPost('/api/save', company);
  await apiPost('/api/kv', { key: 'nextId', value: String(nextId + 1) });
  return { id: nextId, company: fields.company, role: fields.role, stage: 'target' };
}

async function editJob(id, fields) {
  var result = await apiGet('/api/companies');
  var row = (result.companies || []).find(function(r) { return r.id === id; });
  if (!row) return null;

  var blob = safeParse(row.data);
  var payload = Object.assign({}, blob, {
    id: row.id, stage: row.stage,
    culture_rating: row.culture_rating, culture_notes: row.culture_notes,
    furthest_stage: row.furthest_stage
  });

  EDITABLE_TOP_FIELDS.forEach(function(k) {
    payload[k] = fields[k] !== undefined ? fields[k] : row[k];
  });
  EDITABLE_BLOB_FIELDS.forEach(function(k) {
    if (fields[k] !== undefined) payload[k] = fields[k];
  });

  await apiPost('/api/save', payload);
  return { id: id, updated: true };
}

async function fetchJd(id) {
  var result = await apiGet('/api/companies');
  var row = (result.companies || []).find(function(r) { return r.id === id; });
  if (!row) throw new Error('Job not found: ' + id);

  var blob = safeParse(row.data);
  if (!blob.url) throw new Error('No URL set for job ' + id + '. Use edit_job to set the URL first.');

  var jdText = await apiPostText('/proxy/jina-reader', { url: blob.url });
  var payload = Object.assign({}, blob, {
    id: row.id, company: row.company, role: row.role, tier: row.tier, stage: row.stage,
    culture_rating: row.culture_rating, culture_notes: row.culture_notes,
    furthest_stage: row.furthest_stage, jd: jdText
  });

  await apiPost('/api/save', payload);
  return { id: id, jd_length: jdText.length, preview: jdText.substring(0, 300) };
}

async function callAnthropicHttp(model, prompts) {
  var result = await apiPost('/proxy/anthropic', {
    model: model || 'claude-sonnet-4-20250514', max_tokens: 2000,
    system: prompts.system, messages: [{ role: 'user', content: prompts.user }]
  });
  if (!result.content) throw new Error('Anthropic error: ' + JSON.stringify(result));
  return result.content.filter(function(c) { return c.type === 'text'; })
                       .map(function(c) { return c.text; }).join('');
}

async function callOpenRouterHttp(model, prompts) {
  var result = await apiPost('/proxy/openrouter', {
    model: model || 'anthropic/claude-sonnet-4-20250514',
    messages: [{ role: 'system', content: prompts.system }, { role: 'user', content: prompts.user }],
    max_tokens: 2000, stream: false, response_format: { type: 'json_object' }
  });
  if (!result.choices || !result.choices[0]) throw new Error('OpenRouter error: ' + JSON.stringify(result));
  return result.choices[0].message.content;
}

async function callAiHttp(provider, model, prompts) {
  if (provider === 'openrouter') return callOpenRouterHttp(model, prompts);
  return callAnthropicHttp(model, prompts);
}

async function exportPipeline(includeJd, includeProfile) {
  var result = await apiGet('/api/companies');
  var rows = result.companies || [];

  var jobs = rows.map(function(r) {
    var blob = Object.assign({}, BLOB_DEFAULTS, safeParse(r.data));
    var job = {
      id: r.id, company: r.company, role: r.role, stage: r.stage, tier: r.tier,
      url: blob.url, source: blob.source, contact: blob.contact, notes: blob.notes,
      added: blob.added, score: blob.score, activity: blob.activity,
      culture_rating: r.culture_rating, culture_notes: r.culture_notes,
      furthest_stage: r.furthest_stage, updated_at: r.updated_at
    };
    if (includeJd) job.jd = blob.jd || '';
    return job;
  });

  var byStage = {};
  var byTier = {};
  jobs.forEach(function(j) {
    byStage[j.stage] = (byStage[j.stage] || 0) + 1;
    byTier[j.tier] = (byTier[j.tier] || 0) + 1;
  });

  var out = { exported_at: todayISO(), total: jobs.length, by_stage: byStage, by_tier: byTier, jobs: jobs };
  if (includeProfile) out.evaluation_profile = await apiGetText('/config/evaluation-profile.md');
  return out;
}

async function scoreJob(id, provider, model) {
  var result = await apiGet('/api/companies');
  var row = (result.companies || []).find(function(r) { return r.id === id; });
  if (!row) throw new Error('Job not found: ' + id);

  var blob = Object.assign({ jd: '', url: '' }, safeParse(row.data));
  if (!blob.jd) throw new Error('No JD stored for job ' + id + '. Run fetch_jd first.');

  var profile = await apiGetText('/config/evaluation-profile.md');
  var prompts = scoring.buildScoringPrompts(profile, blob.jd, row.company, blob.url);
  var text = await callAiHttp(provider || 'anthropic', model, prompts);

  var scoreResult = parse.parseJsonResponse(text);
  Object.assign(scoreResult, {
    overall: scoreResult.overall_score, verdict: scoreResult.overall_verdict,
    scored_at: new Date().toISOString().slice(0, 10), jd: blob.jd
  });

  await apiPost('/api/save-score', { id: id, score: scoreResult });
  return { id: id, overall_score: scoreResult.overall_score,
           verdict: scoreResult.overall_verdict, hard_nos_pass: scoreResult.hard_nos_pass };
}

// ── Tool handlers ─────────────────────────────────────────────────────────

async function handleListJobs() {
  try {
    return ok(await getAllJobs());
  } catch(e) {
    return mcpErr('Failed to fetch jobs: ' + e.message);
  }
}

async function handleGetJobDetails(args) {
  if (args.id == null) return mcpErr('Missing required field: id');
  try {
    var job = await getJobDetails(args.id);
    return job ? ok(job) : mcpErr('Job not found: ' + args.id);
  } catch(e) {
    return mcpErr('Failed to fetch job details: ' + e.message);
  }
}

async function handleAddJob(args) {
  if (!args.company || !args.role) return mcpErr('Missing required fields: company, role');
  try {
    return ok(await addJob(args));
  } catch(e) {
    return mcpErr('Failed to add job: ' + e.message);
  }
}

async function handleEditJob(args) {
  if (args.id == null) return mcpErr('Missing required field: id');
  try {
    var result = await editJob(args.id, args);
    return result ? ok(result) : mcpErr('Job not found: ' + args.id);
  } catch(e) {
    return mcpErr('Failed to edit job: ' + e.message);
  }
}

async function handleFetchJd(args) {
  if (args.id == null) return mcpErr('Missing required field: id');
  try {
    return ok(await fetchJd(args.id));
  } catch(e) {
    return mcpErr('Failed to fetch JD: ' + e.message);
  }
}

async function handleScoreJob(args) {
  if (args.id == null) return mcpErr('Missing required field: id');
  try {
    return ok(await scoreJob(args.id, args.provider, args.model));
  } catch(e) {
    return mcpErr('Failed to score job: ' + e.message);
  }
}

async function handleExportPipeline(args) {
  try {
    return ok(await exportPipeline(!!args.include_jd, !!args.include_profile));
  } catch(e) {
    return mcpErr('Failed to export pipeline: ' + e.message);
  }
}

var TOOL_HANDLERS = {
  list_jobs:       handleListJobs,
  get_job_details: handleGetJobDetails,
  add_job:         handleAddJob,
  edit_job:        handleEditJob,
  fetch_jd:        handleFetchJd,
  score_job:       handleScoreJob,
  export_pipeline: handleExportPipeline
};

// ── MCP server ────────────────────────────────────────────────────────────

var server = new Server(
  { name: 'job-pipeline-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async function() {
  return {
    tools: [
      {
        name: 'list_jobs',
        description: 'Returns a slim summary of every job in the pipeline (id, company, role, stage, tier, url, added). Use for dedup checks before adding a new job. Call get_job_details for full data on a specific entry.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'get_job_details',
        description: 'Returns full details for a single job including score, activity log, and culture notes. Use after list_jobs to get in-depth information on a specific entry.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'number', description: 'The job id from list_jobs' } },
          required: ['id']
        }
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
      },
      {
        name: 'edit_job',
        description: 'Edit fields on an existing job. Commonly used to set or correct the URL. All fields except id are optional.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The job id to edit' },
            url: { type: 'string', description: 'Job posting URL' },
            company: { type: 'string', description: 'Company name' },
            role: { type: 'string', description: 'Job title / role' },
            stage: { type: 'string', description: 'Pipeline stage (target, warm, screen, interview, offer, closed)' },
            tier: { type: 'string', description: 'Priority tier (A, B, C, D)' },
            source: { type: 'string', description: 'Where you found this' },
            contact: { type: 'string', description: 'Recruiter or contact name' },
            notes: { type: 'string', description: 'Notes about the role' }
          },
          required: ['id']
        }
      },
      {
        name: 'fetch_jd',
        description: 'Fetch the job description from the URL stored on the job record and save it. Must have a URL set (use edit_job first if needed). Run before score_job.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'number', description: 'The job id to fetch the JD for' } },
          required: ['id']
        }
      },
      {
        name: 'score_job',
        description: 'Score a job against the evaluation profile using an AI model. Requires a JD to be stored (run fetch_jd first). Saves the score to the pipeline.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The job id to score' },
            provider: { type: 'string', description: 'AI provider: anthropic (default) or openrouter' },
            model: { type: 'string', description: 'Model name override (optional)' }
          },
          required: ['id']
        }
      },
      {
        name: 'export_pipeline',
        description: 'Export the full pipeline as structured JSON for analysis in another tool. Includes all jobs with scores, activity logs, and culture notes. JD text and evaluation profile are excluded by default (they are large) — set include_jd or include_profile to true to add them.',
        inputSchema: {
          type: 'object',
          properties: {
            include_jd: { type: 'boolean', description: 'Include stored JD text for each job (can be large). Default false.' },
            include_profile: { type: 'boolean', description: 'Include the evaluation profile markdown. Default false.' }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async function(request) {
  var handler = TOOL_HANDLERS[request.params.name];
  if (!handler) return mcpErr('Unknown tool: ' + request.params.name);
  return handler(request.params.arguments || {});
});

// ── SSE HTTP server ───────────────────────────────────────────────────────

var transports = {};

function getSessionId(url) {
  var urlObj = new URL(url, 'http://localhost');
  return urlObj.searchParams.get('sessionId') || urlObj.searchParams.get('session_id');
}

function handleSseRoute(req, res) {
  var transport = new SSEServerTransport('/message', res);
  transports[transport.sessionId] = transport;
  res.on('close', function() { delete transports[transport.sessionId]; });
  server.connect(transport);
}

function handleMessageRoute(req, res) {
  var transport = transports[getSessionId(req.url)];
  if (transport) { transport.handlePostMessage(req, res); return; }
  res.writeHead(404); res.end('Session not found');
}

http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/sse') { handleSseRoute(req, res); return; }
  if (req.url.indexOf('/message') === 0) { handleMessageRoute(req, res); return; }
  res.writeHead(404);
  res.end('Not found - use /sse for MCP connection');
}).listen(PORT, function() {
  var actualPort = this.address().port;
  console.error('MCP HTTP server listening on port ' + actualPort + ', API: ' + API_BASE);
});
