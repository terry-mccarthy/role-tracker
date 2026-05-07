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
    var system = 'You are a job offer evaluation assistant. You score job descriptions against a candidate evaluation profile.\n\n'
      + 'Here is the candidate evaluation profile:\n\n' + profile + '\n\n'
      + 'Respond ONLY with valid JSON (no markdown fences, no preamble). Use this exact structure:\n'
      + '{\n'
      + '  "overall_score": <number 1-10>,\n'
      + '  "overall_verdict": "<one sentence summary>",\n'
      + '  "hard_nos_pass": <true/false>,\n'
      + '  "hard_nos_detail": "<explanation if any triggered, or \'No walk-away criteria triggered\'>",\n'
      + '  "dimensions": [\n'
      + '    { "name": "Lifestyle", "weight": "25%", "score": <1-10>, "detail": "<2-3 sentences>" },\n'
      + '    { "name": "Compensation", "weight": "20%", "score": <1-10>, "detail": "<2-3 sentences>" },\n'
      + '    { "name": "Scope & Growth", "weight": "20%", "score": <1-10>, "detail": "<2-3 sentences>" },\n'
      + '    { "name": "People", "weight": "20%", "score": <1-10>, "detail": "<2-3 sentences>" },\n'
      + '    { "name": "Company & Mission", "weight": "15%", "score": <1-10>, "detail": "<2-3 sentences>" }\n'
      + '  ],\n'
      + '  "tensions": ["<tension 1>", "<tension 2>"],\n'
      + '  "discovery_items": ["<item needing interview verification>"]\n'
      + '}\n\n'
      + 'Score conservatively. If information is missing from the JD, score that dimension lower and note it in discovery_items. Be specific and reference actual details from the JD.';

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
