// Role-evaluation scorer application logic.
// Plain non-module script: top-level var/function declarations attach to window
// so inline onclick handlers can reach them. Loaded from scorer.html.
var PROFILE_STORAGE_KEY = 'eval-profile';
var PROVIDER_STORAGE_KEY = 'scorer-provider';
var OLLAMA_MODEL_STORAGE_KEY = 'ollama-model';
var OPENROUTER_MODEL_STORAGE_KEY = 'openrouter-model';

window.esc = function(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
};

var currentCompanyId = null;
var currentProvider = 'ollama';
var currentOllamaModel = 'qwen2.5:7b';
var currentOpenRouterModel = 'anthropic/claude-sonnet-4-20250514';

// Default profile embedded — overridden if user has saved a custom one
var DEFAULT_PROFILE = "# Offer Evaluation Profile \u2014 Terry McCarthy\n\n_Captured 2026-04-30._\n\n## Top-line orientation\n\n- **Primary driver:** Lifestyle & balance\n- **Time horizon:** Stepping stone \u2014 next role should set me up for VP Eng / CTO within 2\u20133 years\n- **Geography:** Sydney-based or fully remote \u2014 no relocation\n- **Hybrid stance:** Open to up to 3 days office; 5-day RTO is a hard no\n\n## Compensation\n\n- **TC floor:** AUD $250k\u2013$300k (base + super + cash bonus)\n- **Cash-first.** Strong preference for high base over equity\n- **Sceptical of bonuses** \u2014 discount STI/LTI heavily\n- **Benefits that move the needle:** L&D / conference budget, generous leave\n\n## Role & scope\n\n- **Org size:** Multi-squad \u2014 15\u201340 engineers (Head of level)\n- **Time mix:** People leadership + strategy/roadmap. Not seeking hands-on coding.\n- **Domain:** Agnostic\n- **Reporting line:** Report to CTO\n\n## Company fit\n\n- **Stage:** Series B\u2013C scaleup\n- **Size:** 50\u20131,000 employees\n- **Industries (in preference order):** Healthcare / climate / impact, AI/ML-native, B2B SaaS\n- **Cultural must-haves:** High-trust low-politics, strong engineering craft, wellbeing & sustainability\n\n## Lifestyle constraints\n\n- **Office cadence:** Up to 3 days/week\n- **Commute:** 30\u201345 min one-way max\n- **Sustainable hours:** ~40 hrs/week\n- **Travel:** Minimal only \u2014 1\u20132 trips/year max\n\n## Manager, peers, growth\n\n- **Manager (CTO) attributes:** Trust + autonomy, strong technical depth, career coach\n- **Peers:** Critical \u2014 want strong engineering peers\n- **Growth wanted:** Path to VP / CTO + funded executive coaching\n\n## Hard nos\n\n- Crypto, gambling, adult, or weapons industries\n- Hero / burnout culture\n- 5-day in-office mandate\n- Founder/CEO red flags (toxic behaviour, bullying)\n\n## Scoring weights\n\n| Dimension | Weight |\n|---|---|\n| Lifestyle (hybrid, hours, commute, travel) | 25% |\n| Compensation (base, total cash, benefits) | 20% |\n| Scope & growth path (size, level, VP/CTO trajectory) | 20% |\n| People (manager fit, peer strength) | 20% |\n| Company & mission (stage, industry, culture, runway) | 15% |\n\n## Tensions to surface\n\n- Lifestyle-first vs stepping-stone ambition\n- Cash-first vs scaleup equity norms\n- Multi-squad scope vs actual org chart depth";

var currentProfile = DEFAULT_PROFILE;

// ── STORAGE ─────────────────────────────────────────────────────

window.loadProfile = function() {
  fetch('/api/profile')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.content) currentProfile = data.content;
      window.renderProfileBar();
    })
    .catch(function() {
      try {
        var saved = localStorage.getItem(PROFILE_STORAGE_KEY);
        if (saved) currentProfile = saved;
      } catch(e) {}
      window.renderProfileBar();
    });
};

// ── API KEY ──────────────────────────────────────────────────────

