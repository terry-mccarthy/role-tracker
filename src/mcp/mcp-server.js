#!/usr/bin/env node
var Database = require('better-sqlite3');
var path = require('path');
var https = require('https');
var fs = require('fs');
var { Server } = require('@modelcontextprotocol/sdk/server/index.js');
var { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
var { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
var scoring = require('../lib/scoring');
var parse = require('../lib/parse');

var dbPath = process.env.DB_PATH || path.join(__dirname, '../../pipeline.db');
var db = new Database(dbPath);

function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function todayLabel() {
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var d = new Date();
  return months[d.getMonth()] + ' ' + d.getDate();
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

function resolveProvider(provider) {
  return provider || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openrouter');
}

function getAllJobs() {
  return db.prepare('SELECT * FROM companies ORDER BY id ASC').all().map(function(r) {
    var blob = safeParse(r.data);
    return { id: r.id, company: r.company, role: r.role, stage: r.stage, tier: r.tier,
             url: blob.url || '', added: blob.added || '', furthest_stage: r.furthest_stage };
  });
}

function getJobDetails(id) {
  var r = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!r) return null;
  var blob = Object.assign({}, BLOB_DEFAULTS, safeParse(r.data));
  return {
    id: r.id, company: r.company, role: r.role, stage: r.stage, tier: r.tier,
    url: blob.url, source: blob.source, contact: blob.contact, notes: blob.notes,
    added: blob.added, score: blob.score, activity: blob.activity,
    culture_rating: r.culture_rating, culture_notes: r.culture_notes,
    furthest_stage: r.furthest_stage, updated_at: r.updated_at
  };
}

function addJob(fields) {
  var nextIdRow = db.prepare("SELECT value FROM kv_store WHERE key = 'nextId'").get();
  var nextId = nextIdRow ? parseInt(nextIdRow.value, 10) : 1;
  var jf = buildJobFields(fields);

  var data = {
    url: jf.url, source: jf.source, contact: '',
    next: '', notes: jf.notes, linked_documents: '', jd: '',
    added: todayISO(), score: null,
    activity: [{ date: todayLabel(), text: 'Added to pipeline (target)' }]
  };

  db.prepare(`
    INSERT INTO companies (id, company, role, tier, stage, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      company=excluded.company, role=excluded.role, tier=excluded.tier,
      stage=excluded.stage, data=excluded.data, updated_at=CURRENT_TIMESTAMP
  `).run(nextId, fields.company, fields.role, jf.tier, 'target', JSON.stringify(data));

  db.prepare("UPDATE kv_store SET value = ? WHERE key = 'nextId'").run(String(nextId + 1));
  return { id: nextId, company: fields.company, role: fields.role, stage: 'target' };
}

function editJob(id, fields) {
  var r = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!r) return null;

  var blob = safeParse(r.data);
  var top = { company: r.company, role: r.role, tier: r.tier, stage: r.stage };

  EDITABLE_TOP_FIELDS.forEach(function(k) {
    if (fields[k] !== undefined) top[k] = fields[k];
  });
  EDITABLE_BLOB_FIELDS.forEach(function(k) {
    if (fields[k] !== undefined) blob[k] = fields[k];
  });

  db.prepare('UPDATE companies SET company=?, role=?, tier=?, stage=?, data=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(top.company, top.role, top.tier, top.stage, JSON.stringify(blob), id);
  return { id: id, updated: true };
}

function fetchJd(id) {
  return new Promise(function(resolve, reject) {
    var r = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    if (!r) { reject(new Error('Job not found: ' + id)); return; }

    var blob = safeParse(r.data);
    if (!blob.url) { reject(new Error('No URL set for job ' + id + '. Use edit_job to set the URL first.')); return; }

    https.get('https://r.jina.ai/' + encodeURIComponent(blob.url), function(proxyRes) {
      var body = '';
      proxyRes.on('data', function(c) { body += c; });
      proxyRes.on('end', function() {
        blob.jd = body;
        db.prepare('UPDATE companies SET data=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(JSON.stringify(blob), id);
        resolve({ id: id, jd_length: body.length, preview: body.substring(0, 300) });
      });
    }).on('error', reject);
  });
}

function callAnthropicDirect(model, prompts) {
  var key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) return Promise.reject(new Error('ANTHROPIC_API_KEY not set in MCP server environment'));

  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify({
      model: model || 'claude-sonnet-4-20250514', max_tokens: 2000,
      system: prompts.system, messages: [{ role: 'user', content: prompts.user }]
    });
    var req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': key,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var data = JSON.parse(body);
          if (!data.content) throw new Error('Anthropic error: ' + body);
          resolve(data.content.filter(function(c) { return c.type === 'text'; })
                              .map(function(c) { return c.text; }).join(''));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function callOpenRouterDirect(model, prompts) {
  var key = process.env.OPENROUTER_API_KEY || '';
  if (!key) return Promise.reject(new Error('OPENROUTER_API_KEY not set in MCP server environment'));

  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify({
      model: model || 'anthropic/claude-sonnet-4-20250514',
      messages: [{ role: 'system', content: prompts.system }, { role: 'user', content: prompts.user }],
      max_tokens: 2000, stream: false, response_format: { type: 'json_object' }
    });
    var req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var data = JSON.parse(body);
          if (!data.choices || !data.choices[0]) throw new Error('OpenRouter error: ' + body);
          resolve(data.choices[0].message.content);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function exportPipeline(includeJd, includeProfile) {
  var rows = db.prepare('SELECT * FROM companies ORDER BY id ASC').all();

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
  if (includeProfile) {
    var profilePath = path.join(__dirname, '../../config/evaluation-profile.md');
    try { out.evaluation_profile = fs.readFileSync(profilePath, 'utf8'); }
    catch(e) { out.evaluation_profile = null; }
  }
  return out;
}

function scoreJob(id, provider, model) {
  var r = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!r) return Promise.reject(new Error('Job not found: ' + id));

  var blob = Object.assign({ jd: '', url: '' }, safeParse(r.data));
  if (!blob.jd) return Promise.reject(new Error('No JD stored for job ' + id + '. Run fetch_jd first.'));

  var profilePath = path.join(__dirname, '../../config/evaluation-profile.md');
  var profile;
  try { profile = fs.readFileSync(profilePath, 'utf8'); }
  catch(e) { return Promise.reject(new Error('Could not read evaluation profile: ' + e.message)); }

  var callFn = resolveProvider(provider) === 'openrouter' ? callOpenRouterDirect : callAnthropicDirect;
  var prompts = scoring.buildScoringPrompts(profile, blob.jd, r.company, blob.url);

  return callFn(model, prompts).then(function(text) {
    var scoreResult = parse.parseJsonResponse(text);
    Object.assign(scoreResult, {
      overall: scoreResult.overall_score, verdict: scoreResult.overall_verdict,
      scored_at: new Date().toISOString().slice(0, 10), jd: blob.jd
    });
    blob.score = scoreResult;
    db.prepare('UPDATE companies SET data=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify(blob), id);
    return { id: id, overall_score: scoreResult.overall_score,
             verdict: scoreResult.overall_verdict, hard_nos_pass: scoreResult.hard_nos_pass };
  });
}

// ── Tool handlers ─────────────────────────────────────────────────────────

function handleListJobs() {
  return ok(getAllJobs());
}

function handleGetJobDetails(args) {
  if (args.id == null) return mcpErr('Missing required field: id');
  var job = getJobDetails(args.id);
  return job ? ok(job) : mcpErr('Job not found: ' + args.id);
}

function handleAddJob(args) {
  if (!args.company || !args.role) return mcpErr('Missing required fields: company, role');
  return ok(addJob(args));
}

function handleEditJob(args) {
  if (args.id == null) return mcpErr('Missing required field: id');
  var result = editJob(args.id, args);
  return result ? ok(result) : mcpErr('Job not found: ' + args.id);
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

function handleExportPipeline(args) {
  return ok(exportPipeline(!!args.include_jd, !!args.include_profile));
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
        description: 'Add a new job to the pipeline in the Target List stage. Duplicate company+role combos are still allowed; use list_jobs first to check manually.',
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
        description: 'Score a job against the evaluation profile using an AI model. Requires a JD to be stored (run fetch_jd first). Saves the score to the pipeline. Needs ANTHROPIC_API_KEY or OPENROUTER_API_KEY in the MCP server environment.',
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

async function main() {
  var transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(function(err) {
  console.error('MCP server error:', err);
  process.exit(1);
});
