#!/usr/bin/env node
/**
 * Flush the TradingView chart layout to the cloud immediately.
 *
 * WHY THIS EXISTS: `indicator_set_inputs` (and the MCP generally) mutates the
 * RUNTIME study instance only. TradingView's autosave is debounced, so if the
 * study re-initializes before autosave fires — a symbol change, a timeframe
 * change, a page reload, adding/removing a study — the pending input changes are
 * silently discarded and the study restores the older SAVED layout.
 *
 * That is how the Scanner reverted to NFLX/TSLA with a blank in_2 twice on
 * 2026-09-07 after being "fixed": both fixes were real, neither was persisted.
 *
 * Call this after ANY input change you need to survive. It is idempotent and a
 * no-op when there is nothing pending.
 *
 * Usage: node save-chart.mjs
 * Exit:  0 saved (or nothing to save), 1 on failure.
 */
import WebSocket from '/Users/dhruvpatel/.hermes/hermes-agent/ui-tui/node_modules/ws/index.js';
import http from 'http';

const CDP = process.env.FLIP_CDP || '127.0.0.1:9222';
const [HOST, PORT] = CDP.split(':');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const get = path => new Promise((res, rej) => {
  http.get({ host: HOST, port: Number(PORT), path, timeout: 5000 },
    r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); })
    .on('error', rej).on('timeout', () => rej(new Error('CDP list timeout')));
});

const list = await get('/json/list');
const page = list.find(t => t.type === 'page' && /tradingview\.com\/chart/.test(t.url));
if (!page) { console.error('no TradingView chart tab on ' + CDP); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

let seq = 0;
const evaluate = (expression, timeoutMs = 20000) => {
  const id = ++seq;
  return new Promise((res, rej) => {
    const t = setTimeout(() => { ws.off('message', on); rej(new Error('evaluate timeout')); }, timeoutMs);
    const on = raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id !== id) return;
      clearTimeout(t); ws.off('message', on);
      if (m.error) return rej(new Error(m.error.message));
      if (m.result?.exceptionDetails) return rej(new Error(m.result.exceptionDetails.text || 'page threw'));
      res(m.result?.result?.value);
    };
    ws.on('message', on);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true } }));
  });
};

const unwrap = `function (v) { return (v && typeof v.value === 'function') ? v.value() : v; }`;
const probe = `(function(){
  var u = ${unwrap};
  var s = window.TradingViewApi && window.TradingViewApi._saveChartService;
  if (!s) return JSON.stringify({ err: 'no _saveChartService' });
  return JSON.stringify({ hasChanges: u(s.hasChanges()), autoSave: u(s.autoSaveEnabled()), layoutId: u(s.layoutId()) });
})()`;

try {
  const before = JSON.parse(await evaluate(probe));
  if (before.err) { console.error(before.err); ws.close(); process.exit(1); }
  if (!before.hasChanges) {
    console.log(`nothing pending (layout ${before.layoutId}, autosave=${before.autoSave}) — no-op`);
    ws.close(); process.exit(0);
  }
  const r = await evaluate(`(async () => { try { await window.TradingViewApi._saveChartService.saveChartSilently(); return 'ok'; } catch (e) { return 'ERR ' + e.message; } })()`);
  if (r !== 'ok') { console.error('save failed: ' + r); ws.close(); process.exit(1); }
  await sleep(2500);
  const after = JSON.parse(await evaluate(probe));
  if (after.hasChanges) { console.error('save reported ok but changes still pending'); ws.close(); process.exit(1); }
  console.log(`saved layout ${after.layoutId}`);
  ws.close(); process.exit(0);
} catch (e) {
  console.error('save-chart failed: ' + e.message);
  try { ws.close(); } catch {}
  process.exit(1);
}
