#!/usr/bin/env node
// Headless Flip Watcher — computes the Watchlist Flip Scanner's regime
// (ta.supertrend(3, 10) on confirmed 30m bars, BUY when dir == -1) straight
// from exchange data, so flips are caught without TradingView running.
//
// SHADOW MODE: logs to headless-alerts.tsv and compares against the chart-based
// notifier (state.json regimes, alerts.tsv flips). It sends NO email until
// headless-config.json "mode" is set to "live".
//
//   node headless-flip.js              one run (launchd calls this)
//   node headless-flip.js --status     current regimes vs chart notifier
//   node headless-flip.js --compare 48 flips vs alerts.tsv over last 48h
//   node headless-flip.js --replay 72  recompute past flips from history, compare

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'headless-config.json'), 'utf8'));
const STATE_FILE = path.join(DIR, 'headless-state.json');
const ALERTS = path.join(DIR, 'headless-alerts.tsv');
const LOG = path.join(DIR, 'headless-flip.log');
const TF_MS = 30 * 60 * 1000;

const log = (msg) => {
  const line = `${new Date().toISOString()}  ${msg}`;
  fs.appendFileSync(LOG, line + '\n');
  if (process.stdout.isTTY) console.log(line);
};

async function getJSON(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { fatal: true });
      return await r.json();
    } catch (e) {
      if (e.fatal || attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
}

// ---------- data sources: each returns [{t (ms, bar open), o, h, l, c}] ascending ----------

async function yahoo(ticker) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=30m&range=30d`);
  const res = j.chart.result[0];
  const q = res.indicators.quote[0];
  return (res.timestamp || []).map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }))
    .filter((b) => b.o != null && b.h != null && b.l != null && b.c != null);
}

async function coinbase(product) {
  // Coinbase has no 30m granularity: fetch 15m (2 pages, 600 bars) and pair them.
  const now = Date.now();
  const rows = [];
  for (let page = 0; page < 2; page++) {
    const end = new Date(now - page * 300 * 900e3).toISOString();
    const start = new Date(now - (page + 1) * 300 * 900e3).toISOString();
    rows.push(...await getJSON(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=900&start=${start}&end=${end}`));
  }
  const byBar = new Map();
  for (const [ts, low, high, open, close] of rows) {
    const t = ts * 1000, k = Math.floor(t / TF_MS) * TF_MS;
    const parts = byBar.get(k) || [];
    parts.push({ t, o: open, h: high, l: low, c: close });
    byBar.set(k, parts);
  }
  return [...byBar.entries()].sort((a, b) => a[0] - b[0]).map(([k, p]) => {
    p.sort((a, b) => a.t - b.t);
    return { t: k, o: p[0].o, h: Math.max(...p.map((x) => x.h)), l: Math.min(...p.map((x) => x.l)), c: p[p.length - 1].c, parts: p.length };
  }).filter((b, i, all) => b.parts === 2 || i === all.length - 1);
}

async function bitstamp(pair) {
  const j = await getJSON(`https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=1800&limit=1000`);
  return j.data.ohlc.map((b) => ({ t: +b.timestamp * 1000, o: +b.open, h: +b.high, l: +b.low, c: +b.close }));
}

async function binance(sym) {
  const j = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=30m&limit=1000`);
  return j.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

async function kraken(pair) {
  const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=30`);
  const key = Object.keys(j.result).find((k) => k !== 'last');
  return j.result[key].map((b) => ({ t: b[0] * 1000, o: +b[1], h: +b[2], l: +b[3], c: +b[4] }));
}

const SOURCES = { yahoo, coinbase, bitstamp, binance, kraken };

// ---------- TradingView ta.supertrend(factor, atrLen), src = hl2, ATR = RMA(TR) ----------

function supertrendRegimes(bars, factor, atrLen) {
  const out = [];
  let atr = null, trSum = 0, prevUpper = null, prevLower = null, prevST = null, prevDir = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], pc = i ? bars[i - 1].c : null;
    const tr = pc == null ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    const prevAtr = atr;
    if (i < atrLen) { trSum += tr; atr = i === atrLen - 1 ? trSum / atrLen : null; }
    else atr = (atr * (atrLen - 1) + tr) / atrLen;
    if (atr == null) { out.push(null); continue; }
    const hl2 = (b.h + b.l) / 2;
    let upper = hl2 + factor * atr, lower = hl2 - factor * atr;
    if (prevLower != null) lower = (lower > prevLower || pc < prevLower) ? lower : prevLower;
    if (prevUpper != null) upper = (upper < prevUpper || pc > prevUpper) ? upper : prevUpper;
    let dir;
    if (prevAtr == null) dir = 1;
    else if (prevST === prevUpper) dir = b.c > upper ? -1 : 1;
    else dir = b.c < lower ? 1 : -1;
    const st = dir === -1 ? lower : upper;
    prevUpper = upper; prevLower = lower; prevST = st; prevDir = dir;
    out.push(dir === -1 ? 'BUY' : 'SELL');
  }
  return out;
}

