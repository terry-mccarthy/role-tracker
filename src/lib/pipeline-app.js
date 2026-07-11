// Main pipeline CRM application logic (kanban, table, funnel, CRUD).
// Plain non-module script: top-level var/function declarations attach to window
// so inline onclick handlers can reach them. Loaded from pipeline.html.
var STORAGE_KEY = 'pipeline-data';

var STAGES = [
  { id: 'target',    label: 'Target List',  col: 'col-target' },
  { id: 'warm',      label: 'Warming Up',   col: 'col-warm' },
  { id: 'screen',    label: 'Screen',       col: 'col-screen' },
  { id: 'interview', label: 'Interviewing', col: 'col-interview' },
  { id: 'offer',     label: 'Offer',        col: 'col-offer' },
  { id: 'closed',    label: 'Closed',       col: 'col-closed' }
];

var STAGE_COLORS = {
  target: '#6b6f78', warm: '#c4a84f', screen: '#5b8fe8',
  interview: '#9b72e8', offer: '#4caf82', closed: '#3a3d42'
};

var closedExpanded = false;
var funnelAiResult = null;
var funnelAiLoading = false;

window.toggleClosedStack = function() {
  closedExpanded = !closedExpanded;
  window.renderKanban();
};

var AI_NOISE_TEXTS = ['Updated details', 'Researched company culture', 'Added to pipeline', 'Marked as closed'];
var AI_STAGE_KWS = [
  { stage: 'offer',     kw: 'Offer' },
  { stage: 'interview', kw: 'Interview' },
  { stage: 'screen',    kw: 'Screen' },
  { stage: 'warm',      kw: 'Warming Up' }
];

function getSignificantNotes(activity, noiseTexts) {
  return (activity || []).filter(function(a) {
    const t = a.text || '';
    return t.length > 0 && !noiseTexts.some(n => t.indexOf(n) >= 0);
  }).map(function(a) { return a.text; });
}

function buildRoleSummaryEntry(idx, cc) {
  const activity = cc.activity || [];
  const highestStage = getExitHighestStage(activity, AI_STAGE_KWS);
  const notes = getSignificantNotes(activity, AI_NOISE_TEXTS);
  let entry = `${idx + 1}. ${cc.company} — ${cc.role}\n   Tier: ${cc.tier} | Exited at: ${highestStage}\n`;
  if (cc.notes) entry += `   Notes: ${cc.notes}\n`;
  if (notes.length > 0) entry += `   Activity: ${notes.slice(0, 3).join('; ')}\n`;
  return entry + '\n';
}

window.analyzeFunnelWithAI = function() {
  const closedCos = companies.filter(c => c.stage === 'closed');
  if (closedCos.length === 0) return;

  funnelAiLoading = true;
  funnelAiResult = null;
  window.renderFunnel();

  const rolesSummary = closedCos.map((cc, i) => buildRoleSummaryEntry(i, cc)).join('');
  const system = 'You are a senior career strategist helping an engineering manager improve their job search. ' +
    'Analyse the closed (exited) roles below and surface actionable insights. ' +
    'Focus on: (1) patterns in exit stage — where in the process roles keep dying and why, ' +
    '(2) role/company profile patterns — what types of targets are underperforming, ' +
    '(3) 3-5 concrete, specific recommendations to better tailor the search going forward. ' +
    'Be direct and concise. No preamble. Use short paragraphs or bullets. Max 350 words.';
  const user = `Here are the closed roles (${closedCos.length} total):\n\n${rolesSummary}Based on these exits, what patterns do you see and how should this person sharpen their search?`;

  window.callLlm(system, user, null)
    .then(function(text) {
      funnelAiResult = text;
      funnelAiLoading = false;
      window.renderFunnel();
    })
    .catch(function(err) {
      funnelAiResult = 'Request failed: ' + err.message;
      funnelAiLoading = false;
      window.renderFunnel();
    });
};

var FUNNEL_BENCHMARKS = {
  target_warm:      { good: 30, warn: 15 },
  warm_screen:      { good: 40, warn: 20 },
  screen_interview: { good: 60, warn: 35 },
  interview_offer:  { good: 25, warn: 10 }
};

var companies = [];
var nextId = 1;
var selectedId = null;
var editingId = null;
var isLoaded = false;
var searchQuery = '';
var currentView = 'kanban';

window.visibleCompanies = function() {
  return window.filterCompanies(companies, searchQuery);
};

window.onSearch = function(val) {
  searchQuery = val.trim();
  var clearBtn = document.getElementById('global-search-clear');
  if (clearBtn) clearBtn.style.display = searchQuery ? 'block' : 'none';
  if (currentView === 'kanban') window.renderKanban();
  else if (currentView === 'table') window.renderTable();
};

window.clearSearch = function() {
  var input = document.getElementById('global-search');
  if (input) { input.value = ''; }
  window.onSearch('');
};

// ── STORAGE ────────────────────────────────────────────────────────

window.saveToStorage = function() {
  // Save nextId to DB
  fetch('/api/kv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'nextId', value: nextId.toString() })
  });
  
  // NOTE: We no longer sync all companies here. 
  // Individual companies are synced via window.syncCompanyToDb(c) when modified.
};

window.syncCompanyToDb = function(c) {
  if (!c || !c.id) return;
  console.log('[Pipeline] Syncing company to DB:', c.id, c.company);
  c.updated_at = window.todayStr();

  // Create a clean copy for syncing
  var toSync = Object.assign({}, c);
  delete toSync.data; // Ensure we don't send the raw blob back to be double-encoded
  delete toSync.updated_at;

  fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toSync)
  }).then(r => r.json())
    .then(res => {
      if (res.error) console.error('Sync failed for ID ' + c.id + ':', res.error);
    });
};

window.migrateToSqlite = function(localCompanies, localNextId) {
  console.log('[Pipeline] Migrating to SQLite...');
  fetch('/api/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companies: localCompanies, nextId: localNextId })
  }).then(r => r.json())
    .then(res => {
      if (res.success) {
        alert('Migration successful! Data is now in SQLite.');
        window.loadFromStorage();
      } else {
        alert('Migration failed: ' + res.error);
      }
    });
};

function healableCulture(notes) {
  const p = window.parseCultureResponse(String(notes || ''));
  return (p && p.summary && p.summary !== notes) ? p : null;
}

function mergeCultureHeal(obj) {
  if (obj.culture_notes === '[object Object]') { obj.culture_notes = null; obj.culture_rating = null; return; }
  const p = healableCulture(obj.culture_notes);
  if (!p) return;
  obj.culture_rating = obj.culture_rating || p.rating;
  obj.culture_notes = p.summary;
}

function parseCompanyRow(row) {
  let extra = {};
  try { extra = JSON.parse(row.data); } catch(e) {}
  const merged = Object.assign({}, extra, row);
  delete merged.data;
  mergeCultureHeal(merged);
  return merged;
}

function finishLoad() {
  isLoaded = true;
  window.render();
  window.checkForAllScores();
}

function hasStoredCompanies(parsed) {
  return parsed.companies && parsed.companies.length > 0;
}

function migrateIfLocalData() {
  const localData = localStorage.getItem(STORAGE_KEY);
  if (!localData) return false;
  let parsed;
  try { parsed = JSON.parse(localData); } catch(e) { return false; }
  if (!hasStoredCompanies(parsed)) return false;
  if (!confirm('Found existing data in browser storage. Migrate to SQLite?')) return false;
  window.migrateToSqlite(parsed.companies, parsed.nextId);
  return true;
}

window.loadFromStorage = function() {
  console.log('[Pipeline] Loading data from SQLite...');
  fetch('/api/companies')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.companies && data.companies.length > 0) {
        companies = data.companies.map(parseCompanyRow);
        nextId = data.nextId || 1;
        console.log('[Pipeline] Loaded ' + companies.length + ' companies from SQLite');
        finishLoad();
        return;
      }
      if (!migrateIfLocalData()) finishLoad();
    })
    .catch(function(err) {
      console.error('[Pipeline] SQLite load failed', err);
      isLoaded = true;
      window.render();
    });
};

// ── EXPORT / IMPORT ────────────────────────────────────────────────

