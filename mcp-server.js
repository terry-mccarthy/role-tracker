#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'pipeline.db');
const db = new Database(dbPath);

function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function todayLabel() {
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var d = new Date();
  return months[d.getMonth()] + ' ' + d.getDate();
}

function getAllJobs() {
  var rows = db.prepare('SELECT * FROM companies ORDER BY id ASC').all();
  return rows.map(function(r) {
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
      added: data.added || '',
      score: data.score || null,
      activity: data.activity || [],
      culture_rating: r.culture_rating,
      culture_notes: r.culture_notes,
      updated_at: r.updated_at
    };
  });
}

function addJob(fields) {
  var nextIdRow = db.prepare("SELECT value FROM kv_store WHERE key = 'nextId'").get();
  var nextId = nextIdRow ? parseInt(nextIdRow.value, 10) : 1;

  var todayStr = todayISO();
  var todayLabelStr = todayLabel();

  var data = {
    url: fields.url || '',
    source: fields.source || '',
    contact: fields.contact || '',
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

  var tier = fields.tier || 'B';

  var upsert = db.prepare(`
    INSERT INTO companies (id, company, role, tier, stage, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      company=excluded.company,
      role=excluded.role,
      tier=excluded.tier,
      stage=excluded.stage,
      data=excluded.data,
      updated_at=CURRENT_TIMESTAMP
  `);

  upsert.run(nextId, fields.company, fields.role, tier, 'target', JSON.stringify(data));
  db.prepare("UPDATE kv_store SET value = ? WHERE key = 'nextId'").run(String(nextId + 1));

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
        inputSchema: {
          type: 'object',
          properties: {}
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
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async function(request) {
  var name = request.params.name;
  var args = request.params.arguments || {};

  if (name === 'list_jobs') {
    var jobs = getAllJobs();
    return {
      content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }]
    };
  }

  if (name === 'add_job') {
    if (!args.company || !args.role) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Missing required fields: company, role' }]
      };
    }
    var result = addJob(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: 'Unknown tool: ' + name }]
  };
});

async function main() {
  var transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(function(err) {
  console.error('MCP server error:', err);
  process.exit(1);
});
