var test = require('node:test');
var assert = require('node:assert/strict');
var { parseProfileWeights, buildScoringPrompts } = require('../src/lib/scoring.js');

var SAMPLE_PROFILE = [
  '# Offer Evaluation Profile — Test',
  '',
  '## Scoring weights',
  '',
  '| Dimension | Weight |',
  '|---|---|',
  '| Lifestyle (hybrid, hours, commute, travel) | 25% |',
  '| Compensation (base, total cash, benefits) | 20% |',
  '| Scope & growth path (size, level, trajectory) | 20% |',
  '| People (manager fit, peer strength) | 20% |',
  '| Company & mission (stage, industry, culture) | 15% |',
].join('\n');

test('parseProfileWeights returns one entry per dimension', function() {
  var weights = parseProfileWeights(SAMPLE_PROFILE);
  assert.equal(weights.length, 5);
});

test('parseProfileWeights trims parenthetical from dim name', function() {
  var weights = parseProfileWeights(SAMPLE_PROFILE);
  assert.equal(weights[0].dim, 'Lifestyle');
  assert.equal(weights[1].dim, 'Compensation');
});

test('parseProfileWeights extracts weight percentages', function() {
  var weights = parseProfileWeights(SAMPLE_PROFILE);
  assert.equal(weights[0].weight, '25%');
  assert.equal(weights[4].weight, '15%');
});

test('parseProfileWeights returns empty array for profile with no table', function() {
  var weights = parseProfileWeights('# Profile\n\nNo table here.');
  assert.equal(weights.length, 0);
});

test('buildScoringPrompts includes profile in system prompt', function() {
  var prompts = buildScoringPrompts(SAMPLE_PROFILE, 'Senior EM role at Acme', 'Acme', '');
  assert.ok(prompts.system.indexOf(SAMPLE_PROFILE) !== -1);
});

test('buildScoringPrompts includes company in user message', function() {
  var prompts = buildScoringPrompts(SAMPLE_PROFILE, 'JD text', 'Acme Corp', '');
  assert.ok(prompts.user.indexOf('Acme Corp') !== -1);
});

test('buildScoringPrompts includes url when provided', function() {
  var prompts = buildScoringPrompts(SAMPLE_PROFILE, 'JD text', '', 'https://example.com/job/123');
  assert.ok(prompts.user.indexOf('https://example.com/job/123') !== -1);
});

test('buildScoringPrompts omits url line when url is empty', function() {
  var prompts = buildScoringPrompts(SAMPLE_PROFILE, 'JD text', 'Acme', '');
  assert.ok(prompts.user.indexOf('Source URL') === -1);
});

test('buildScoringPrompts requires JSON-only response in system', function() {
  var prompts = buildScoringPrompts(SAMPLE_PROFILE, 'JD text', '', '');
  assert.ok(prompts.system.indexOf('ONLY with valid JSON') !== -1);
});

test('buildScoringPrompts includes all five dimension names in system', function() {
  var prompts = buildScoringPrompts(SAMPLE_PROFILE, 'JD text', '', '');
  var dims = ['Lifestyle', 'Compensation', 'Scope & Growth', 'People', 'Company & Mission'];
  for (var i = 0; i < dims.length; i++) {
    assert.ok(prompts.system.indexOf(dims[i]) !== -1, 'missing: ' + dims[i]);
  }
});