window.exportData = function() {
  var data = JSON.stringify({ companies: companies, nextId: nextId, exported: new Date().toISOString() }, null, 2);
  var blob = new Blob([data], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'pipeline-export-' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

window.importData = function(event) {
  var file = event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var parsed = JSON.parse(e.target.result);
      if (parsed.companies && parsed.companies.length > 0) {
        if (confirm('Importing ' + parsed.companies.length + ' companies. This will sync them to your SQLite database. Continue?')) {
          window.migrateToSqlite(parsed.companies, parsed.nextId);
        }
      } else {
        alert('No companies found in import file.');
      }
    } catch(err) {
      alert('Invalid JSON file.');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
};

// ── RESET ──────────────────────────────────────────────────────────

window.resetData = function() {
  document.getElementById('confirm-modal').classList.add('open');
};

window.confirmReset = function() {
  fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    .then(function() {
      companies = [];
      nextId = 1;
      selectedId = null;
      document.getElementById('detail-panel').classList.remove('open');
      document.getElementById('confirm-modal').classList.remove('open');
      window.saveToStorage();
      window.render();
    })
    .catch(function(err) {
      console.error('[Pipeline] Reset failed:', err);
      alert('Reset failed. Please try again.');
    });
};

// ── UTILITY ────────────────────────────────────────────────────────

window.daysSince = function(dateStr) {
  var d = new Date(dateStr);
  var now = new Date();
  return Math.floor((now - d) / 86400000);
};

window.todayStr = function() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
};

window.todayLabel = function() {
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var d = new Date();
  return months[d.getMonth()] + ' ' + d.getDate();
};

// ── RENDER ─────────────────────────────────────────────────────────

window.esc = function(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
};

window.mdToHtml = function(s) {
  var lines = String(s == null ? '' : s).split('\n');
  var out = '';
  var inList = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var isBullet = /^[\*\-]\s+/.test(line);
    if (isBullet) {
      if (!inList) { out += '<ul>'; inList = true; }
      var content = line.replace(/^[\*\-]\s+/, '');
      content = window.esc(content).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      out += '<li>' + content + '</li>';
    } else {
      if (inList) { out += '</ul>'; inList = false; }
      var escaped = window.esc(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      if (escaped.trim() === '') {
        if (out.slice(-4) !== '</p>') out += '';
      } else {
        out += '<p>' + escaped + '</p>';
      }
    }
  }
  if (inList) out += '</ul>';
  return out;
};

window.render = function() {
  window.renderStats();
  window.renderKanban();
  window.renderTable();
  window.renderFunnel();
};

window.renderStats = function() {
  var total = companies.length;
  var active = 0, interviews = 0, offers = 0, warm = 0, viaNet = 0;
  for (var i = 0; i < companies.length; i++) {
    var c = companies[i];
    if (c.stage !== 'closed') active++;
    if (c.stage === 'interview') interviews++;
    if (c.stage === 'offer') offers++;
    if (c.stage === 'warm') warm++;
    if (c.source === 'Network') viaNet++;
  }
  document.getElementById('statsbar').innerHTML =
    '<div class="stat-item"><span class="stat-value">' + total + '</span><span class="stat-label">Total in Pipeline</span></div>' +
    '<div class="stat-item"><span class="stat-value">' + active + '</span><span class="stat-label">Active</span></div>' +
    '<div class="stat-item"><span class="stat-value">' + warm + '</span><span class="stat-label">Warming Up</span></div>' +
    '<div class="stat-item"><span class="stat-value">' + interviews + '</span><span class="stat-label">Interviewing</span></div>' +
    '<div class="stat-item"><span class="stat-value">' + offers + '</span><span class="stat-label">Offers</span></div>' +
    '<div class="stat-item"><span class="stat-value">' + viaNet + '</span><span class="stat-label">Via Network</span></div>';
};

function buildScoreBadge(score) {
  if (!score || (score.overall === undefined && score.overall_score === undefined)) return '';
  const sc = score.overall !== undefined ? score.overall : score.overall_score;
  const scColor = sc >= 7 ? 'var(--green)' : sc >= 5 ? 'var(--accent2)' : 'var(--red)';
  return `<div class="card-score-badge" style="color:${scColor};border:1px solid ${scColor}44">${sc}</div>`;
}

function buildCultureBadge(culture_rating) {
  if (!culture_rating) return '';
  const cColor = culture_rating >= 4 ? 'var(--green)' : culture_rating >= 3 ? 'var(--accent2)' : 'var(--red)';
  return `<span style="color:${cColor};font-size:0.65rem;margin-left:0.4rem;font-family:var(--mono)">★${culture_rating}</span>`;
}

window.renderCard = function(c) {
  var days = window.daysSince(c.updated_at || c.added);
  var urgent = (c.stage === 'interview' || c.stage === 'warm') && days > 5;
  var contactTag = c.contact && c.contact.length > 0
    ? '<span class="tag">' + window.esc(c.contact.split('(')[0].trim()) + '</span>'
    : '';
  var urlTag = c.url && c.url.length > 0
    ? '<span class="tag" style="color:var(--blue)">Link</span>'
    : '';
  var scoreBadge = buildScoreBadge(c.score);
  var cultureBadge = buildCultureBadge(c.culture_rating);
  var nextLine = c.next ? '<div class="card-next">' + window.esc(c.next) + '</div>' : '';
  return '<div class="card' + (urgent ? ' card-urgent' : '') + '" onclick="selectCompany(' + c.id + ')">' +
    scoreBadge +
    '<div class="card-company">' + window.esc(c.company) + cultureBadge + '</div>' +
    '<div class="card-role">' + window.esc(c.role) + '</div>' +
    nextLine +
    '<div class="card-meta">' +
      '<span class="card-tier tier-' + c.tier.toLowerCase() + '">Tier ' + c.tier + '</span>' +
      '<span class="card-date">' + days + 'd ago</span>' +
    '</div>' +
    '<div class="card-tags"><span class="tag">' + window.esc(c.source) + '</span>' + contactTag + urlTag + '</div>' +
  '</div>';
};

window.renderCompactCard = function(c) {
  var days = window.daysSince(c.updated_at || c.added);
  return '<div class="closed-stack-card" onclick="selectCompany(' + c.id + ')">' +
    '<div class="closed-stack-card-left">' +
      '<div class="closed-stack-card-company">' + window.esc(c.company) + '</div>' +
      '<div class="closed-stack-card-role">' + window.esc(c.role) + '</div>' +
    '</div>' +
    '<div class="closed-stack-card-right">' +
      '<span class="closed-stack-card-tier tier-' + c.tier.toLowerCase() + '">Tier ' + c.tier + '</span>' +
      '<span class="closed-stack-card-date">' + days + 'd</span>' +
    '</div>' +
  '</div>';
};

function buildKanbanColHtml(s, cards) {
  const header = `<div class="col-header"><div class="col-header-left"><div class="col-dot"></div><div class="col-name">${s.label}</div></div><div class="col-count">${cards.length}</div></div>`;
  let body = '';
  if (cards.length === 0) {
    body = '<div class="empty-col">No companies<br>at this stage</div>';
  } else if (s.id === 'closed') {
    const showAll = closedExpanded || searchQuery;
    const arrow = `<span class="closed-stack-arrow${showAll ? ' open' : ''}">&#9654;</span>`;
    const stackBody = showAll
      ? `<div class="closed-stack-body">${cards.map(window.renderCompactCard).join('')}</div>`
      : '';
    body = `<div class="closed-stack"><div class="closed-stack-toggle" onclick="toggleClosedStack()"><div class="closed-stack-left">${arrow}<span>Closed</span></div><div class="closed-stack-count">${cards.length}</div></div>${stackBody}</div>`;
  } else {
    body = cards.map(window.renderCard).join('');
  }
  return `<div class="kanban-col ${s.col}">${header}${body}<button class="add-card-btn" onclick="openModal('${s.id}')">+ Add</button></div>`;
}

window.renderKanban = function() {
  const wrap = document.getElementById('view-kanban');

  if (companies.length === 0) {
    wrap.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;padding:4rem 2rem;text-align:center">' +
      '<div style="font-family:var(--serif);font-size:1.8rem;color:var(--text);margin-bottom:0.5rem">Your pipeline is empty</div>' +
      '<div style="font-size:0.85rem;color:var(--dim);max-width:400px;line-height:1.6;margin-bottom:1.5rem">Add your first company to get started. Click the button below or use + Add Company in the top right. You can also import an existing pipeline from a JSON file.</div>' +
      '<button class="btn-add" onclick="openModal()" style="font-size:0.7rem;padding:0.5rem 1.2rem">+ Add Your First Company</button>' +
    '</div>';
    return;
  }

  const visible = window.visibleCompanies();

  if (searchQuery && visible.length === 0) {
    wrap.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;padding:4rem 2rem;text-align:center;color:var(--muted);font-family:var(--mono);font-size:0.8rem">No matches for &ldquo;' + window.esc(searchQuery) + '&rdquo;</div>';
    return;
  }

  const html = STAGES.map(s => {
    const cards = visible.filter(c => c.stage === s.id);
    if (searchQuery && cards.length === 0) return '';
    return buildKanbanColHtml(s, cards);
  }).join('');
  wrap.innerHTML = html;
};

window.toggleFilterDropdown = function(id) {
  var panel = document.getElementById(id + '-panel');
  var isOpen = panel.style.display === 'block';
  var allPanels = document.querySelectorAll('.filter-panel');
  for (var i = 0; i < allPanels.length; i++) allPanels[i].style.display = 'none';
  if (!isOpen) panel.style.display = 'block';
};

document.addEventListener('click', function(e) {
  var t = e.target;
  while (t) { if (t.classList && t.classList.contains('filter-dd')) return; t = t.parentElement; }
  var allPanels = document.querySelectorAll('.filter-panel');
  for (var i = 0; i < allPanels.length; i++) allPanels[i].style.display = 'none';
});

function getCheckedValues(panelId) {
  var boxes = document.querySelectorAll('#' + panelId + ' input:checked');
  var vals = [];
  for (var i = 0; i < boxes.length; i++) vals.push(boxes[i].value);
  return vals;
}

function updateFilterBtn(btnId, label, count) {
  var btn = document.getElementById(btnId);
  if (!btn) return;
  btn.textContent = count > 0 ? label + ' (' + count + ')' : label;
  if (count > 0) btn.classList.add('active'); else btn.classList.remove('active');
}

window.clearTableFilters = function() {
  document.getElementById('tbl-search').value = '';
  var boxes = document.querySelectorAll('.filter-panel input[type="checkbox"]');
  for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
  window.renderTable();
};

function filterTableRows(base, search, stageF, tierF, sourceF) {
  return base.filter(function(c) {
    if (search && (c.company + ' ' + c.role + ' ' + (c.contact || '')).toLowerCase().indexOf(search) === -1) return false;
    if (stageF.length > 0 && stageF.indexOf(c.stage) === -1) return false;
    if (tierF.length > 0 && tierF.indexOf(c.tier) === -1) return false;
    if (sourceF.length > 0 && sourceF.indexOf(c.source) === -1) return false;
    return true;
  });
}

function buildTableRowHtml(c) {
  const sl = (STAGES.find(s => s.id === c.stage) || {}).label || '';
  return `<tr onclick="selectCompany(${c.id})" style="cursor:pointer">` +
    `<td style="font-weight:600">${window.esc(c.company)}</td>` +
    `<td style="color:var(--dim)">${window.esc(c.role)}</td>` +
    `<td><span class="card-tier tier-${c.tier.toLowerCase()}">Tier ${c.tier}</span></td>` +
    `<td><span class="stage-pill stage-${c.stage}">${sl}</span></td>` +
    `<td style="color:var(--dim)">${window.esc(c.source)}</td>` +
    `<td style="color:var(--dim);font-family:var(--mono);font-size:0.7rem">${window.daysSince(c.added)}d ago</td>` +
    `<td style="color:var(--accent2);font-style:italic;font-size:0.72rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.esc(c.next || '')}</td></tr>`;
}

window.renderTable = function() {
  const tbody = document.getElementById('table-body');
  const search = document.getElementById('tbl-search') ? document.getElementById('tbl-search').value.toLowerCase() : '';
  const stageF = getCheckedValues('fd-stage-panel');
  const tierF = getCheckedValues('fd-tier-panel');
  const sourceF = getCheckedValues('fd-source-panel');

  updateFilterBtn('fd-stage-btn', 'Stage', stageF.length);
  updateFilterBtn('fd-tier-btn', 'Tier', tierF.length);
  updateFilterBtn('fd-source-btn', 'Source', sourceF.length);

  if (companies.length === 0) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:2rem">No companies yet</td></tr>'; return; }
  const filtered = filterTableRows(window.visibleCompanies(), search, stageF, tierF, sourceF);
  if (filtered.length === 0) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:2rem">No matches</td></tr>'; return; }
  tbody.innerHTML = filtered.map(buildTableRowHtml).join('');
};

function buildFunnelBarHtml(s, count, total, color) {
  const pct = Math.max(4, Math.round((count / total) * 100));
  return `<div class="funnel-stage-row">` +
    `<div class="funnel-stage-label">${s.label}</div>` +
    `<div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${pct}%;background:${color}20;border-left:3px solid ${color}">` +
    `<span class="funnel-bar-text" style="color:${color}">${count}</span></div></div>` +
    `<div class="funnel-stat">${count} &middot; ${Math.round(count / total * 100)}%</div></div>`;
}

function buildConversionArrowHtml(s, ns, cumulative, benchmarks) {
  const fromCum = cumulative[s.id] || 0;
  const toCum = cumulative[ns.id] || 0;
  const convRate = fromCum > 0 ? Math.round((toCum / fromCum) * 100) : 0;
  const benchKey = s.id + '_' + ns.id;
  const bench = benchmarks[benchKey];
  let convClass = 'conv-warn';
  if (bench) { convClass = convRate >= bench.good ? 'conv-good' : convRate >= bench.warn ? 'conv-warn' : 'conv-bad'; }
  const benchLabel = bench ? ` <span style="color:var(--muted);font-size:0.58rem;font-family:var(--mono)">&middot; target &ge;${bench.good}%</span>` : '';
  return `<div class="conversion-arrow">&darr; <span class="conv-rate ${convClass}">${convRate}% conversion</span>${benchLabel}</div>`;
}

function buildFunnelBarsHtml(activeStages, counts, cumulative, total) {
  let html = '';
  for (let i = 0; i < activeStages.length; i++) {
    const s = activeStages[i];
    html += buildFunnelBarHtml(s, counts[s.id], total, STAGE_COLORS[s.id]);
    if (i < activeStages.length - 1) {
      html += buildConversionArrowHtml(s, activeStages[i + 1], cumulative, FUNNEL_BENCHMARKS);
    }
  }
  return html;
}

function getExitHighestStage(activity, stageKws) {
  let highestStage = 'target';
  outerKw: for (let ski = 0; ski < stageKws.length; ski++) {
    for (let aii = 0; aii < activity.length; aii++) {
      if ((activity[aii].text || '').indexOf(stageKws[ski].kw) >= 0) {
        highestStage = stageKws[ski].stage;
        break outerKw;
      }
    }
  }
  return highestStage;
}

function getExitNote(activity, noiseTexts) {
  for (let en = 0; en < activity.length; en++) {
    const enText = activity[en].text || '';
    const isNoise = noiseTexts.some(n => enText.indexOf(n) >= 0);
    if (!isNoise && enText.length > 0) return enText;
  }
  return null;
}

function buildExitRow(cc, stageKws, noiseTexts) {
  const activity = cc.activity || [];
  const highestStage = getExitHighestStage(activity, stageKws);
  const exitNote = getExitNote(activity, noiseTexts);
  const stageColor = STAGE_COLORS[highestStage] || '#6b6f78';
  const stageLabel = highestStage.charAt(0).toUpperCase() + highestStage.slice(1);
  const noteDisplay = exitNote ? (exitNote.length > 80 ? exitNote.substring(0, 77) + '...' : exitNote) : null;
  const noteHtml = noteDisplay
    ? `<span class="funnel-exit-note">${window.esc(noteDisplay)}</span>`
    : '<span class="funnel-exit-note funnel-exit-no-note">no note</span>';
  return {
    html: `<div class="funnel-exit-row">` +
      `<span class="funnel-exit-company">${window.esc(cc.company)}</span>` +
      `<span class="funnel-exit-stage" style="border-color:${stageColor};color:${stageColor}">${stageLabel}</span>` +
      noteHtml + '</div>',
    isPost: highestStage === 'interview' || highestStage === 'offer'
  };
}

function buildClosedSectionHtml(closedCos) {
  if (closedCos.length === 0) return '';
  const noiseTexts = ['Updated details', 'Researched company culture', 'Added to pipeline', 'Marked as closed'];
  const stageKws = [
    { stage: 'offer',     kw: 'Offer' },
    { stage: 'interview', kw: 'Interview' },
    { stage: 'screen',    kw: 'Screen' },
    { stage: 'warm',      kw: 'Warming Up' }
  ];
  let preInterview = 0, postInterview = 0, exitRows = '';
  for (let i = 0; i < closedCos.length; i++) {
    const row = buildExitRow(closedCos[i], stageKws, noiseTexts);
    if (row.isPost) { postInterview++; } else { preInterview++; }
    exitRows += row.html;
  }
  const aiBtn = funnelAiLoading
    ? '<button class="funnel-ai-btn" disabled>Analysing...</button>'
    : '<button class="funnel-ai-btn" onclick="window.analyzeFunnelWithAI()">Analyse with AI</button>';
  let aiResultHtml = '';
  if (funnelAiLoading) {
    aiResultHtml = '<div class="funnel-ai-result"><div class="funnel-ai-result-label">AI Insights</div>'
      + '<div class="funnel-ai-result-body" style="color:var(--muted)">Thinking...</div></div>';
  } else if (funnelAiResult) {
    aiResultHtml = '<div class="funnel-ai-result"><div class="funnel-ai-result-label">AI Insights &middot; <span style="cursor:pointer;text-decoration:underline" onclick="funnelAiResult=null;window.renderFunnel()">clear</span></div>'
      + '<div class="funnel-ai-result-body">' + window.mdToHtml(funnelAiResult) + '</div></div>';
  }
  return '<div class="funnel-closed-section">' +
    '<div class="funnel-closed-header">' +
      `<span class="funnel-closed-title">Closed &middot; ${closedCos.length}</span>` +
      `<div style="display:flex;align-items:center;gap:1rem"><span class="funnel-closed-split">${preInterview} before interview &middot; ${postInterview} after</span>${aiBtn}</div>` +
    '</div>' +
    exitRows + aiResultHtml + '</div>';
}

function buildFunnelInsightsHtml(stats, counts) {
  const netConv = stats.netConv;
  const boardConv = stats.boardConv;
  const screenCount = stats.screenCount;
  const bottleneck = stats.bottleneck;
  const channelMsg = netConv > boardConv ? 'Prioritise network outreach over cold applications.' : 'Both channels performing similarly.';
  let diagMsg = '';
  if (bottleneck === 'target_warm') {
    diagMsg = `You have <span class="highlight">${counts['target']} companies</span> sitting in Target without warm outreach. The block is activation.`;
  } else if (bottleneck === 'warm_screen') {
    diagMsg = 'Warm-up is not converting to screens. Review your follow-up cadence.';
  } else {
    diagMsg = `Pipeline shape looks healthy. Focus on advancing the <span class="highlight">${counts['interview'] || 0} interviewing</span> stage.`;
  }
  return '<div class="funnel-insights">' +
    `<div class="insight-card"><h4>Channel Efficiency</h4><p>Network converts at <span class="highlight">${netConv}%</span> to screen. Job boards at <span class="highlight">${boardConv}%</span>. ${channelMsg}</p></div>` +
    `<div class="insight-card"><h4>Pipeline Diagnosis</h4><p>${diagMsg}</p></div>` +
    `<div class="insight-card"><h4>Tier Distribution</h4><p>Tier A: <span class="highlight">${stats.tierA}</span> &middot; Tier B: <span class="highlight">${stats.tierB}</span> &middot; Tier C: <span class="highlight">${stats.tierC}</span>. ${stats.tierA < 4 ? 'Add more Tier A targets.' : 'Good tier spread.'}</p></div>` +
    `<div class="insight-card"><h4>Velocity</h4><p><span class="highlight">${screenCount}</span> active past warm stage. Target: 6-8. ${screenCount < 4 ? 'Accelerate outreach.' : screenCount > 10 ? 'Focus on quality now.' : 'Good momentum.'}</p></div></div>`;
}

window.renderFunnel = function() {
  var container = document.getElementById('funnel-container');
  if (companies.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:4rem 2rem;color:var(--muted)"><div style="font-family:var(--serif);font-size:1.4rem;color:var(--text);margin-bottom:0.5rem">No data yet</div><div style="font-size:0.82rem">Add companies to see funnel analysis</div></div>';
    return;
  }

  var stats = window.computeFunnelStats(companies);
  var counts = stats.counts;
  var cumulative = stats.cumulative;
  var total = companies.length || 1;
  var activeStages = [];
  for (var i = 0; i < STAGES.length; i++) { if (STAGES[i].id !== 'closed') activeStages.push(STAGES[i]); }

  var closedCos = companies.filter(function(c) { return c.stage === 'closed'; });

  var html = '<div class="funnel-title">Funnel Analysis</div>' +
    '<div class="funnel-subtitle">Live conversion rates &middot; ' + companies.length + ' companies tracked</div>';

  html += buildFunnelBarsHtml(activeStages, counts, cumulative, total);
  html += buildFunnelInsightsHtml(stats, counts);

  var closedHtml = buildClosedSectionHtml(closedCos);
  html += closedHtml;
  console.log('[FunnelAI] setting innerHTML, closedHtml length=' + closedHtml.length);
  container.innerHTML = html;
  if (funnelAiResult) {
    var funnelView = document.getElementById('view-funnel');
    if (funnelView) setTimeout(function() { funnelView.scrollTop = funnelView.scrollHeight; }, 50);
  }
};

// ── DETAIL PANEL ───────────────────────────────────────────────────

function renderDetailLinkedDocs(c) {
  const docsSection = document.getElementById('dp-linked-docs-section');
  const docsContainer = document.getElementById('dp-linked-docs');
  if (c.linked_documents && c.linked_documents.trim()) {
    const urls = c.linked_documents.split('\n');
    let docsHtml = '<div style="display:flex;flex-direction:column;gap:0.4rem;">';
    for (let d = 0; d < urls.length; d++) {
      const urlStr = urls[d].trim();
      if (urlStr) {
        let safeUrl = urlStr;
        if (safeUrl.indexOf('http://') !== 0 && safeUrl.indexOf('https://') !== 0) safeUrl = '';
        docsHtml += `<a href="${safeUrl}" target="_blank" rel="noopener" style="font-size:0.78rem;color:var(--blue);text-decoration:none;word-break:break-all;line-height:1.4;">${window.esc(urlStr)}</a>`;
      }
    }
    docsHtml += '</div>';
    docsContainer.innerHTML = docsHtml;
    docsSection.style.display = 'block';
  } else {
    docsSection.style.display = 'none';
  }
}

function renderDetailInterviewNotes(c, id) {
  const interviewNotes = c.interviewNotes || [];
  const inEl = document.getElementById('dp-interview-notes');
  if (inEl) {
    if (interviewNotes.length === 0) {
      inEl.innerHTML = '<div class="detail-text" style="color:var(--muted);font-style:italic">No interview notes yet.</div>';
    } else {
      let inHTML = '';
      for (let n = 0; n < interviewNotes.length; n++) {
        inHTML += `<div class="activity-item"><div class="activity-dot" style="background:var(--accent2)"></div><div class="activity-content"><div style="font-size:0.8rem;line-height:1.5">${window.esc(interviewNotes[n].text)}</div><div class="activity-date">${window.esc(interviewNotes[n].date)}</div></div></div>`;
      }
      inEl.innerHTML = inHTML;
    }
  }
  const noteEntryInput = document.getElementById('dp-note-entry');
  if (noteEntryInput) { noteEntryInput.value = ''; noteEntryInput.setAttribute('data-id', id); }
}

function renderDetailActivityLog(acts) {
  let actHTML = '';
  for (let k = 0; k < acts.length; k++) {
    actHTML += `<div class="activity-item"><div class="activity-dot"></div><div class="activity-content"><div>${window.esc(acts[k].text)}</div><div class="activity-date">${window.esc(acts[k].date)}</div></div></div>`;
  }
  document.getElementById('dp-activity').innerHTML = actHTML || '<div class="detail-text">No activity yet.</div>';
}

function renderDetailActions(c, id) {
  let stageIdx = -1;
  for (let m = 0; m < STAGES.length; m++) { if (STAGES[m].id === c.stage) stageIdx = m; }
  let btns = '';
  if (stageIdx >= 0 && stageIdx < STAGES.length - 2) {
    const nxt = STAGES[stageIdx + 1];
    btns += `<button class="btn-advance primary" onclick="advanceStage(${id})">Move to ${nxt.label}</button>`;
  }
  btns += `<button class="btn-advance" onclick="logActivity(${id})">+ Log Activity</button>`;
  btns += `<button class="btn-advance" onclick="editCompany(${id})">Edit</button>`;
  btns += `<button class="btn-advance" onclick="openScorer(${id})" style="color:var(--blue);border-color:var(--blue)">Score Role</button>`;
  btns += `<button class="btn-advance" onclick="researchCulture(${id})" style="color:var(--purple);border-color:var(--purple)">Research Culture</button>`;
  btns += `<button class="btn-advance danger" onclick="closeCompany(${id})">Close</button>`;
  btns += `<button class="btn-advance danger" onclick="deleteCompany(${id})">Delete</button>`;
  document.getElementById('dp-actions').innerHTML = btns;
}

window.selectCompany = function(id) {
  selectedId = id;
  var c = null;
  for (var i = 0; i < companies.length; i++) { if (companies[i].id == id) c = companies[i]; }
  if (!c) return;

  document.getElementById('dp-company').textContent = c.company;
  document.getElementById('dp-role').textContent = c.role;
  var notesInput = document.getElementById('dp-notes-input');
  if (notesInput) notesInput.value = c.notes || '';
  notesInput && notesInput.setAttribute('data-id', id);
  document.getElementById('dp-next').textContent = c.next || '';
  document.getElementById('dp-contact').textContent = c.contact || 'No contact listed';

  renderDetailLinkedDocs(c);
  renderDetailInterviewNotes(c, id);

  if (c.url && c.url.length > 0) {
    document.getElementById('dp-url').href = c.url;
    document.getElementById('dp-url').textContent = c.url.length > 60 ? c.url.substring(0,60) + '...' : c.url;
    document.getElementById('dp-url-wrap').style.display = 'block';
  } else {
    document.getElementById('dp-url-wrap').style.display = 'none';
  }

  var sl = '';
  for (var j = 0; j < STAGES.length; j++) { if (STAGES[j].id === c.stage) sl = STAGES[j].label; }
  document.getElementById('dp-meta').innerHTML =
    '<span class="card-tier tier-' + c.tier.toLowerCase() + '">Tier ' + c.tier + '</span>' +
    '<span class="stage-pill stage-' + c.stage + '">' + sl + '</span>' +
    '<span class="tag">' + window.esc(c.source) + '</span>';

  renderDetailActivityLog(c.activity || []);
  renderDetailActions(c, id);

  document.getElementById('detail-panel').classList.add('open');

  window.showScoreInPanel(c.score || null);
  window.renderCulture(c);
  if (c.culture_notes) {
    document.getElementById('dp-culture-section').style.display = 'block';
  } else {
    document.getElementById('dp-culture-section').style.display = 'none';
  }
  window.checkForNewScore(id);
};

window.advanceStage = function(id) {
  var c = null;
  for (var i = 0; i < companies.length; i++) { if (companies[i].id === id) c = companies[i]; }
  if (!c) return;
  var stageIdx = -1;
  for (var m = 0; m < STAGES.length; m++) { if (STAGES[m].id === c.stage) stageIdx = m; }
  if (stageIdx >= 0 && stageIdx < STAGES.length - 2) {
    var ns = STAGES[stageIdx + 1];
    c.stage = ns.id;
    if (!c.activity) c.activity = [];
    c.activity.unshift({ date: window.todayLabel(), text: 'Advanced to ' + ns.label });
  }
  window.syncCompanyToDb(c);
  window.render();
  window.selectCompany(id);
};

function buildCultureSearchContext(company, results) {
  return results.reduce((ctx, r) => ctx + `- ${r.title}\n  ${r.content}\n\n`, `Search Results for ${company}:\n\n`);
}

function buildCultureLlmPrompt(company, context) {
  const system = "You are an expert career advisor. Summarize the following web search snippets about a company's culture, work-life balance, management, and compensation.\n\n" +
    "IMPORTANT: You must respond ONLY with a JSON object. Use double quotes for all keys and string values. Do NOT use backticks for multiline strings; use \\n instead.\n" +
    "Format:\n{\n  \"rating\": <number 1-5 based on sentiment>,\n  \"summary\": \"<concise summary with bullet points>\"\n}";
  return { system, user: `Company: ${company}\n\n${context}` };
}

function applyCultureResponse(c, id, response, loadingEl) {
  const parsed = window.parseCultureResponse(response);
  if (parsed) {
    c.culture_notes = parsed.summary;
    c.culture_rating = parsed.rating;
  } else {
    console.warn('Failed to parse culture JSON, storing raw text');
    c.culture_notes = response;
    c.culture_rating = 0;
  }
  if (!c.activity) c.activity = [];
  c.activity.unshift({ date: window.todayLabel(), text: 'Researched company culture' });
  window.syncCompanyToDb(c);
  if (selectedId === id) {
    window.renderCulture(c);
    loadingEl.style.display = 'none';
    window.render();
  }
}

window.researchCulture = function(id) {
  var c = null;
  for (var i = 0; i < companies.length; i++) { if (companies[i].id === id) c = companies[i]; }
  if (!c) return;

  const section = document.getElementById('dp-culture-section');
  const textEl = document.getElementById('dp-culture-text');
  const loadingEl = document.getElementById('dp-culture-loading');
  section.style.display = 'block';
  loadingEl.style.display = 'inline';
  textEl.textContent = 'Searching web for ' + c.company + ' employee reviews...';

  fetch('/proxy/tavily-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: c.company + ' employee reviews culture working conditions glassdoor' })
  })
  .then(function(res) {
    if (res.status === 503) throw new Error('Tavily not configured on server. Add TAVILY_API_KEY to .env and restart.');
    if (!res.ok) throw new Error('Tavily search failed');
    return res.json();
  })
  .then(function(data) {
    if (!data.results || data.results.length === 0) throw new Error('No search results found for ' + c.company);
    const context = buildCultureSearchContext(c.company, data.results);
    textEl.textContent = 'Summarizing reviews with LLM...';
    const prompt = buildCultureLlmPrompt(c.company, context);
    return window.callLlm(prompt.system, prompt.user, null);
  })
  .then(function(response) { applyCultureResponse(c, id, response, loadingEl); })
  .catch(function(err) {
    console.error('Culture research error:', err);
    if (selectedId === id) {
      textEl.textContent = 'Failed to research culture: ' + (err.message || 'Unknown error');
      loadingEl.style.display = 'none';
    }
  });
};