// ---------- core ----------

async function evaluate(sym) {
  const bars = await SOURCES[sym.source](sym.ticker);
  const now = Date.now();
  const confirmed = bars.filter((b) => b.t + TF_MS <= now);
  if (confirmed.length < CFG.atrLen + 5) throw new Error(`only ${confirmed.length} confirmed bars`);
  const regs = supertrendRegimes(confirmed, CFG.factor, CFG.atrLen);
  const n = confirmed.length;
  return { tv: sym.tv, name: sym.tv.split(':')[1], regime: regs[n - 1], prev: regs[n - 2], barTime: confirmed[n - 1].t, ageMin: Math.round((now - confirmed[n - 1].t - TF_MS) / 60000) };
}

async function evaluateAll() {
  const results = await Promise.all(CFG.symbols.map(async (s) => {
    try { return await evaluate(s); } catch (e) { return { tv: s.tv, name: s.tv.split(':')[1], error: e.message }; }
  }));
  return results;
}

function readJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }

function chartRegimes() {
  const s = readJSON(path.join(DIR, 'state.json'), {});
  return s.regimes || {};
}

async function run() {
  const state = readJSON(STATE_FILE, { regimes: {}, bars: {} });
  const results = await evaluateAll();
  const flips = [], errors = [];
  for (const r of results) {
    if (r.error) { errors.push(`${r.name}: ${r.error}`); continue; }
    const known = state.regimes[r.tv];
    if (state.bars[r.tv] === r.barTime) continue;           // bar already processed
    if (known && known !== r.regime) flips.push(r);
    state.regimes[r.tv] = r.regime;
    state.bars[r.tv] = r.barTime;
  }
  state.updated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

  const chart = chartRegimes();
  const ok = results.filter((r) => !r.error);
  const agree = ok.filter((r) => chart[r.tv] === r.regime).length;
  const diff = ok.filter((r) => chart[r.tv] && chart[r.tv] !== r.regime).map((r) => `${r.name}(h:${r.regime}/c:${chart[r.tv]})`);

  for (const f of flips) {
    const arrow = f.regime === 'BUY' ? '⬆️' : '⬇️';
    fs.appendFileSync(ALERTS, `${new Date().toISOString()}\t${arrow} ${f.name} → ${f.regime}\t${f.name} ${f.prev === f.regime ? '?' : (f.regime === 'BUY' ? 'SELL' : 'BUY')} → ${f.regime}\tbar ${new Date(f.barTime).toISOString()}\n`);
  }
  if (flips.length && CFG.mode === 'live') await sendEmail(flips);
  log(`${flips.length ? 'FLIPS ' + flips.map((f) => `${f.name}→${f.regime}`).join(' ') : 'no flips'} · ${ok.length}/${results.length} ok · agree with chart ${agree}/${ok.length}` +
    (diff.length ? ` · differ: ${diff.join(' ')}` : '') + (errors.length ? ` · ERR ${errors.join('; ')}` : '') + ` · mode ${CFG.mode}`);
}

async function sendEmail(flips) {
  // send-email.js is a CLI (same one the chart notifier uses); password from Keychain.
  const { execFileSync } = require('child_process');
  const env = { ...process.env };
  if (!env.FLIP_GMAIL_APP_PASSWORD) env.FLIP_GMAIL_APP_PASSWORD = execFileSync('security', ['find-generic-password', '-a', 'darup67@gmail.com', '-s', 'flip-notifier-gmail', '-w']).toString().trim();
  const subject = `${flips.length === 1 ? (flips[0].regime === 'BUY' ? '⬆️' : '⬇️') : '🔀' + flips.length} ${flips.map((f) => f.name + ' → ' + f.regime).join(' · ')}`;
  const body = flips.map((f) => `${f.name}: ${f.regime === 'BUY' ? 'SELL → BUY' : 'BUY → SELL'} (30m bar ${new Date(f.barTime).toISOString()})`).join('\n') + '\n\n— Headless Flip Watcher (exchange data, no TradingView)';
  execFileSync(process.execPath, [path.join(DIR, 'send-email.js'), subject, body], { env, timeout: 35000, stdio: 'ignore' });
}

