(function() {
  // Strips LLM noise (think blocks, fences) and extracts a JSON object.
  function parseJsonResponse(text) {
    if (!text || !text.trim()) throw new Error('Empty response from model');
    var clean = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();
    var start = clean.indexOf('{');
    var end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(clean.substring(start, end + 1));
    }
    return JSON.parse(clean);
  }

  // Parses one SSE line from an Ollama /v1/chat/completions stream.
  // Returns { delta, reasoning } where either may be null.
  // - delta: content to append to fullText (null if absent/empty)
  // - reasoning: thinking-phase token (null if absent/empty) — for counting only, not accumulated
  // qwen3.6:27b sends content:"" + reasoning:"..." during think phase, then content:"..." + reasoning:"" after.
  function parseOllamaSseLine(line) {
    if (line.indexOf('data: ') !== 0) return null;
    var raw = line.slice(6).trim();
    if (raw === '[DONE]') return null;
    var parsed = JSON.parse(raw);
    var choices = parsed.choices;
    if (!choices || !choices[0] || !choices[0].delta) return null;
    var d = choices[0].delta;
    var content = typeof d.content === 'string' && d.content ? d.content : null;
    var reasoning = typeof d.reasoning === 'string' && d.reasoning ? d.reasoning : null;
    return { delta: content, reasoning: reasoning };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseJsonResponse: parseJsonResponse,
      parseOllamaSseLine: parseOllamaSseLine
    };
  } else {
    window.parseJsonResponse = parseJsonResponse;
    window.parseOllamaSseLine = parseOllamaSseLine;
  }
})();