function buildCultureRatingHtml(rating) {
  if (!rating) return '';
  const rColor = rating >= 4 ? 'var(--green)' : rating >= 3 ? 'var(--accent2)' : 'var(--red)';
  let stars = '';
  for (let i = 1; i <= 5; i++) {
    stars += `<span style="font-size:0.9rem;margin-right:0.05rem;color:${i <= rating ? rColor : 'var(--border2)'}">★</span>`;
  }
  const sentiment = rating >= 4 ? 'Positive' : rating >= 3 ? 'Neutral' : 'Negative';
  return `<div style="background:var(--surface2);padding:0.75rem 1rem;border-radius:6px;border:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">` +
    `<div>` +
      `<div style="font-family:var(--mono);font-size:0.55rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.3rem;letter-spacing:0.05em">Cultural Sentiment</div>` +
      `<div style="display:flex;align-items:center;gap:0.5rem">` +
        `<span style="font-family:var(--serif);font-size:1.4rem;font-weight:600;color:${rColor}">${rating}</span>` +
        `<span style="font-family:var(--mono);font-size:0.6rem;color:var(--dim);margin-top:0.3rem">/ 5</span>` +
      `</div>` +
    `</div>` +
    `<div style="text-align:right">` +
      `<div style="margin-bottom:0.2rem">${stars}</div>` +
      `<div style="font-size:0.55rem;color:var(--dim);font-family:var(--mono);text-transform:uppercase">${sentiment}</div>` +
    `</div>` +
  `</div>`;
}