async function status() {
  const results = await evaluateAll();
  const chart = chartRegimes();
  let agree = 0;
  for (const r of results) {
    if (r.error) { console.log(`${r.name.padEnd(10)} ERROR ${r.error}`); continue; }
    const c = chart[r.tv] || '-';
    if (c === r.regime) agree++;
    console.log(`${r.name.padEnd(10)} headless ${r.regime.padEnd(4)}  chart ${c.padEnd(4)} ${c === r.regime ? ' ' : '≠'}  last bar ${new Date(r.barTime).toISOString().slice(5, 16)}Z`);
  }
  console.log(`\nagree ${agree}/${results.filter((r) => !r.error).length}`);
}

async function replay(hours) {
  // Recompute historical flips from bar history, write them to a temp tsv, compare.
  const since = Date.now() - hours * 3600e3, lines = [];
  await Promise.all(CFG.symbols.map(async (sym) => {
    try {
      const bars = (await SOURCES[sym.source](sym.ticker)).filter((b) => b.t + TF_MS <= Date.now());
      const regs = supertrendRegimes(bars, CFG.factor, CFG.atrLen);
      for (let i = 1; i < bars.length; i++) {
        const close = bars[i].t + TF_MS;
        if (close >= since && regs[i - 1] && regs[i] !== regs[i - 1])
          lines.push(`${new Date(close).toISOString()}\tr\t${sym.tv.split(':')[1]} ${regs[i - 1]} → ${regs[i]}\n`);
      }
    } catch (e) { console.log(`${sym.tv}: ${e.message}`); }
  }));
  const tmp = path.join(DIR, 'headless-replay.tsv');
  fs.writeFileSync(tmp, lines.sort().join(''));
  compare(hours, tmp);
}

function compare(hours, headFile = ALERTS) {
  const since = Date.now() - hours * 3600e3;
  const norm = (x) => x.replace('MGC1!', 'MGCV2026');
  const parse = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').flatMap((line) => {
    const [ts, , detail] = line.split('\t');
    if (!detail || Date.parse(ts) < since) return [];
    return [...detail.matchAll(/([A-Z0-9!]+) (?:(?:BUY|SELL) )?→ (BUY|SELL)/g)].map((m) => ({ t: Date.parse(ts), sym: norm(m[1]), to: m[2] }));
  }) : [];
  // chart notifier: emailed flips (alerts.tsv) + held-back weak flips (log), deduped per symbol+direction per 30m bar
  const heldBack = fs.readFileSync(path.join(DIR, 'flip-notifier.log'), 'utf8').split('\n').flatMap((line) => {
    const m = line.match(/^(\S+)\s+held back \d+ below-threshold flip\(s\): (.*)$/);
    if (!m || Date.parse(m[1]) < since) return [];
    return [...m[2].matchAll(/([A-Z0-9!]+) (?:BUY|SELL)->(BUY|SELL)/g)].map((x) => ({ t: Date.parse(m[1]), sym: norm(x[1]), to: x[2] }));
  });
  const dedupe = (arr) => { const seen = new Set(); return arr.sort((a, b) => a.t - b.t).filter((x) => { const k = `${x.sym}|${x.to}|${Math.floor(x.t / TF_MS)}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  const chart = dedupe(parse(path.join(DIR, 'alerts.tsv')).concat(heldBack)), head = parse(headFile);
  const used = new Set();
  let matched = 0; const onlyHead = [];
  for (const h of head) {
    const i = chart.findIndex((c, k) => !used.has(k) && c.sym === h.sym && c.to === h.to && c.t >= h.t - 35 * 60e3 && c.t <= h.t + 45 * 60e3);
    if (i >= 0) { used.add(i); matched++; } else onlyHead.push(h);
  }
  const onlyChart = chart.filter((_, k) => !used.has(k));
  const fmt = (x) => `${new Date(x.t).toISOString().slice(5, 16)} ${x.sym}→${x.to}`;
  console.log(`last ${hours}h: headless ${head.length}, chart ${chart.length}, matched ${matched} (±45m)`);
  if (onlyHead.length) console.log('only headless:\n  ' + onlyHead.map(fmt).join('\n  '));
  if (onlyChart.length) console.log('only chart:\n  ' + onlyChart.map(fmt).join('\n  '));
}

const arg = process.argv[2];
(arg === '--status' ? status() : arg === '--replay' ? replay(+process.argv[3] || 72) : arg === '--compare' ? Promise.resolve(compare(+process.argv[3] || 48)) : run())
  .catch((e) => { log('FATAL ' + (e.stack || e.message)); process.exit(1); });
