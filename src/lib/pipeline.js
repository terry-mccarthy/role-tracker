(function() {
  var STAGE_IDS = ['target', 'warm', 'screen', 'interview', 'offer', 'closed'];

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
      jd: fields.jd || '',
      added: todayStr,
      score: null,
      activity: [{ date: todayLabel, text: 'Added to pipeline' }]
    };
  }

  // Returns pure stats from the companies array — no DOM, no HTML.
  function computeFunnelStats(companies) {
    var counts = {};
    var i, j;
    for (i = 0; i < STAGE_IDS.length; i++) {
      var cnt = 0;
      for (j = 0; j < companies.length; j++) {
        if (companies[j].stage === STAGE_IDS[i]) cnt++;
      }
      counts[STAGE_IDS[i]] = cnt;
    }

    var networkTotal = 0, networkAdv = 0, boardTotal = 0, boardAdv = 0;
    for (i = 0; i < companies.length; i++) {
      var c = companies[i];
      var advanced = c.stage === 'screen' || c.stage === 'interview' || c.stage === 'offer';
      if (c.source === 'Network') { networkTotal++; if (advanced) networkAdv++; }
      if (c.source === 'Job Board') { boardTotal++; if (advanced) boardAdv++; }
    }

    var netConv = networkTotal > 0 ? Math.round(networkAdv / networkTotal * 100) : 0;
    var boardConv = boardTotal > 0 ? Math.round(boardAdv / boardTotal * 100) : 0;
    var screenCount = (counts['screen'] || 0) + (counts['interview'] || 0) + (counts['offer'] || 0);
    var bottleneck = counts['target'] > (counts['warm'] || 0) * 2
      ? 'target_warm'
      : (counts['warm'] || 0) > (counts['screen'] || 0) * 3
        ? 'warm_screen'
        : null;

    var tierA = 0, tierB = 0, tierC = 0;
    for (i = 0; i < companies.length; i++) {
      if (companies[i].tier === 'A') tierA++;
      else if (companies[i].tier === 'B') tierB++;
      else if (companies[i].tier === 'C') tierC++;
    }

    return {
      counts: counts,
      netConv: netConv,
      boardConv: boardConv,
      bottleneck: bottleneck,
      tierA: tierA,
      tierB: tierB,
      tierC: tierC,
      screenCount: screenCount
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createCompanyRecord: createCompanyRecord,
      computeFunnelStats: computeFunnelStats
    };
  } else {
    window.createCompanyRecord = createCompanyRecord;
    window.computeFunnelStats = computeFunnelStats;
  }
})();