function healCultureData(c) {
  if (c.culture_notes === '[object Object]') { c.culture_notes = null; c.culture_rating = null; }
  const parsed = window.parseCultureResponse(c.culture_notes || '');
  if (parsed && parsed.summary && parsed.summary !== c.culture_notes) {
    c.culture_notes = parsed.summary;
    c.culture_rating = parsed.rating;
    window.syncCompanyToDb(c);
  }
}

window.renderCulture = function(c) {
  const textEl = document.getElementById('dp-culture-text');
  const ratingEl = document.getElementById('dp-culture-rating');
  if (!textEl || !ratingEl) return;

  healCultureData(c);
  const notes = c.culture_notes || '';
  const rating = c.culture_rating || 0;

  textEl.textContent = notes;
  ratingEl.innerHTML = buildCultureRatingHtml(rating);

  const cultureSection = document.getElementById('dp-culture-section');
  if (cultureSection) cultureSection.style.display = (notes || rating) ? 'block' : 'none';
};

window.closeCompany = function(id) {
  var c = null;
  for (var i = 0; i < companies.length; i++) { if (companies[i].id === id) c = companies[i]; }
  if (!c) return;
  var stageLabel = c.stage;
  for (var j = 0; j < STAGES.length; j++) { if (STAGES[j].id === c.stage) stageLabel = STAGES[j].label; }
  var reason = prompt('Rejection reason (optional):');
  window.closeCompanyRecord(c, stageLabel, reason, window.todayLabel());
  window.syncCompanyToDb(c);
  window.render();
  document.getElementById('detail-panel').classList.remove('open');
  selectedId = null;
};