window.openSettingsModal = function() {
  document.getElementById('settings-provider').value = currentProvider;
  document.getElementById('settings-ollama-model').value = currentOllamaModel;
  document.getElementById('settings-openrouter-model').value = currentOpenRouterModel;

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
  var p = document.getElementById('settings-provider').value;
  var o = document.getElementById('settings-ollama-model').value.trim();
  var or = document.getElementById('settings-openrouter-model').value.trim();

  currentProvider = p;
  currentOllamaModel = o || 'qwen2.5:7b';
  currentOpenRouterModel = or || 'anthropic/claude-sonnet-4-20250514';

  try { localStorage.setItem(PROVIDER_STORAGE_KEY, currentProvider); } catch(e) {}
  try { localStorage.setItem(OLLAMA_MODEL_STORAGE_KEY, currentOllamaModel); } catch(e) {}
  try { localStorage.setItem(OPENROUTER_MODEL_STORAGE_KEY, currentOpenRouterModel); } catch(e) {}
  window.renderConfigLabel();
  window.closeSettingsModal();
};

window.renderConfigLabel = function() {
  var el = document.getElementById('active-config-label');
  if (!el) return;
  var label;
  if (currentProvider === 'ollama') label = 'Ollama: ' + currentOllamaModel;
  else if (currentProvider === 'openrouter') label = 'OpenRouter: ' + currentOpenRouterModel;
  else label = 'Anthropic (Claude)';
  el.textContent = label;
};

// ── PROVIDER + MODEL ─────────────────────────────────────────────

window.loadProvider = function() {
  try {
    var p = localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (p) currentProvider = p;
  } catch(e) {}
  window.renderConfigLabel();
  return Promise.resolve();
};

window.loadOpenRouterModel = function() {
  try {
    var m = localStorage.getItem(OPENROUTER_MODEL_STORAGE_KEY);
    if (m) currentOpenRouterModel = m;
  } catch(e) {}
  window.renderConfigLabel();
};

window.loadOllamaModel = function() {
  try {
    var m = localStorage.getItem(OLLAMA_MODEL_STORAGE_KEY);
    if (m) currentOllamaModel = m;
  } catch(e) {}
  window.renderConfigLabel();
  return Promise.resolve();
};

// ── SCORE STORAGE ────────────────────────────────────────────────

window.saveScoreToStorage = function(r) {
  if (currentCompanyId === null) return;
  
  var score = JSON.parse(JSON.stringify(r));
  score.overall = r.overall_score;
  score.verdict = r.overall_verdict;
  score.scored_at = new Date().toISOString().slice(0, 10);
  
  var jdInput = document.getElementById('jd-input');
  if (jdInput) score.jd = jdInput.value.trim();
  
  console.log('[Scorer] Saving score to SQLite for company ID:', currentCompanyId);
  
  fetch('/api/save-score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: currentCompanyId, score: score })
  }).then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.success) {
        console.log('[Scorer] Score saved to SQLite successfully');
      } else {
        console.error('[Scorer] SQLite save failed:', data.error);
        // Fallback to localStorage just in case
        localStorage.setItem('score-' + currentCompanyId, JSON.stringify(score));
      }
    }).catch(function(err) {
      console.error('[Scorer] API call failed:', err);
      localStorage.setItem('score-' + currentCompanyId, JSON.stringify(score));
    });
};

// ── PROFILE BAR ─────────────────────────────────────────────────

window.renderProfileBar = function() {
  // Extract name from first heading
  var nameMatch = currentProfile.match(/# Offer Evaluation Profile[^\\n]*/);
  var name = nameMatch ? nameMatch[0].replace(/^# /, '').replace(/ \u2014 /, ' - ') : 'Custom Profile';
  document.getElementById('profile-name').textContent = name;

  var weightsEl = document.getElementById('profile-weights');
  var weights = window.parseProfileWeights(currentProfile);
  var chips = '';
  for (var i = 0; i < weights.length; i++) {
    chips += '<span class="weight-chip">' + window.esc(weights[i].dim) + ' ' + window.esc(weights[i].weight) + '</span>';
  }
  weightsEl.innerHTML = chips;
};

// ── PROFILE EDITOR ──────────────────────────────────────────────

window.openProfileEditor = function() {
  document.getElementById('profile-editor').value = currentProfile;
  document.getElementById('profile-modal').classList.add('open');
};

window.closeProfileEditor = function() {
  document.getElementById('profile-modal').classList.remove('open');
};

window.saveProfile = function() {
  var val = document.getElementById('profile-editor').value;
  if (!val.trim()) return;
  currentProfile = val;
  fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: val })
  }).then(function(r) {
    if (!r.ok) { try { localStorage.setItem(PROFILE_STORAGE_KEY, val); } catch(e) {} }
  }).catch(function() {
    try { localStorage.setItem(PROFILE_STORAGE_KEY, val); } catch(e) {}
  });
  window.renderProfileBar();
  window.closeProfileEditor();
};

