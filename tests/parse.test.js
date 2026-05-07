var test = require('node:test');
var assert = require('node:assert/strict');
var { parseJsonResponse, parseOllamaSseLine } = require('../src/lib/parse.js');

// ── parseJsonResponse ─────────────────────────────────────────────────

test('parses clean JSON', function() {
  var result = parseJsonResponse('{"score": 7}');
  assert.deepEqual(result, { score: 7 });
});

test('strips <think> blocks', function() {
  var input = '<think>lots of reasoning here</think>\n{"score": 8}';
  assert.deepEqual(parseJsonResponse(input), { score: 8 });
});

test('strips multi-line <think> blocks', function() {
  var input = '<think>\nstep 1\nstep 2\n</think>\n{"ok": true}';
  assert.deepEqual(parseJsonResponse(input), { ok: true });
});

test('strips markdown fences', function() {
  var input = '```json\n{"score": 5}\n```';
  assert.deepEqual(parseJsonResponse(input), { score: 5 });
});

test('strips fences without language tag', function() {
  var input = '```\n{"score": 5}\n```';
  assert.deepEqual(parseJsonResponse(input), { score: 5 });
});

test('extracts JSON from surrounding prose', function() {
  var input = 'Sure, here is the result:\n{"score": 6}\nHope that helps!';
  assert.deepEqual(parseJsonResponse(input), { score: 6 });
});

test('handles think block + fences + prose', function() {
  var input = '<think>thinking...</think>\n\nHere you go:\n```json\n{"overall_score": 7, "hard_nos_pass": true}\n```';
  var result = parseJsonResponse(input);
  assert.equal(result.overall_score, 7);
  assert.equal(result.hard_nos_pass, true);
});

test('throws on empty string', function() {
  assert.throws(function() { parseJsonResponse(''); }, /empty/i);
});

test('throws on invalid JSON', function() {
  assert.throws(function() { parseJsonResponse('not json at all'); });
});

test('preserves nested objects and arrays', function() {
  var input = '{"dimensions": [{"name": "Lifestyle", "score": 8}]}';
  var result = parseJsonResponse(input);
  assert.equal(result.dimensions[0].score, 8);
});

// ── parseOllamaSseLine ────────────────────────────────────────────────

function makeSseLine(delta) {
  return 'data: ' + JSON.stringify({
    choices: [{ delta: delta, finish_reason: null }]
  });
}

test('returns null for non-data line', function() {
  assert.equal(parseOllamaSseLine(''), null);
  assert.equal(parseOllamaSseLine('event: ping'), null);
  assert.equal(parseOllamaSseLine(': keep-alive'), null);
});

test('returns null for [DONE]', function() {
  assert.equal(parseOllamaSseLine('data: [DONE]'), null);
});

test('role-announcement event: null delta and null reasoning', function() {
  var line = makeSseLine({ role: 'assistant' });
  var result = parseOllamaSseLine(line);
  assert.deepEqual(result, { delta: null, reasoning: null });
});

test('empty content event: null delta', function() {
  var line = makeSseLine({ role: 'assistant', content: '' });
  var result = parseOllamaSseLine(line);
  assert.deepEqual(result, { delta: null, reasoning: null });
});

test('normal content token: delta set', function() {
  var line = makeSseLine({ content: 'hello' });
  var result = parseOllamaSseLine(line);
  assert.deepEqual(result, { delta: 'hello', reasoning: null });
});

test('think-tag content token: delta set', function() {
  var line = makeSseLine({ content: '<think>\n' });
  var result = parseOllamaSseLine(line);
  assert.deepEqual(result, { delta: '<think>\n', reasoning: null });
});

test('qwen3.6 think phase: content empty, reasoning populated', function() {
  // qwen3.6:27b sends content:"" + reasoning:"..." during think phase
  var line = makeSseLine({ role: 'assistant', content: '', reasoning: 'Here' });
  var result = parseOllamaSseLine(line);
  assert.deepEqual(result, { delta: null, reasoning: 'Here' });
});

test('qwen3.6 think phase: multi-word reasoning token', function() {
  var line = makeSseLine({ content: '', reasoning: "'s a" });
  var result = parseOllamaSseLine(line);
  assert.equal(result.delta, null);
  assert.equal(result.reasoning, "'s a");
});

test('qwen3.6 output phase: content populated, reasoning empty', function() {
  var line = makeSseLine({ content: '{"company_name":', reasoning: '' });
  var result = parseOllamaSseLine(line);
  assert.equal(result.delta, '{"company_name":');
  assert.equal(result.reasoning, null);
});

test('throws on malformed JSON', function() {
  assert.throws(function() { parseOllamaSseLine('data: {bad json}'); });
});

test('returns null when choices array is missing', function() {
  var line = 'data: ' + JSON.stringify({ model: 'qwen3.6:27b' });
  assert.equal(parseOllamaSseLine(line), null);
});

test('returns null when choices is empty', function() {
  var line = 'data: ' + JSON.stringify({ choices: [] });
  assert.equal(parseOllamaSseLine(line), null);
});