window.deleteCompany = function(id) {
  if (!confirm('Delete this company from the pipeline?')) return;
  
  fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id })
  });

  for (var i = 0; i < companies.length; i++) {
    if (companies[i].id == id) { companies.splice(i, 1); break; }
  }
  window.saveToStorage();
  window.render();
  document.getElementById('detail-panel').classList.remove('open');
  selectedId = null;
};

window.addInterviewNote = function() {
  var el = document.getElementById('dp-note-entry');
  var text = el.value.trim();
  if (!text) return;
  var c = null;
  for (var i = 0; i < companies.length; i++) { if (companies[i].id === selectedId) c = companies[i]; }
  if (!c) return;
  window.addInterviewNoteToCompany(c, text, window.todayLabel());
  el.value = '';
  window.syncCompanyToDb(c);
  window.selectCompany(selectedId);
};

var saveNotesTimer = null;
window.saveNotes = function(el) {
  clearTimeout(saveNotesTimer);
  saveNotesTimer = setTimeout(function() {
    var id = parseInt(el.getAttribute('data-id'));
    if (!id) return;
    var c = null;
    for (var i = 0; i < companies.length; i++) { if (companies[i].id === id) c = companies[i]; }
    if (!c) return;
    c.notes = el.value;
    window.syncCompanyToDb(c);
  }, 500);
};

