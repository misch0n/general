'use strict';
/*
 * Генерал — authoritative multiplayer server, entrypoint.
 *
 * See docs/backend/README.md for the architecture and docs/backend/PLAN.md for
 * the phase plan. In short: this process will host one MP.Session per room over
 * a WebSocket transport, and — from Phase 3 — own the dice and the scoring, so a
 * client can no longer declare its own result.
 *
 * Phase 0.1 (this file's current scope): prove the process starts under Node and
 * that it really shares the browser's rules modules. There is no listener yet —
 * Phase 0.3 adds HTTP/WS. Keeping the entrypoint honest about what exists beats
 * a stub that pretends to serve.
 *
 * Run: `node server/index.js`
 */

var engine = require('./engine.js');

// One line per module so a failure says WHICH file stopped being server-usable.
function healthLines(report) {
  var lines = ['Генерал server — Phase 0 scaffold (no listener yet)'];
  lines.push('  node        ' + process.version + ' on ' + process.platform + '/' + process.arch);
  report.modules.forEach(function (m) {
    lines.push('  engine      ' + m.global + ' ← ' + m.source + '  ok');
  });
  lines.push('  dice rng    ' + (report.cryptoRng ? 'Web Crypto (unpredictable)' : 'Math.random FALLBACK — not fit for authoritative rolls'));
  lines.push('  status      ' + (report.ok ? 'READY' : 'NOT READY'));
  return lines;
}

function main() {
  var report;
  try {
    report = engine.assertReady();
  } catch (e) {
    process.stderr.write(String(e && e.message ? e.message : e) + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(healthLines(report).join('\n') + '\n');
}

if (require.main === module) main();

module.exports = { healthLines: healthLines, main: main };
