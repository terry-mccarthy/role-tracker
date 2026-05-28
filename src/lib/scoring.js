(function() {
  // Parses the weights table from the eval profile markdown.
  // Returns [{dim, weight}] — one entry per scoring dimension.
  function parseProfileWeights(profileText) {
    var lines = profileText.split('\n');
    var weights = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('|') !== 0) continue;
      if (line.indexOf('Weight') !== -1) continue;
      if (line.indexOf('---') !== -1) continue;
      var parts = line.split('|');
      if (parts.length < 3) continue;
      var dim = parts[1].trim();
      var weight = parts[2].trim();
      if (dim.length > 0 && weight.length > 0) {
        weights.push({ dim: dim.split('(')[0].trim(), weight: weight });
      }
    }
    return weights;
  }

  // Builds the system + user prompts for scoring a role against a profile.
  function buildScoringPrompts(profile, jdText, company, url) {
    var system = 'You are a rigorous offer-evaluation assistant. Your job is to score a job description against a candidate\'s evaluation profile.\n\n'
      + 'IMPORTANT: Do not engage in chain-of-thought or internal reasoning. Produce your output directly without thinking tokens.\n\n'
      + 'RULES — follow these exactly:\n\n'
      + '1. TWO-PASS PROCESS. Do not score until you have completed the extraction pass.\n\n'
      + '   PASS 1 — Extract from the JD using short direct phrases (keep each value single-line):\n'
      + '   a. Role title and seniority signals\n'
      + '   b. Team size: exact number of engineers if stated, or "not stated"\n'
      + '   c. Squad structure: single team or multi-team\n'
      + '   d. Reporting line: who does this role report to\n'
      + '   e. Time-mix signals: is hands-on coding expected?\n'
      + '   f. Office/location/hybrid requirements\n'
      + '   g. Salary or TC range\n'
      + '   h. Company stage (Series A/B/C, public, etc.)\n'
      + '   i. Industry / product domain\n'
      + '   j. Any hard-no triggers (crypto, gambling, weapons, burnout language, RTO mandate)\n\n'
      + '   PASS 2 — Score each dimension against the profile.\n\n'
      + '2. CITATION RULE. For every dimension score mention the specific JD evidence and profile criterion you are comparing, but keep each detail value single-line (no line breaks inside values).\n\n'
      + '3. SCOPE SIGNALS. Pay special attention to:\n'
      + '   - IC coding expectations: if the JD says the EM will write code, flag this explicitly\n'
      + '   - Team size: "a team" with no number \u2260 multi-squad at Head-of level\n'
      + '   - Reporting line: "reports to VP Engineering" \u2260 reports to CTO\n\n'
      + '4. HARD NOS. Check all hard-no criteria first. If any is triggered, stop — set hard_nos_pass to false with explanation in hard_nos_detail, do not score dimensions.\n\n'
      + 'Here is the candidate evaluation profile:\n\n' + profile + '\n\n'
      + 'Respond ONLY with valid JSON (no markdown fences, no preamble). Use this exact structure:\n'
      + '{\n'
      + '  "extraction": {\n'
      + '    "role_title": "",\n'
      + '    "team_size": "",\n'
      + '    "squad_structure": "",\n'
      + '    "reporting_line": "",\n'
      + '    "ic_coding_expected": "",\n'
      + '    "office_hybrid": "",\n'
      + '    "salary_tc": "",\n'
      + '    "company_stage": "",\n'
      + '    "industry": "",\n'
      + '    "hard_no_triggers": ""\n'
      + '  },\n'
      + '  "overall_score": 7,\n'
      + '  "overall_verdict": "",\n'
      + '  "hard_nos_pass": true,\n'
      + '  "hard_nos_detail": "",\n'
      + '  "dimensions": [\n'
      + '    { "name": "Lifestyle", "weight": "25%", "score": 7, "detail": "" },\n'
      + '    { "name": "Compensation", "weight": "20%", "score": 7, "detail": "" },\n'
      + '    { "name": "Scope & Growth Path", "weight": "20%", "score": 7, "detail": "" },\n'
      + '    { "name": "People", "weight": "20%", "score": 7, "detail": "" },\n'
      + '    { "name": "Company & Mission", "weight": "15%", "score": 7, "detail": "" }\n'
      + '  ],\n'
      + '  "tensions": ["tension text here"],\n'
      + '  "discovery_items": ["item needing verification"]\n'
      + '}\n\n'
      + 'CRITICAL JSON RULES:\n'
      + '- All string values must be enclosed in double quotes (e.g. "not stated" not not stated)\n'
      + '- No newlines, tabs, or control characters inside any string value — keep everything single-line\n'
      + '- Escape any double quotes inside values as \\"\n'
      + '- Use empty string "" if information is missing\n'
      + '- *** SCORE RANGE: every score field must be an integer 1 (worst) to 10 (perfect). Never use 0 or values above 10.***\n'
      + '- overall_score must be a weighted composite of the five dimension scores (also 1-10)\n'
      + '- tensions and discovery_items are arrays of plain strings, not objects\n'
      + '- Score conservatively. If information is missing, score lower and note it in discovery_items.';


    var user = 'Score this job description';
    if (company) user += ' at ' + company;
    user += ':\n\n' + jdText;
    if (url) user += '\n\nSource URL: ' + url;

    return { system: system, user: user };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseProfileWeights: parseProfileWeights,
      buildScoringPrompts: buildScoringPrompts
    };
  } else {
    window.parseProfileWeights = parseProfileWeights;
    window.buildScoringPrompts = buildScoringPrompts;
  }
})();