window.logActivity = function(id) {
  var text = prompt('What happened?');
  if (!text) return;
  var c = null;
  for (var i = 0; i < companies.length; i++) { if (companies[i].id === id) c = companies[i]; }
  if (!c) return;
  window.logActivityToCompany(c, text, window.todayLabel());
  window.syncCompanyToDb(c);
  window.render();
  window.selectCompany(id);
};

// ── MODAL (ADD + EDIT) ─────────────────────────────────────────────

window.openModal = function(stage) {
  editingId = null;
  document.getElementById('modal-title').textContent = 'Add Company to Pipeline';
  document.getElementById('modal-save-btn').textContent = 'Add to Pipeline';
  if (stage) document.getElementById('f-stage').value = stage;
  document.getElementById('modal').classList.add('open');
};

window.editCompany = function(id) {
  var c = null;
  for (var i = 0; i < companies.length; i++) { if (companies[i].id === id) c = companies[i]; }
  if (!c) return;
  editingId = id;
  document.getElementById('modal-title').textContent = 'Edit ' + c.company;
  document.getElementById('modal-save-btn').textContent = 'Save Changes';
  document.getElementById('f-company').value = c.company;
  document.getElementById('f-role').value = c.role;
  document.getElementById('f-tier').value = c.tier;
  document.getElementById('f-stage').value = c.stage;
  document.getElementById('f-source').value = c.source;
  document.getElementById('f-url').value = c.url || '';
  document.getElementById('f-contact').value = c.contact || '';
  document.getElementById('f-next').value = c.next || '';
  document.getElementById('f-notes').value = c.notes || '';
  var ldEl = document.getElementById('f-linked-documents');
  if (ldEl) ldEl.value = c.linked_documents || '';
  var jdEl = document.getElementById('f-jd');
  if (jdEl) jdEl.value = c.jd || '';
  document.getElementById('modal').classList.add('open');
};

window.closeModal = function() {
  editingId = null;
  document.getElementById('modal').classList.remove('open');
  var fields = ['f-company','f-role','f-url','f-contact','f-next','f-notes','f-linked-documents','f-jd'];
  for (var i = 0; i < fields.length; i++) { var el = document.getElementById(fields[i]); if(el) el.value = ''; }
  document.getElementById('f-tier').value = 'A';
  document.getElementById('f-stage').value = 'target';
  document.getElementById('f-source').value = 'Network';
};

window.openSettingsModal = function() {
  document.getElementById('settings-provider').value = llmConfig.provider || 'ollama';
  document.getElementById('settings-ollama-model').value = llmConfig.ollamaModel || 'qwen2.5:7b';
  document.getElementById('settings-openrouter-model').value = llmConfig.openRouterModel || 'anthropic/claude-sonnet-4-20250514';

  var updateRows = function() {
    var p = document.getElementById('settings-provider').value;
    document.getElementById('settings-ollama-row').style.display = p === 'ollama' ? 'block' : 'none';
    document.getElementById('settings-openrouter-row').style.display = p === 'openrouter' ? 'block' : 'none';
  };
  document.getElementById('settings-provider').onchange = function() { updateRows(); window.checkOllamaModel(); };
  updateRows();
  window.checkOllamaModel();

  document.getElementById('settings-modal').classList.add('open');
};

window.closeSettingsModal = function() {
  document.getElementById('settings-modal').classList.remove('open');
  var el = document.getElementById('ollama-model-status');
  if (el) el.textContent = '';
};

window.checkOllamaModel = function() {
  var el = document.getElementById('ollama-model-status');
  var model = (document.getElementById('settings-ollama-model').value || '').trim();
  if (!model || document.getElementById('settings-provider').value !== 'ollama') {
    if (el) el.textContent = '';
    return;
  }
  if (el) { el.style.color = 'var(--muted)'; el.textContent = 'Checking...'; }
  fetch('/proxy/ollama/api/tags')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var models = data.models || [];
      var found = false;
      for (var i = 0; i < models.length; i++) {
        if (models[i].name === model || models[i].model === model) { found = true; break; }
      }
      if (el) {
        if (found) {
          el.style.color = 'var(--green)';
          el.textContent = '✓ Model available';
        } else {
          el.style.color = 'var(--red)';
          el.textContent = '✗ Not found — run: ollama pull ' + model;
        }
      }
    })
    .catch(function() {
      if (el) { el.style.color = 'var(--red)'; el.textContent = '✗ Ollama not reachable via proxy'; }
    });
};

window.saveSettings = function() {
  var prov = document.getElementById('settings-provider').value;
  var oMod = document.getElementById('settings-ollama-model').value.trim();
  var orMod = document.getElementById('settings-openrouter-model').value.trim();

  llmConfig.provider = prov;
  llmConfig.ollamaModel = oMod;
  llmConfig.openRouterModel = orMod || 'anthropic/claude-sonnet-4-20250514';

  try { localStorage.setItem('scorer-provider', prov); } catch(e) {}
  try { localStorage.setItem('ollama-model', oMod); } catch(e) {}
  try { localStorage.setItem('openrouter-model', llmConfig.openRouterModel); } catch(e) {}
  closeSettingsModal();
};

window.saveCompany = function() {
  var company = document.getElementById('f-company').value.trim();
  var role = document.getElementById('f-role').value.trim();
  if (!company || !role) { alert('Company and role are required.'); return; }

  var jdEl = document.getElementById('f-jd');
  var savedCompany = null;
  if (editingId !== null) {
    // Update existing
    var c = null;
    for (var i = 0; i < companies.length; i++) { if (companies[i].id === editingId) c = companies[i]; }
    if (c) {
      c.company = company;
      c.role = role;
      c.tier = document.getElementById('f-tier').value;
      c.stage = document.getElementById('f-stage').value;
      c.source = document.getElementById('f-source').value;
      c.url = document.getElementById('f-url').value.trim();
      c.contact = document.getElementById('f-contact').value.trim();
      c.next = document.getElementById('f-next').value.trim();
      c.notes = document.getElementById('f-notes').value.trim();
      var ldEl = document.getElementById('f-linked-documents');
      c.linked_documents = ldEl ? ldEl.value.trim() : '';
      c.jd = jdEl ? jdEl.value.trim() : '';
      if (!c.activity) c.activity = [];
      c.activity.unshift({ date: window.todayLabel(), text: 'Updated details' });
      savedCompany = c;
    }
  } else {
    var ldEl = document.getElementById('f-linked-documents');
    savedCompany = window.createCompanyRecord({
      company: company, role: role,
      tier: document.getElementById('f-tier').value,
      stage: document.getElementById('f-stage').value,
      source: document.getElementById('f-source').value,
      url: document.getElementById('f-url').value.trim(),
      contact: document.getElementById('f-contact').value.trim(),
      next: document.getElementById('f-next').value.trim(),
      notes: document.getElementById('f-notes').value.trim(),
      linked_documents: ldEl ? ldEl.value.trim() : '',
      jd: jdEl ? jdEl.value.trim() : ''
    }, nextId++, window.todayStr(), window.todayLabel());
    companies.push(savedCompany);
  }

  window.closeModal();
  window.saveToStorage(); // Still call this for nextId
  if (savedCompany) window.syncCompanyToDb(savedCompany);
  window.render();
  if (editingId !== null) window.selectCompany(editingId);
};