// ── SCORING ─────────────────────────────────────────────────────

window.buildPrompts = function(jdText, company, url) {
  return window.buildScoringPrompts(currentProfile, jdText, company, url);
};

window.fetchAnthropic = function(prompts) {
  return fetch('/proxy/anthropic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: prompts.system,
      messages: [{ role: 'user', content: prompts.user }]
    })
  }).then(function(res) { return res.json(); }).then(function(data) {
    if (!data.content) {
      var msg = (data.error && data.error.message) ? data.error.message : 'Unknown error from Anthropic API';
      throw new Error('Anthropic API error: ' + msg + '. Ensure ANTHROPIC_API_KEY is set in .env and restart the server.');
    }
    var text = '';
    for (var i = 0; i < data.content.length; i++) {
      if (data.content[i].type === 'text') text += data.content[i].text;
    }
    return text;
  });
};

window.fetchOpenRouter = function(prompts) {
  var tokensEl = document.getElementById('loading-tokens');
  var textEl = document.getElementById('loading-text');
  if (textEl) textEl.textContent = 'Generating with ' + currentOpenRouterModel + '...';

  return fetch('/proxy/openrouter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: currentOpenRouterModel,
      messages: [
        { role: 'system', content: prompts.system },
        { role: 'user', content: prompts.user }
      ],
      stream: true,
      max_tokens: 2664,
      response_format: { type: 'json_object' }
    })
  }).then(function(res) {
    if (!res.ok) { return res.text().then(function(t) { throw new Error('OpenRouter error: ' + t); }); }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var fullText = '';
    var tokenCount = 0;
    var buffer = '';
    var lastActivity = Date.now();
    var FETCH_TIMEOUT_MS = 120000;

    function read() {
      return reader.read().then(function(chunk) {
        if (chunk.done) return fullText;

        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop();

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.indexOf('data: ') !== 0) continue;
          var raw = line.slice(6);
          if (raw === '[DONE]') continue;
          try {
            var parsed = JSON.parse(raw);
            if (parsed.error) {
              throw new Error('OpenRouter error: ' + (parsed.error.message || JSON.stringify(parsed.error)));
            }
            var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
            if (delta) {
              fullText += delta;
              tokenCount++;
              lastActivity = Date.now();
            }
            if (tokensEl && tokenCount % 5 === 0) {
              tokensEl.textContent = tokenCount + ' tokens';
            }
          } catch(e) {
            if (e.message && e.message.indexOf('OpenRouter error') === 0) throw e;
          }
        }

        if (Date.now() - lastActivity > FETCH_TIMEOUT_MS) {
          throw new Error('OpenRouter stream timed out — no tokens received for ' + (FETCH_TIMEOUT_MS/1000) + 's.');
        }
        return read();
      });
    }
    return read();
  });
};

