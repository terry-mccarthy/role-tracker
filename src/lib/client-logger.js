// Mirrors browser console output to the server log (/api/log) for debugging.
// Loaded as a plain <script> in pipeline.html and scorer.html; self-executes
// on load and overrides console.log / console.error / console.warn.
(function() {
  var oldLog = console.log;
  var oldError = console.error;
  var oldWarn = console.warn;

  function safeStringify(a) {
    try { return JSON.stringify(a); } catch(e) { return String(a); }
  }

  function serializeArg(a) {
    if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack : '');
    if (a !== null && typeof a === 'object') return safeStringify(a);
    return String(a);
  }

  function sendToServer(level, args) {
    var msg = Array.from(args).map(serializeArg).join(' ');
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: level, message: msg })
    }).catch(function() {});
  }

  console.log = function() { oldLog.apply(console, arguments); sendToServer('INFO', arguments); };
  console.error = function() { oldError.apply(console, arguments); sendToServer('ERROR', arguments); };
  console.warn = function() { oldWarn.apply(console, arguments); sendToServer('WARN', arguments); };
})();