// ── LLM CONFIG ─────────────────────────────────────────────────────

var llmConfig = { provider: 'ollama', ollamaModel: 'qwen2.5:7b', openRouterModel: 'anthropic/claude-sonnet-4-20250514' };

window.loadLlmConfig = function() {
  try {
    var p = localStorage.getItem('scorer-provider');
    var o = localStorage.getItem('ollama-model');
    var or = localStorage.getItem('openrouter-model');
    if (p) llmConfig.provider = p;
    if (o) llmConfig.ollamaModel = o;
    if (or) llmConfig.openRouterModel = or;
  } catch(e) {}
  return Promise.resolve();
};

function processOllamaLines(lines, state, onToken) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (state.loggedLines < 5) { console.log('[callLlm] raw line:', JSON.stringify(line)); state.loggedLines++; }
    try {
      const result = window.parseOllamaSseLine(line);
      if (result) {
        if (result.delta) state.fullText += result.delta;
        if (result.delta || result.reasoning) { state.tokenCount++; if (onToken) onToken(state.tokenCount); }
      }
    } catch(e) {
      console.warn('[callLlm] parse error:', e.message, 'line:', JSON.stringify(line));
    }
  }
}

function callOllama(system, user, onToken) {
  return fetch('/proxy/ollama/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: llmConfig.ollamaModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: true, think: false })
  }).then(function(res) {
    if (!res.ok) { return res.text().then(function(t) { throw new Error('Ollama error: ' + t); }); }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const state = { fullText: '', buffer: '', tokenCount: 0, loggedLines: 0 };
    function read() {
      return reader.read().then(function(chunk) {
        if (chunk.done) {
          console.log('[callLlm] stream done. tokens:', state.tokenCount, 'fullText length:', state.fullText.length);
          return state.fullText;
        }
        state.buffer += decoder.decode(chunk.value, { stream: true });
        const lines = state.buffer.split('\n');
        state.buffer = lines.pop();
        processOllamaLines(lines, state, onToken);
        return read();
      });
    }
    return read();
  });
}

function callOpenRouter(system, user, onToken) {
  return fetch('/proxy/openrouter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: llmConfig.openRouterModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: true
    })
  }).then(function(res) {
    if (!res.ok) { return res.text().then(function(t) { throw new Error('OpenRouter error: ' + t); }); }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const state = { fullText: '', buffer: '', tokenCount: 0, loggedLines: 0 };
    function read() {
      return reader.read().then(function(chunk) {
        if (chunk.done) {
          console.log('[callLlm] OpenRouter stream done. tokens:', state.tokenCount, 'fullText length:', state.fullText.length);
          return state.fullText;
        }
        state.buffer += decoder.decode(chunk.value, { stream: true });
        const lines = state.buffer.split('\n');
        state.buffer = lines.pop();
        processOllamaLines(lines, state, onToken);
        return read();
      });
    }
    return read();
  });
}

function callAnthropic(system, user) {
  return fetch('/proxy/anthropic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      system: system,
      messages: [{ role: 'user', content: user }]
    })
  }).then(function(res) { return res.json(); }).then(function(data) {
    if (!data.content) {
      const msg = (data.error && data.error.message) ? data.error.message : 'Unknown error from Anthropic API';
      throw new Error('Anthropic API error: ' + msg + '. Ensure ANTHROPIC_API_KEY is set in .env and restart the server.');
    }
    let text = '';
    for (let i = 0; i < data.content.length; i++) {
      if (data.content[i].type === 'text') text += data.content[i].text;
    }
    return text;
  });
}

window.callLlm = function(system, user, onToken) {
  if (llmConfig.provider === 'ollama') return callOllama(system, user, onToken);
  if (llmConfig.provider === 'openrouter') return callOpenRouter(system, user, onToken);
  return callAnthropic(system, user);
};

// ── URL IMPORT ─────────────────────────────────────────────────────

window.fetchJobFromUrl = function(url) {
  return fetch('/proxy/tavily', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [url], extract_depth: 'advanced' })
  }).then(function(res) {
    if (res.status === 503) throw new Error('Tavily not configured on server. Add TAVILY_API_KEY to .env and restart.');
    if (!res.ok) throw new Error('Tavily fetch failed (' + res.status + ')');
    return res.json();
  }).then(function(data) {
    if (data.results && data.results[0] && data.results[0].raw_content) {
      return data.results[0].raw_content;
    }
    // Tavily returned no content — fall back to Jina Reader
    console.log('[fetchJobFromUrl] Tavily returned no content, trying Jina Reader fallback for:', url);
    return fetch('/proxy/jina-reader', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    }).then(function(res) {
      if (!res.ok) throw new Error('Jina Reader failed (' + res.status + ')');
      return res.text();
    }).then(function(content) {
      if (!content || content.trim().length < 100) {
        throw new Error('No content returned from Tavily or Jina Reader. Try pasting the job description directly.');
      }
      return content;
    });
  });
};

window.stripJdGuff = function(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // markdown images: ![alt](url)
    .replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/g, '$1')  // markdown links: [text](url) → text
    .replace(/[ \t]+$/gm, '')               // trailing whitespace on each line
    .replace(/\n{3,}/g, '\n\n')             // collapse 3+ blank lines to 2
    .trim();
};

window.extractJobData = function(content, onToken) {
  var truncated = content.length > 8000 ? content.substring(0, 8000) : content;
  console.log('[extractJobData] content chars:', content.length, '→ sending:', truncated.length);

  var system = 'Extract job details from the following content. Return ONLY a valid JSON object with exactly these fields: company_name, job_title, contact_name. ' +
    'contact_name: name of the recruiter or hiring manager visible in the posting (null if not found). ' +
    'No markdown, no preamble, no explanation.';
  var user = 'Extract job details from this job posting:\n\n' + truncated;
  return window.callLlm(system, user, onToken).then(function(text) {
    console.log('[extractJobData] raw response:', JSON.stringify(text));
    try {
      var parsed = window.parseJsonResponse(text);
      console.log('[extractJobData] parsed:', JSON.stringify(parsed));
      return parsed;
    } catch(e) {
      console.error('[extractJobData] JSON parse error. Raw text:', text);
      throw new Error('Extraction failed: The model outputted text that wasn\'t valid JSON. Try a smaller model or paste manually.');
    }
  });
};