window.fetchOllama = function(prompts) {
  var tokensEl = document.getElementById('loading-tokens');
  var textEl = document.getElementById('loading-text');
  if (textEl) textEl.textContent = 'Generating with ' + currentOllamaModel + '...';

  return fetch('/proxy/ollama/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: currentOllamaModel,
      messages: [
        { role: 'system', content: prompts.system },
        { role: 'user', content: prompts.user }
      ],
      stream: true,
      max_tokens: 8192,
      response_format: { type: 'json_object' }
    })
  }).then(function(res) {
    if (!res.ok) { return res.text().then(function(t) { throw new Error('Ollama error: ' + t); }); }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var fullText = '';
    var tokenCount = 0;
    var buffer = '';
    var lastActivity = Date.now();
    var FETCH_TIMEOUT_MS = 120000; // 2 min without any token = bail

    function read() {
      return reader.read().then(function(chunk) {
        if (chunk.done) return fullText;

        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.indexOf('data: ') !== 0) continue;
          var raw = line.slice(6);
          if (raw === '[DONE]') continue;
          try {
            var parsed = JSON.parse(raw);
            var delta = parsed.choices[0].delta.content;
            var reasoning = parsed.choices[0].delta.reasoning;
            if (delta) {
              fullText += delta;
              tokenCount++;
              lastActivity = Date.now();
            } else if (reasoning) {
              // Still making progress — count reasoning tokens for UI feedback
              tokenCount++;
              lastActivity = Date.now();
            }
            if (tokensEl && tokenCount % 5 === 0) {
              tokensEl.textContent = tokenCount + ' tokens' + (delta ? '' : ' (thinking...)');
            }
          } catch(e) { /* incomplete JSON chunk, skip */ }
        }

        // Check timeout
        if (Date.now() - lastActivity > FETCH_TIMEOUT_MS) {
          console.error('[Scorer] Ollama stream timed out after ' + (FETCH_TIMEOUT_MS/1000) + 's — no tokens received');
          fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              level: 'ERROR',
              message: 'Ollama stream timeout model=' + currentOllamaModel + ' tokens=' + tokenCount + ' received=' + fullText.length + ' chars'
            })
          });
          throw new Error('Ollama stream timed out — no tokens received for ' + (FETCH_TIMEOUT_MS/1000) + 's. Check pipeline.log and verify model "' + currentOllamaModel + '" exists.');
        }

        return read();
      });
    }

    return read();
  });
};

window.scoreRole = function() {
  var jdText = document.getElementById('jd-input').value.trim();
  if (!jdText) { alert('Please paste a job description.'); return; }

  var company = document.getElementById('jd-company').value.trim();
  var url = document.getElementById('jd-url').value.trim();
  var prompts = window.buildPrompts(jdText, company, url);

  document.getElementById('loading').style.display = 'block';
  document.getElementById('results').style.display = 'none';
  document.getElementById('score-btn').disabled = true;

  var fetchFn;
  if (currentProvider === 'ollama') fetchFn = window.fetchOllama;
  else if (currentProvider === 'openrouter') fetchFn = window.fetchOpenRouter;
  else fetchFn = window.fetchAnthropic;

  var rawLlmText = '';
  return fetchFn(prompts).then(function(text) {
    rawLlmText = text;
    var result = window.parseJsonResponse(text);
    window.renderResults(result);
  }).catch(function(err) {
    console.error('Scoring error [provider=' + currentProvider + ']: ' + (err && err.message ? err.message : String(err)));
    if (rawLlmText) console.error('Scoring error — raw LLM output:', rawLlmText.substring(0, 500));
    var hint = 'Check the console for details.';
    if (currentProvider === 'ollama') hint = 'Is Ollama running? Check http://localhost:11434';
    else if (currentProvider === 'openrouter') hint = 'Ensure OPENROUTER_API_KEY is set in .env and the model name is valid.';
    alert('Scoring failed. ' + hint);
  }).finally(function() {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('score-btn').disabled = false;
    var tokensEl = document.getElementById('loading-tokens');
    var textEl = document.getElementById('loading-text');
    if (tokensEl) tokensEl.textContent = '';
    if (textEl) textEl.textContent = 'Scoring against your evaluation profile...';
  });
};

// ── RENDER RESULTS ──────────────────────────────────────────────

