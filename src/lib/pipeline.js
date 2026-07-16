(function() {
  var STAGE_IDS = ['target', 'warm', 'screen', 'interview', 'offer', 'closed'];

  // Real funnel stages only — 'closed' is a terminal status, not a rung on this ladder.
  var REAL_STAGE_ORDER = ['target', 'warm', 'screen', 'interview', 'offer'];

  // Tracks the peak stage ever reached, live — never regresses, and ignores
  // 'closed' as a candidate since closing isn't itself a stage to credit.
  function bumpFurthestStage(current, candidate) {
    var candidateRank = REAL_STAGE_ORDER.indexOf(candidate);
    if (candidateRank === -1) return current || null;
    var currentRank = current ? REAL_STAGE_ORDER.indexOf(current) : -1;
    return candidateRank > currentRank ? candidate : current;
  }

  /**
   * Maps a numeric overall score (1-10) to a tier label.
   * Single source of truth — used by both the DB layer and the frontend.
   */
  function scoreTier(val) {
    if (val >= 8) return 'A';
    if (val >= 6) return 'B';
    if (val >= 4) return 'C';
    return 'D';
  }

  function createCompanyRecord(fields, id, todayStr, todayLabel) {
    return {
      id: id,
      company: fields.company,
      role: fields.role,
      tier: fields.tier,
      stage: fields.stage,
      source: fields.source,
      url: fields.url || '',
      contact: fields.contact || '',
      next: fields.next || '',
      notes: fields.notes || '',
      culture_notes: fields.culture_notes || '',
      linked_documents: fields.linked_documents || '',
      jd: fields.jd || '',
      added: todayStr,
      score: null,
      furthest_stage: bumpFurthestStage(null, fields.stage),
      activity: [{ date: todayLabel, text: 'Added to pipeline (' + fields.stage + ')' }]
    };
  }

  function computeStageCounts(companies) {
    var counts = {};
    for (var i = 0; i < STAGE_IDS.length; i++) {
      var cnt = 0;
      for (var j = 0; j < companies.length; j++) {
        if (companies[j].stage === STAGE_IDS[i]) cnt++;
      }
      counts[STAGE_IDS[i]] = cnt;
    }
    return counts;
  }

  // Cumulative counts: companies that reached at least each funnel stage.
  // A company in 'interview' also counts toward 'target', 'warm', 'screen'.
  // Closed companies are excluded — they exited the funnel.
  var FUNNEL_IDS = ['target', 'warm', 'screen', 'interview', 'offer'];

  function computeCumulativeCounts(counts) {
    var cumulative = {};
    var running = 0;
    for (var i = FUNNEL_IDS.length - 1; i >= 0; i--) {
      running += counts[FUNNEL_IDS[i]] || 0;
      cumulative[FUNNEL_IDS[i]] = running;
    }
    return cumulative;
  }

  // % of companies from this source that ever advanced past warm-up.
  function computeSourceConversion(companies, source) {
    var total = 0, advanced = 0;
    for (var i = 0; i < companies.length; i++) {
      var c = companies[i];
      if (c.source !== source) continue;
      total++;
      if (c.stage === 'screen' || c.stage === 'interview' || c.stage === 'offer') advanced++;
    }
    return total > 0 ? Math.round(advanced / total * 100) : 0;
  }

  function detectBottleneck(counts) {
    if (counts['target'] > (counts['warm'] || 0) * 2) return 'target_warm';
    if ((counts['warm'] || 0) > (counts['screen'] || 0) * 3) return 'warm_screen';
    return null;
  }

  function computeTierCounts(companies) {
    var tierA = 0, tierB = 0, tierC = 0;
    for (var i = 0; i < companies.length; i++) {
      if (companies[i].tier === 'A') tierA++;
      else if (companies[i].tier === 'B') tierB++;
      else if (companies[i].tier === 'C') tierC++;
    }
    return { tierA: tierA, tierB: tierB, tierC: tierC };
  }

  // Returns pure stats from the companies array — no DOM, no HTML.
  function computeFunnelStats(companies) {
    var counts = computeStageCounts(companies);
    var cumulative = computeCumulativeCounts(counts);
    var tiers = computeTierCounts(companies);
    var screenCount = (counts['screen'] || 0) + (counts['interview'] || 0) + (counts['offer'] || 0);

    return {
      counts: counts,
      cumulative: cumulative,
      netConv: computeSourceConversion(companies, 'Network'),
      boardConv: computeSourceConversion(companies, 'Job Board'),
      bottleneck: detectBottleneck(counts),
      tierA: tiers.tierA,
      tierB: tiers.tierB,
      tierC: tiers.tierC,
      screenCount: screenCount
    };
  }

  // Breaks down closed companies by the furthest real stage they reached
  // before closing (using furthest_stage, so a company that got to
  // Interview and was then rejected still counts under Interview, not Closed).
  function computeClosedStats(companies) {
    var byStage = {};
    var i;
    for (i = 0; i < REAL_STAGE_ORDER.length; i++) byStage[REAL_STAGE_ORDER[i]] = 0;

    var total = 0;
    for (i = 0; i < companies.length; i++) {
      var c = companies[i];
      if (c.stage !== 'closed') continue;
      total++;
      var stage = c.furthest_stage || 'target';
      byStage[stage] = (byStage[stage] || 0) + 1;
    }

    return { total: total, byStage: byStage };
  }

  function parseCultureResponse(raw) {
    if (!raw) return null;
    var s = raw.trim();
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    var jsonStr = s.substring(start, end + 1);
    // Replace backtick-delimited strings with properly escaped double-quoted strings
    jsonStr = jsonStr.replace(/`([\s\S]*?)`/g, function(match, content) {
      return '"' + content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"';
    });
    try {
      var d = JSON.parse(jsonStr);
      if (!d.rating && !d.summary) return null;
      return { rating: parseInt(d.rating) || 0, summary: String(d.summary || '').trim() };
    } catch(e) {
      // Fallback: regex extraction for unescaped newlines inside string values
      var rMatch = jsonStr.match(/"rating"\s*:\s*(\d+)/);
      var sMatch = jsonStr.match(/"summary"\s*:\s*"([\s\S]+?)"\s*\}?\s*$/);
      if (!rMatch && !sMatch) return null;
      return {
        rating: rMatch ? parseInt(rMatch[1]) : 0,
        summary: sMatch ? sMatch[1].trim() : ''
      };
    }
  }

  function addInterviewNoteToCompany(c, text, dateLabel) {
    if (!c.interviewNotes) c.interviewNotes = [];
    c.interviewNotes.unshift({ date: dateLabel, text: text });
    return c;
  }

  function logActivityToCompany(c, text, dateLabel) {
    if (!c.activity) c.activity = [];
    c.activity.unshift({ date: dateLabel, text: text });
    return c;
  }

  function closeCompanyRecord(c, stageLabel, reason, dateLabel) {
    var reasonText = (reason && reason.trim()) ? reason.trim() : 'No reason given';
    c.furthest_stage = bumpFurthestStage(c.furthest_stage, c.stage);
    c.stage = 'closed';
    if (!c.activity) c.activity = [];
    c.activity.unshift({ date: dateLabel, text: 'Closed at ' + stageLabel + ' — Reason: ' + reasonText });
    return c;
  }

  // Ordered highest-to-lowest so the first keyword match wins. Used to recover
  // the furthest stage reached for companies closed before furthest_stage existed.
  var STAGE_EXIT_KEYWORDS = [
    { stage: 'offer',     kw: 'Offer' },
    { stage: 'interview', kw: 'Interview' },
    { stage: 'screen',    kw: 'Screen' },
    { stage: 'warm',      kw: 'Warming Up' }
  ];

  function inferFurthestStage(activity, keywords) {
    var kws = keywords || STAGE_EXIT_KEYWORDS;
    var list = activity || [];
    for (var ki = 0; ki < kws.length; ki++) {
      for (var ai = 0; ai < list.length; ai++) {
        if ((list[ai].text || '').indexOf(kws[ki].kw) >= 0) return kws[ki].stage;
      }
    }
    return 'target';
  }

  function filterCompanies(list, query) {
    if (!query) return list;
    var q = query.toLowerCase();
    var idMatch = q.match(/^id:(\d+)$/);
    if (idMatch) {
      var targetId = parseInt(idMatch[1], 10);
      return list.filter(function(c) { return c.id === targetId; });
    }
    return list.filter(function(c) {
      return c.company.toLowerCase().indexOf(q) !== -1 ||
             c.role.toLowerCase().indexOf(q) !== -1 ||
             (c.contact && c.contact.toLowerCase().indexOf(q) !== -1);
    });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      scoreTier: scoreTier,
      createCompanyRecord: createCompanyRecord,
      computeFunnelStats: computeFunnelStats,
      computeClosedStats: computeClosedStats,
      addInterviewNoteToCompany: addInterviewNoteToCompany,
      logActivityToCompany: logActivityToCompany,
      closeCompanyRecord: closeCompanyRecord,
      inferFurthestStage: inferFurthestStage,
      bumpFurthestStage: bumpFurthestStage,
      parseCultureResponse: parseCultureResponse,
      filterCompanies: filterCompanies
    };
  } else {
    window.scoreTier = scoreTier;
    window.createCompanyRecord = createCompanyRecord;
    window.computeFunnelStats = computeFunnelStats;
    window.computeClosedStats = computeClosedStats;
    window.addInterviewNoteToCompany = addInterviewNoteToCompany;
    window.logActivityToCompany = logActivityToCompany;
    window.closeCompanyRecord = closeCompanyRecord;
    window.inferFurthestStage = inferFurthestStage;
    window.bumpFurthestStage = bumpFurthestStage;
    window.parseCultureResponse = parseCultureResponse;
    window.filterCompanies = filterCompanies;
  }
})();