function setField(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function fillContactIfEmpty(name) {
  const el = document.getElementById('f-contact');
  if (el && !el.value) el.value = name;
}

function fillJdField(rawContent) {
  const jdEl = document.getElementById('f-jd');
  if (!jdEl || !rawContent) return;
  const jdText = window.stripJdGuff(rawContent);
  jdEl.value = jdText.length > 12000 ? jdText.substring(0, 12000) : jdText;
}

function applyExtractedFields(extracted) {
  if (extracted.company_name) setField('f-company', extracted.company_name);
  if (extracted.job_title) setField('f-role', extracted.job_title);
  if (extracted.contact_name) fillContactIfEmpty(extracted.contact_name);
}

function fillExtractedFields(extracted, url, rawContent) {
  if (extracted) applyExtractedFields(extracted);
  if (url.indexOf('linkedin.com') !== -1) setField('f-source', 'LinkedIn');
  fillJdField(rawContent);
}

var _NOOP = { textContent: '', style: { display: '' } };

function elOrNoop(id) { return document.getElementById(id) || _NOOP; }

function fieldVal(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

window.fetchAndFill = function() {
  const urlInput = document.getElementById('f-url');
  if (!urlInput || !urlInput.value.trim()) return Promise.resolve();
  const url = urlInput.value.trim();

  const btn = elOrNoop('fetch-btn');
  const tok = elOrNoop('fetch-tokens');
  const origText = btn.textContent || 'Fetch';
  btn.textContent = 'Fetching...';
  tok.style.display = 'none'; tok.textContent = '';

  let tokensFired = 0;
  let rawContent = '';

  return window.fetchJobFromUrl(url).then(function(content) {
    rawContent = content;
    btn.textContent = 'Extracting...';
    tok.style.display = 'block'; tok.textContent = 'Extracting — 0 tokens';
    return window.extractJobData(content, function(count) {
      tokensFired = count;
      tok.textContent = 'Extracting — ' + count + ' tokens';
    });
  }).then(function(extracted) {
    fillExtractedFields(extracted, url, rawContent);
    btn.textContent = origText;
    tok.style.display = tokensFired > 0 ? 'block' : 'none';
    if (tokensFired > 0) tok.textContent = 'Done — ' + tokensFired + ' tokens';
  }).catch(function(err) {
    console.error('fetchAndFill error:', err);
    btn.textContent = origText;
    tok.style.display = 'none';
    alert(err.message || 'Failed to fetch the URL. Please paste the job description manually.');
  });
};

window.addAndScore = function() {
  var company = document.getElementById('f-company').value.trim();
  var role = document.getElementById('f-role').value.trim();
  if (!company || !role) { alert('Company and role are required.'); return Promise.resolve(); }
  var jd = fieldVal('f-jd');
  var urlVal = document.getElementById('f-url').value.trim();
  var id = nextId++;
  var newRecord = window.createCompanyRecord({
    company: company, role: role,
    tier: document.getElementById('f-tier').value,
    stage: document.getElementById('f-stage').value,
    source: document.getElementById('f-source').value,
    url: urlVal,
    contact: document.getElementById('f-contact').value.trim(),
    next: document.getElementById('f-next').value.trim(),
    notes: document.getElementById('f-notes').value.trim(),
    linked_documents: fieldVal('f-linked-documents'),
    jd: jd
  }, id, window.todayStr(), window.todayLabel());
  
  companies.push(newRecord);
  window.saveToStorage();
  window.syncCompanyToDb(newRecord);
  window.render();
  window.closeModal();
  var params = 'companyId=' + id + '&company=' + encodeURIComponent(company);
  if (urlVal) params += '&url=' + encodeURIComponent(urlVal);
  try { localStorage.setItem('pending-jd', jd); } catch(e) {}
  window.open('scorer.html?' + params);
  return Promise.resolve();
};

// ── SCORER INTEGRATION ────────────────────────────────────────────

function buildDimensionCard(d) {
  const c = scoreColor(d.score);
  return `<div style="background:var(--surface2);padding:0.4rem 0.6rem;border-radius:4px;border:1px solid var(--border)">` +
    `<div style="font-family:var(--mono);font-size:0.55rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.2rem">${window.esc(d.name)}</div>` +
    `<div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-weight:600;font-size:0.85rem;color:${c}">${d.score}</span><span style="font-size:0.55rem;color:var(--dim)">${d.weight}</span></div></div>`;
}

function buildDimensionBreakdownHtml(dimensions) {
  if (!dimensions || dimensions.length === 0) return '';
  return '<div style="margin-top:1rem;display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:1rem">' +
    dimensions.map(buildDimensionCard).join('') + '</div>';
}

function buildDiscoveryItemsHtml(items) {
  if (!items || items.length === 0) return '';
  let html = '<div style="margin-top:0.75rem">' +
    '<div style="font-family:var(--mono);font-size:0.55rem;color:var(--accent2);text-transform:uppercase;margin-bottom:0.4rem;letter-spacing:0.05em">Needs Discovery</div>';
  for (let j = 0; j < items.length; j++) {
    html += `<div style="font-size:0.72rem;color:var(--dim);margin-bottom:0.3rem;display:flex;gap:0.4rem"><span>•</span><span>${window.esc(items[j])}</span></div>`;
  }
  html += '</div>';
  return html;
}

function extractOverall(score) {
  if (!score) return null;
  return score.overall !== undefined ? score.overall : score.overall_score;
}

function scoreColor(n) {
  if (n >= 7) return 'var(--green)';
  if (n >= 5) return 'var(--accent2)';
  return 'var(--red)';
}

function buildScoreHeaderHtml(overall, score) {
  const scColor = scoreColor(overall);
  const hardNoTag = score.hard_nos_pass === false
    ? '<span style="font-family:var(--mono);font-size:0.58rem;color:var(--red);margin-left:0.8rem;background:rgba(232,91,91,0.1);padding:0.1rem 0.4rem;border-radius:2px">Hard no triggered</span>'
    : '';
  return `<div style="display:flex;align-items:baseline;gap:0.25rem;margin-bottom:0.4rem"><span style="font-family:var(--serif);font-size:2rem;line-height:1;color:${scColor}">${overall}</span><span style="font-family:var(--mono);font-size:0.65rem;color:var(--muted)">/10</span>${hardNoTag}</div>` +
    `<div style="font-size:0.78rem;color:var(--text);font-weight:500;margin-bottom:0.75rem;line-height:1.4">${window.esc(score.verdict || score.overall_verdict || '')}</div>`;
}

window.showScoreInPanel = function(score) {
  const section = document.getElementById('dp-score-section');
  const el = document.getElementById('dp-score');
  if (!section || !el) return;

  const overall = extractOverall(score);
  if (overall == null) { section.style.display = 'none'; return; }

  let html = buildScoreHeaderHtml(overall, score);
  html += buildDimensionBreakdownHtml(score.dimensions);
  html += buildDiscoveryItemsHtml(score.discovery_items);
  html += `<div style="font-family:var(--mono);font-size:0.55rem;color:var(--muted);margin-top:1rem;border-top:1px solid var(--border);padding-top:0.5rem">Scored ${window.esc(score.scored_at || 'Recently')}</div>`;

  el.innerHTML = html;
  section.style.display = 'block';
};

function extractScoreValue(score) {
  return score && (score.overall || score.overall_score);
}

function applyStoredScore(c) {
  const scoreKey = 'score-' + c.id;
  try {
    const ls = localStorage.getItem(scoreKey);
    if (!ls) return false;
    const score = JSON.parse(ls);
    const val = extractScoreValue(score);
    if (!val) return false;
    c.score = score;
    c.score.overall = val;
    if (score.jd) c.jd = score.jd;
    c.tier = window.scoreTier(val);
    localStorage.removeItem(scoreKey);
    console.log('[Pipeline] Applied localStorage score for ID:', c.id);
    return true;
  } catch(e) {
    console.warn('Score check failed', e);
    return false;
  }
}

function refreshAfterScoreChange() {
  window.saveToStorage();
  window.render();
  if (!selectedId) return;
  const sel = companies.find(c => c.id == selectedId);
  if (sel) window.showScoreInPanel(sel.score);
}

window.checkForAllScores = function() {
  if (!isLoaded || companies.length === 0) return;
  let changed = false;
  let processed = 0;
  const total = companies.length;

  function finish(changedCompany) {
    processed++;
    if (changedCompany) { window.syncCompanyToDb(changedCompany); changed = true; }
    if (processed === total && changed) refreshAfterScoreChange();
  }

  companies.forEach(function(c) {
    if (applyStoredScore(c)) { finish(c); } else { finish(null); }
  });
};

window.checkForNewScore = function(id) {
  window.checkForAllScores();
};

var focusReloadTimer = null;
window.addEventListener('focus', function() {
  if (!isLoaded) return;
  clearTimeout(focusReloadTimer);
  focusReloadTimer = setTimeout(function() { window.loadFromStorage(); }, 500);
});

document.addEventListener('keydown', function(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    var input = document.getElementById('global-search');
    if (!input) return;
    e.preventDefault();
    input.focus();
    input.select();
  }
});

function findCompanyById(id) {
  for (var i = 0; i < companies.length; i++) { if (companies[i].id == id) return companies[i]; }
  return null;
}

window.openScorer = function(id) {
  var c = findCompanyById(id);
  if (!c) return;
  var params = 'companyId=' + c.id + '&company=' + encodeURIComponent(c.company);
  if (c.url) params += '&url=' + encodeURIComponent(c.url);

  var targetUrl = 'scorer.html?' + params;
  console.log('[Pipeline] Opening Scorer with URL:', targetUrl);

  try { localStorage.setItem('pending-jd', c.jd || ''); } catch(e) {}
  window.open(targetUrl, '_blank');
};

// ── VIEW SWITCHING ─────────────────────────────────────────────────

function showOnlyView(name) {
  var views = ['kanban','table','funnel'];
  for (var j = 0; j < views.length; j++) {
    var el = document.getElementById('view-' + views[j]);
    if (views[j] !== name) { el.style.display = 'none'; }
    else { el.style.display = name === 'kanban' ? 'flex' : 'block'; }
  }
}

window.switchView = function(name, btn) {
  currentView = name;
  var tabs = document.querySelectorAll('.nav-tab');
  for (var i = 0; i < tabs.length; i++) { tabs[i].classList.remove('active'); }
  btn.classList.add('active');
  showOnlyView(name);
  if (name !== 'kanban') { document.getElementById('detail-panel').classList.remove('open'); }
};

// ── INIT ───────────────────────────────────────────────────────────

window.loadFromStorage();
window.loadLlmConfig();