window.renderResults = function(r) {
  var results = document.getElementById('results');
  results.style.display = 'block';

  // Clamp model scores to valid range 1-10 (model sometimes outputs >10)
  function clampScore(n) {
    n = parseInt(n, 10);
    if (isNaN(n)) return 5;
    if (n < 1) return 1;
    if (n > 10) return 10;
    return n;
  }

  // Calculate weighted average overall score to ensure accuracy
  var calculatedScore = 0;
  var totalWeight = 0;
  var dims = r.dimensions || [];
  for (var i = 0; i < dims.length; i++) {
    var d = dims[i];
    d.score = clampScore(d.score);
    var weightPercent = parseInt(d.weight || '0', 10);
    calculatedScore += d.score * (weightPercent / 100);
    totalWeight += weightPercent;
  }
  
  // If weights don't sum to 100, normalize the score
  if (totalWeight > 0 && totalWeight !== 100) {
    calculatedScore = (calculatedScore / totalWeight) * 100;
  }
  
  // Update r.overall_score with the more accurate calculated value
  r.overall_score = Math.round(calculatedScore);
  if (r.overall_score > 10) r.overall_score = 10;
  if (r.overall_score < 1) r.overall_score = 1;

  // Overall score rendering
  var overallBox = document.getElementById('overall-box');
  var scoreClass = r.overall_score >= 7 ? 'score-high' : r.overall_score >= 5 ? 'score-mid' : 'score-low';
  overallBox.className = 'overall-score ' + scoreClass;
  document.getElementById('overall-score').textContent = r.overall_score + '/10';
  document.getElementById('overall-verdict').textContent = r.overall_verdict || '';

  // Hard nos
  var hBox = document.getElementById('hard-nos-box');
  hBox.className = 'hard-nos-result ' + (r.hard_nos_pass ? 'pass' : 'fail');
  document.getElementById('hard-nos-title').textContent = r.hard_nos_pass ? 'Hard Nos: All Clear' : 'Hard No Triggered';
  document.getElementById('hard-nos-detail').textContent = r.hard_nos_detail || '';

  // Dimensions
  var dimsHTML = '';
  var dims = r.dimensions || [];
  for (var i = 0; i < dims.length; i++) {
    var d = dims[i];
    var dClass = d.score >= 7 ? 'high' : d.score >= 5 ? 'mid' : 'low';
    dimsHTML += '<div class="dim-card">' +
      '<div class="dim-left"><div class="dim-header"><span class="dim-name">' + window.esc(d.name) + '</span><span class="dim-weight">' + window.esc(d.weight) + '</span></div>' +
      '<div class="dim-detail">' + window.esc(d.detail) + '</div></div>' +
      '<div class="dim-right"><div class="dim-score ' + dClass + '">' + d.score + '</div><div class="dim-max">/10</div></div>' +
    '</div>';
  }
  document.getElementById('dimensions').innerHTML = dimsHTML;

  // Tensions
  var tensions = r.tensions || [];
  if (tensions.length > 0) {
    document.getElementById('tensions-box').style.display = 'block';
    var tHTML = '';
    for (var j = 0; j < tensions.length; j++) {
      tHTML += '<div class="tension-item">' + window.esc(tensions[j]) + '</div>';
    }
    document.getElementById('tensions-list').innerHTML = tHTML;
  } else {
    document.getElementById('tensions-box').style.display = 'none';
  }

  // Discovery items
  var disc = r.discovery_items || [];
  if (disc.length > 0) {
    document.getElementById('discovery-box').style.display = 'block';
    var dHTML = '';
    for (var k = 0; k < disc.length; k++) {
      dHTML += '<div class="discovery-item">' + window.esc(disc[k]) + '</div>';
    }
    document.getElementById('discovery-list').innerHTML = dHTML;
  } else {
    document.getElementById('discovery-box').style.display = 'none';
  }

  // Scroll to results
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Persist score back to pipeline if opened from there
  window.saveScoreToStorage(r);
};

// ── PENDING JD ──────────────────────────────────────────────────

window.readPendingJd = function() {
  try {
    var jd = localStorage.getItem('pending-jd');
    if (jd) {
      var jdInput = document.getElementById('jd-input');
      if (jdInput) jdInput.value = jd;
      localStorage.removeItem('pending-jd');
    }
  } catch(e) {}
  return Promise.resolve();
};

// ── QUERY PARAMS ────────────────────────────────────────────────

window.readQueryParams = function() {
  var params = new URLSearchParams(window.location.search);
  var company = params.get('company');
  var url = params.get('url');
  var companyId = params.get('companyId');
  
  console.log('[Scorer] Full URL:', window.location.href);
  console.log('[Scorer] URL Params - companyId:', companyId, 'company:', company);

  if (company) document.getElementById('jd-company').value = company;
  if (url) document.getElementById('jd-url').value = url;
  if (companyId) {
    currentCompanyId = parseInt(companyId, 10);
    console.log('[Scorer] Set currentCompanyId to:', currentCompanyId);
  }
};

// ── INIT ────────────────────────────────────────────────────────
window.loadProfile();
window.loadProvider();
window.loadOllamaModel();
window.loadOpenRouterModel();
window.readQueryParams();
window.readPendingJd();
