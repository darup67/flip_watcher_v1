#!/usr/bin/env node
/**
 * Back up every saved TradingView Pine script to ~/flip-notifier/pine/.
 *
 * WHY THIS EXISTS: on 2026-09-03 the "Scalp" script ("Phantom Flow MNQ 15m"
 * v3.0) was destroyed by pine_open + a save, and only TradingView's own version
 * history had a copy. The sources for the Scanner and Core — the two studies the
 * notifier depends on — existed nowhere on disk.
 *
 * WHY IT DOES NOT USE THE MCP: `pine_open` loads source into the CURRENT editor
 * tab without switching tabs, which is precisely how that script was lost. This
 * reads TradingView's pine-facade GET endpoint from the page context instead:
 * read-only HTTP, no editor interaction, nothing to save.
 *
 * Safe to run any time, including while the notifier is polling.
 *
 * Usage: node backup-pine.mjs [out_dir]
 */
import WebSocket from '/Users/dhruvpatel/.hermes/hermes-agent/ui-tui/node_modules/ws/index.js';
import http from 'http';
import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const OUT = process.argv[2] || join(homedir(), 'flip-notifier', 'pine');
const CDP = process.env.FLIP_CDP || '127.0.0.1:9222';
const [HOST, PORT] = CDP.split(':');

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
function evaluate(expression, timeoutMs = 30000) {
  const myId = ++seq;
  return new Promise((res, rej) => {
    const t = setTimeout(() => { ws.off('message', onMsg); rej(new Error('evaluate timeout')); }, timeoutMs);
    const onMsg = raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id !== myId) return;
      clearTimeout(t); ws.off('message', onMsg);
      if (m.error) return rej(new Error(m.error.message));
      if (m.result?.exceptionDetails) return rej(new Error('page threw: ' + (m.result.exceptionDetails.text || '')));
      res(m.result?.result?.value);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

// Discover saved scripts rather than hardcoding ids, so new scripts are picked up.
const scripts = await evaluate(`
  (async () => {
    const r = await fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved',
                          { credentials: 'include' });
    if (!r.ok) return { err: 'HTTP ' + r.status };
    const j = await r.json();
    return { items: j.map(s => ({ id: s.scriptIdPart, ver: s.version, name: s.scriptName })) };
  })()`);

if (!scripts || scripts.err || !scripts.items) {
  console.error('could not list scripts: ' + (scripts?.err || 'no response'));
  ws.close(); process.exit(1);
}

mkdirSync(OUT, { recursive: true });
let ok = 0, failed = 0;
const manifest = [];

for (const s of scripts.items) {
  const expr = `
    (async () => {
      const u = '/pine-facade/get/' + encodeURIComponent(${JSON.stringify(s.id)}) + '/${s.ver}/';
      const r = await fetch('https://pine-facade.tradingview.com' + u, { credentials: 'include' });
      if (!r.ok) return { err: 'HTTP ' + r.status };
      const j = await r.json();
      return { src: j.source || null };
    })()`;
  try {
    const out = await evaluate(expr);
    if (!out?.src) { console.log(`FAIL  ${s.name}: ${out?.err || 'no source field'}`); failed++; continue; }
    const file = s.name.replace(/[^A-Za-z0-9._-]/g, '_') + '.pine';
    writeFileSync(join(OUT, file), out.src);
    manifest.push({ name: s.name, id: s.id, version: s.ver, bytes: out.src.length, file });
    console.log(`ok    ${s.name}  v${s.ver}  ${out.src.length}B -> ${file}`);
    ok++;
  } catch (e) { console.log(`FAIL  ${s.name}: ${e.message}`); failed++; }
}

writeFileSync(join(OUT, 'manifest.json'),
  JSON.stringify({ backedUpAt: new Date().toISOString(), scripts: manifest }, null, 2));
console.log(`\n${ok} saved, ${failed} failed -> ${OUT}`);
ws.close();
// Non-zero on any failure so a scheduled run shows as failing in launchctl.
process.exit(failed ? 1 : 0);
