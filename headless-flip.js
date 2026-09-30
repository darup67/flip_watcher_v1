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
//   node headless-flip.js --matrix     email the BUY/SELL matrix report (--matrix-preview writes html only)

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'headless-config.json'), 'utf8'));
const STATE_FILE = path.join(DIR, 'headless-state.json');
const ALERTS = path.join(DIR, 'headless-alerts.tsv');
const LOG = path.join(DIR, 'headless-flip.log');
// Bar size for the whole universe (CFG.tfMinutes; 15 since 2026-09-28, was 30). Every source follows it.
// Bars come from trade-core's shared store (closed 15m bars, fetched incrementally, crypto fallbacks).
// The base is always 15m; flips run on signals.flipTf (15), and 30m/1h are merged locally by agg().
const core = require(path.join(require('os').homedir(), 'trade-core', 'bars.js'));
const TF_MIN = 15;
const ledger = require(path.join(require('os').homedir(), 'trade-core', 'ledger.js'));
const assetOf = (tv) => { const g = (CFG.symbols.find((x) => x.tv === tv) || {}).group; return g === 'futures' ? 'future' : g === 'crypto' ? 'crypto' : 'stock'; };

// Order tickets (#7): a ready-to-review plan for each real-time alert. Nothing is ever placed from here;
// placing happens only when the user asks Claude ("place ticket T4K2A") and confirms a broker preview.
function makeTicket(lid, { name, tv, side, price, stop, target }) {
  const risk = (CFG.tickets && CFG.tickets.riskUsd) || 100, asset = assetOf(tv), per = Math.abs(price - stop);
  let h = 0; for (const ch of lid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const t = { id: 'T' + h.toString(36).toUpperCase().slice(0, 5), sym: name, side: side === 'short' ? 'SELL' : 'BUY', entry: +price.toPrecision(6),
              stop: +stop.toPrecision(6), target: +target.toPrecision(6), riskUsd: risk,
              account: asset === 'stock' ? 'Robinhood ••4526' : asset === 'crypto' ? 'Robinhood crypto (or Coinbase app)' : 'futures account' };
  if (asset === 'stock') t.qty = Math.max(1, Math.floor(risk / per));
  else if (asset === 'crypto') t.notionalUsd = Math.round((risk / per) * price);
  else t.qty = 1;
  return t;
}
const ticketLine = (t) => `  🎫 ${t.id}: ${t.side} ${t.qty ? t.qty + (t.account.startsWith('futures') ? ' contract' : ' sh') : '$' + t.notionalUsd} ${t.sym} limit ~${t.entry}, stop ${t.stop}, target ${t.target} (risk ≈ $${t.riskUsd}) · ${t.account} · you place it yourself; say "check ticket ${t.id}" for live quotes`;
const TF_MS = TF_MIN * 60 * 1000;

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
  // Pre-market + after-hours bars for stocks (CFG.extendedHours, added 2026-09-28) so the 8:00 AM matrix
  // and pre-market flips/gaps are live. Futures (=F) trade nearly 24h and ignore the flag.
  const ext = CFG.extendedHours && !ticker.endsWith('=F') ? '&includePrePost=true' : '';
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${TF_MIN}m&range=${TF_MIN >= 60 ? 90 : 30}d${ext}`);
  const res = j.chart.result[0];
  const q = res.indicators.quote[0];
  return (res.timestamp || []).map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume ? q.volume[i] || 0 : 0 }))
    .filter((b) => b.o != null && b.h != null && b.l != null && b.c != null)
    // With includePrePost Yahoo also returns off-grid points (e.g. 5:26:40 PM, zero volume): a stale
    // last trade, not a 30m bar. One produced a false BLK flip + 2.9x ATR "gap" (2026-09-28 18:01).
    .filter((b) => b.t % Math.min(TF_MS, 1800e3) === 0);   // hourly stock bars sit on :30 (9:30, 10:30…)
}

async function coinbase(product) {
  // Native 15m candles (granularity 900), 300 per page; 4 pages ≈ 12.5 days. For TF_MIN = 30 the
  // 15m bars are paired into 30m, as before.
  const now = Date.now(), rows = [];
  for (let page = 0; page < 4; page++) {
    const end = new Date(now - page * 300 * 900e3).toISOString();
    const start = new Date(now - (page + 1) * 300 * 900e3).toISOString();
    rows.push(...await getJSON(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=900&start=${start}&end=${end}`));
  }
  const need = TF_MS / 900e3, byBar = new Map();
  for (const [ts, low, high, open, close, volume] of rows) {
    const t = ts * 1000, k = Math.floor(t / TF_MS) * TF_MS;
    const parts = byBar.get(k) || [];
    if (!parts.some((x) => x.t === t)) parts.push({ t, o: open, h: high, l: low, c: close, v: volume || 0 });
    byBar.set(k, parts);
  }
  return [...byBar.entries()].sort((a, b) => a[0] - b[0]).map(([k, p]) => {
    p.sort((a, b) => a.t - b.t);
    return { t: k, o: p[0].o, h: Math.max(...p.map((x) => x.h)), l: Math.min(...p.map((x) => x.l)), c: p[p.length - 1].c, v: p.reduce((a, x) => a + x.v, 0), parts: p.length };
  }).filter((b, i, all) => b.parts === need || i === all.length - 1);
}

async function bitstamp(pair) {
  const j = await getJSON(`https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${TF_MIN * 60}&limit=1000`);
  return j.data.ohlc.map((b) => ({ t: +b.timestamp * 1000, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume }));
}

async function binance(sym) {
  const j = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${TF_MIN >= 60 ? TF_MIN / 60 + 'h' : TF_MIN + 'm'}&limit=1000`);
  return j.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

async function kraken(pair) {
  const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${TF_MIN}`);
  const key = Object.keys(j.result).find((k) => k !== 'last');
  return j.result[key].map((b) => ({ t: b[0] * 1000, o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[6] }));
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

// ---------- setup scoring (same rules as flip-notifier.js scoreSetup) ----------
// Correlation 0-2 (thresholds scale: 16% / 8% of the watchlist) · trend alignment 0-2 · stability 0-1 → WEAK 0-1 / MODERATE 2-3 / STRONG 4-5

const SCORE_EMOJI = { STRONG: '🔥', MODERATE: '⚡', WEAK: '💤' };

function priorFlips(hours) {
  if (!fs.existsSync(ALERTS)) return [];
  const cutoff = Date.now() - hours * 3600e3;
  return fs.readFileSync(ALERTS, 'utf8').trim().split('\n').flatMap((line) => {
    const [ts, , detail, bar] = line.split('\t');
    const m = detail && detail.match(/^(\S+) (?:BUY|SELL) → (BUY|SELL)/);
    if (!m || Date.parse(ts) < cutoff) return [];
    return [{ t: Date.parse(ts), name: m[1], to: m[2], bar: bar ? Date.parse(bar.replace('bar ', '')) : null }];
  });
}

function scoreCore(side, same, regimes, recent) {
  const factors = [];
  let score = 0;
  const n = Object.keys(regimes).length || CFG.symbols.length;
  const strongN = Math.max(4, Math.ceil(0.16 * n)), mildN = Math.max(2, Math.ceil(0.08 * n));   // 25 symbols → 4 / 2
  if (same >= strongN) { score += 2; factors.push(`${same} symbols flipped ${side} together`); }
  else if (same >= mildN) { score += 1; factors.push(`${same} correlated ${side} flips`); }
  else factors.push('isolated flip');
  const vals = Object.values(regimes), total = vals.length;
  const cnt = vals.filter((v) => v === side).length, pct = total ? cnt / total : 0;
  if (pct >= 0.6) { score += 2; factors.push(`trend-aligned (${cnt}/${total} now ${side})`); }
  else if (pct >= 0.4) { score += 1; factors.push(`mixed field (${cnt}/${total} ${side})`); }
  else factors.push(`counter-trend (only ${cnt}/${total} ${side})`);
  if (recent === 0) { score += 1; factors.push('fresh move (no flips in 24h)'); }
  else factors.push(`choppy (${recent} flip${recent > 1 ? 's' : ''} in 24h)`);
  return { score, label: score >= 4 ? 'STRONG' : score >= 2 ? 'MODERATE' : 'WEAK', factors };
}

function scoreSetup(flip, runFlips, regimes) {
  const prior = priorFlips(24);
  // Correlation: same-direction flips on this bar (this run + earlier runs for the same bar)
  const names = new Set(runFlips.filter((f) => f.regime === flip.regime).map((f) => f.name));
  prior.filter((p) => p.bar === flip.barTime && p.to === flip.regime).forEach((p) => names.add(p.name));
  return scoreCore(flip.regime, names.size, regimes, prior.filter((p) => p.name === flip.name).length);
}

// ---------- fair value gaps (added 2026-09-28) ----------
// Confirmed = the 3-candle gap is complete on a CLOSED bar i: bullish when low[i] > high[i-2],
// bearish when high[i] < low[i-2], and the gap is at least fvg.minAtr x ATR(14) (Flux Lab default 0.2).

function atrSeries(bars, n = 14) {
  const out = []; let a = null;
  bars.forEach((b, i) => {
    const pc = i ? bars[i - 1].c : b.c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    a = a == null ? tr : (a * (n - 1) + tr) / n; out.push(a);
  });
  return out;
}

function fvgAt(bars, i, atr, minAtr) {
  if (i < 2) return null;
  const a = bars[i - 2], b = bars[i];
  if (b.l > a.h && b.l - a.h >= minAtr * atr[i]) return { side: 'BULL', top: b.l, bottom: a.h, size: (b.l - a.h) / atr[i] };
  if (b.h < a.l && a.l - b.h >= minAtr * atr[i]) return { side: 'BEAR', top: a.l, bottom: b.h, size: (a.l - b.h) / atr[i] };
  return null;
}

// ---------- multi-timeframe mix (2026-09-28) ----------
// Only the base bars (tfMinutes, 15) are downloaded; 30m and 1h are built locally by merging
// complete groups of base bars, so the mix adds no network requests.
//   flips  : SuperTrend on the base bars (15m)            — best STRONG-flip record
//   rallies: 🚀 bull FVG on >= rallyVolX volume, 30m bars — only TF beating random in both halves
//   gaps   : FVG alerts on 1h bars (futures both sides)   — 1h gaps held 61% vs 34% on 15m
const SIG = { rally: (CFG.signals && CFG.signals.rallyTf) || 30, gap: (CFG.signals && CFG.signals.gapTf) || 60 };

function agg(bars, tfMin) {
  const ms = tfMin * 60000, need = ms / TF_MS;
  if (need <= 1) return bars;
  const out = [];
  let cur = null;
  for (const b of bars) {
    const k = Math.floor(b.t / ms) * ms;
    if (!cur || cur.t !== k) { if (cur && cur.n === need) out.push(cur); cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, n: 1 }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0; cur.n++; }
  }
  if (cur && cur.n === need) out.push(cur);
  return out;
}

function frame(bars, tfMin) {
  const n = bars.length;
  if (n < CFG.atrLen + 15) return null;
  const regs = supertrendRegimes(bars, CFG.factor, CFG.atrLen), atrs = atrSeries(bars);
  const fvg = fvgAt(bars, n - 1, atrs, (CFG.fvg && CFG.fvg.minAtr) || 0.2);
  const prior = bars.slice(Math.max(0, n - 21), n - 1).map((b) => b.v || 0), vavg = prior.reduce((a, x) => a + x, 0) / (prior.length || 1);
  return { tf: tfMin, barTime: bars[n - 1].t, regime: regs[n - 1], fvg, volx: vavg > 0 ? (bars[n - 1].v || 0) / vavg : 0, atr: atrs[n - 1], price: bars[n - 1].c };
}

// ---------- core ----------

async function evaluate(sym) {
  const bars = agg(await core.getBars(sym), (CFG.signals && CFG.signals.flipTf) || 15);
  const now = Date.now();
  const confirmed = bars.filter((b) => b.t + TF_MS <= now);
  if (confirmed.length < CFG.atrLen + 5) throw new Error(`only ${confirmed.length} confirmed bars`);
  const regs = supertrendRegimes(confirmed, CFG.factor, CFG.atrLen);
  const n = confirmed.length;
  const atrs = atrSeries(confirmed);
  const fvg = fvgAt(confirmed, n - 1, atrs, (CFG.fvg && CFG.fvg.minAtr) || 0.2);
  const prior = confirmed.slice(Math.max(0, n - 21), n - 1).map((b) => b.v || 0), vavg = prior.reduce((a, x) => a + x, 0) / (prior.length || 1);
  const volx = vavg > 0 ? (confirmed[n - 1].v || 0) / vavg : 0;
  return { tv: sym.tv, name: sym.tv.split(':')[1], regime: regs[n - 1], prev: regs[n - 2], fvg, volx, atr: atrs[n - 1], price: confirmed[n - 1].c, barTime: confirmed[n - 1].t, ageMin: Math.round((now - confirmed[n - 1].t - TF_MS) / 60000),
           rallyF: frame(agg(confirmed, SIG.rally), SIG.rally), gapF: frame(agg(confirmed, SIG.gap), SIG.gap) };
}

// Run fn over items with at most `limit` in flight (keeps exchanges from throttling).
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function evaluateAll() {
  return pool(CFG.symbols, CFG.concurrency || 8, async (s) => {
    try { return await evaluate(s); } catch (e) { return { tv: s.tv, name: s.tv.split(':')[1], error: e.message }; }
  });
}

function readJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }

function chartRegimes() {
  const s = readJSON(path.join(DIR, 'state.json'), {});
  return s.regimes || {};
}

async function run() {
  const state = readJSON(STATE_FILE, { regimes: {}, bars: {} });
  const results = await evaluateAll();
  const flips = [], fvgs = [], errors = [];
  for (const r of results) {
    if (r.error) { errors.push(`${r.name}: ${r.error}`); continue; }
    // Each frame fires once per new closed bar of its own timeframe; a frame's first sighting only
    // records a baseline (so adding or changing a timeframe never floods the inbox).
    for (const [key, F] of [['rally', r.rallyF], ['gap', r.gapF]]) {
      const seen = (state[`bars_${key}`] = state[`bars_${key}`] || {});
      if (!F || seen[r.tv] === F.barTime) continue;
      if (seen[r.tv] && F.fvg) fvgs.push({ tv: r.tv, name: r.name, kind: key, ...F });
      seen[r.tv] = F.barTime;
    }
    const known = state.regimes[r.tv];
    if (state.bars[r.tv] === r.barTime) continue;           // base bar already processed
    if (known && known !== r.regime) flips.push(r);
    state.regimes[r.tv] = r.regime;
    state.bars[r.tv] = r.barTime;
  }
  state.updated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

  const chartPaused = true /* chart watcher retired 2026-09-28 */;
  const chart = chartPaused ? {} : chartRegimes();
  const ok = results.filter((r) => !r.error);
  const agree = ok.filter((r) => chart[r.tv] === r.regime).length;
  const diff = ok.filter((r) => chart[r.tv] && chart[r.tv] !== r.regime).map((r) => `${r.name}(h:${r.regime}/c:${chart[r.tv]})`);

  // Score BEFORE appending this run's flips, so stability sees only earlier flips.
  for (const f of flips) f.setup = scoreSetup(f, flips, state.regimes);
  const recentGaps = recentFvgs(2);
  for (const f of flips) {
    const want = f.regime === 'BUY' ? 'BULL' : 'BEAR';
    f.star = recentGaps.some((g) => g.name === f.name && g.side === want) || (f.fvg && f.fvg.side === want);
  }
  for (const f of flips) {
    const arrow = f.regime === 'BUY' ? '⬆️' : '⬇️';
    fs.appendFileSync(ALERTS, `${new Date().toISOString()}\t${arrow} ${f.name} → ${f.regime}\t${f.name} ${f.regime === 'BUY' ? 'SELL' : 'BUY'} → ${f.regime}\tbar ${new Date(f.barTime).toISOString()}\t${f.setup.label}:${f.setup.score}\n`);
  }
  // Ledger (#1): every flip is recorded; real-time email only when its kind is PROVEN (#13).
  for (const f of flips) {
    f.asset = assetOf(f.tv); f.side = f.regime === 'BUY' ? 'long' : 'short';
    f.lid = ledger.add({ product: 'headless', kind: `flip:${f.setup.label}`, sym: f.tv, asset: f.asset, tf: 15, side: f.side,
                         t: f.barTime + TF_MS, price: f.price, atr: f.atr, meta: { score: f.setup.score } });
    f.evidence = ledger.isProven('headless', `flip:${f.setup.label}`, ledger.regimeAt(f.asset, f.barTime + TF_MS));
  }
  const minScore = CFG.minScore ?? 2, gate = CFG.gateByEvidence !== false;
  const toSend = flips.filter((f) => (f.setup.score >= minScore || (CFG.flipsEmailConfluence && f.star)) && (!gate || f.evidence.proven));
  for (const f of toSend) {
    const d = f.side === 'short' ? -1 : 1;
    f.ticket = makeTicket(f.lid, { name: f.name, tv: f.tv, side: f.side, price: f.price, stop: f.price - d * f.atr, target: f.price + 2 * d * f.atr });
    ledger.markEmailed(f.lid, f.ticket);
  }
  const held = flips.filter((f) => !toSend.includes(f));
  if (toSend.length && CFG.mode === 'live') await sendEmail(toSend);
  // What you can trade (user, 2026-09-28): futures can be shorted, so both sides; everything else is
  // long-only, so bullish gaps only. All gaps are still logged above.
  const groupOf = Object.fromEntries(CFG.symbols.map((x) => [x.tv, x.group]));
  // Non-futures (2026-09-28 rally lab): only volume-backed bull gaps are emailed, as 🚀 early-rally calls.
  // Bull gap + volume >= rallyVolX x its 20-bar average reached a 2:1 rally (+2 ATR before -1 ATR)
  // 30% / 41% of the time (older / newest third of history) vs 27% / 31% for any bar and 24% / 26%
  // for the SuperTrend BUY flip, firing ~1 bar before the flip. Plain bull gaps: 23% / 30%.
  const rallyX = (CFG.fvg && CFG.fvg.rallyVolX) || 2.5;
  for (const f of fvgs) f.rally = f.kind === 'rally' && groupOf[f.tv] !== 'futures' && f.fvg.side === 'BULL' && f.volx >= rallyX;
  const tradable = fvgs.filter((f) => f.rally || (f.kind === 'gap' && (groupOf[f.tv] === 'futures' ||
    (f.fvg.side === 'BULL' && CFG.fvg && CFG.fvg.nonFuturesMode === 'all'))));
  for (const f of fvgs.filter((x) => x.kind === 'gap' || x.rally)) fs.appendFileSync(path.join(DIR, 'fvg-alerts.tsv'), `${new Date().toISOString()}\t${f.name}\t${f.fvg.side}\t${f.fvg.bottom}\t${f.fvg.top}\t${f.fvg.size.toFixed(2)}\tbar ${new Date(f.barTime).toISOString()}\t${(f.fvg.side === 'BULL') === (f.regime === 'BUY') ? 'star' : ''}\t${f.volx.toFixed(2)}\t${f.rally ? 'rally' : ''}\t${f.tf}m\n`);
  for (const f of tradable) f.star = (f.fvg.side === 'BULL') === (f.regime === 'BUY');   // ⭐ gap with the trend
  // Ledger: every rally and every 1h gap is recorded (non-futures bull gaps too, as 'gap:bull').
  // Bearish non-futures gaps aren't tradable long-only and aren't logged (they were being recorded as
  // 'gap:bull' shorts, contaminating that evidence; removed 2026-09-29).
  for (const f of fvgs.filter((x) => (x.kind === 'gap' || x.rally) && (x.fvg.side === 'BULL' || assetOf(x.tv) === 'future'))) {
    f.asset = assetOf(f.tv); const d = f.fvg.side === 'BULL' ? 1 : -1;
    f.side = d > 0 ? 'long' : 'short'; f.stop = f.price - d * f.atr; f.target = f.price + 2 * d * f.atr;
    f.lkind = f.rally ? 'rally' : f.asset === 'future' ? 'gap:futures' : 'gap:bull';
    f.lid = ledger.add({ product: 'headless', kind: f.lkind, sym: f.tv, asset: f.asset, tf: f.tf, side: f.side, t: f.barTime + f.tf * 60000,
                         price: f.price, stop: f.stop, target: f.target, atr: f.atr, meta: { volx: f.volx, size: f.fvg.size } });
    f.evidence = ledger.isProven('headless', f.lkind, ledger.regimeAt(f.asset, f.barTime + f.tf * 60000));
  }
  let toMail = CFG.fvg && CFG.fvg.onlyConfluence ? tradable.filter((f) => f.star) : tradable;
  if (CFG.gateByEvidence !== false) toMail = toMail.filter((f) => f.evidence && f.evidence.proven);
  for (const f of toMail) { f.ticket = makeTicket(f.lid, f); ledger.markEmailed(f.lid, f.ticket); }
  if (toMail.length && CFG.fvg && CFG.fvg.email && CFG.mode === 'live') sendFvgEmail(toMail);
  log(`${flips.length ? 'FLIPS ' + flips.map((f) => `${f.name}→${f.regime} [${f.setup.label}:${f.setup.score}]`).join(' ') + (held.length ? ` · held back ${held.length} (not emailed)` : '') : 'no flips'} · ${ok.length}/${results.length} ok ` + (chartPaused ? '' : ` · agree with chart ${agree}/${ok.length}`) +
    (diff.length ? ` · differ: ${diff.join(' ')}` : '') + (errors.length ? ` · ERR ${errors.join('; ')}` : '') + ` · mode ${CFG.mode}`);
}

function mail(subject, body, html = false) {
  const { execFileSync } = require('child_process');
  const env = { ...process.env, SEND_EMAIL_HTML: html ? '1' : '0' };
  if (!env.FLIP_GMAIL_APP_PASSWORD) env.FLIP_GMAIL_APP_PASSWORD = execFileSync('security', ['find-generic-password', '-a', 'darup67@gmail.com', '-s', 'flip-notifier-gmail', '-w']).toString().trim();
  execFileSync(process.execPath, [path.join(DIR, 'send-email.js'), subject, body], { env, timeout: 35000, stdio: 'ignore' });
}

function recentFvgs(hours) {
  const f = path.join(DIR, 'fvg-alerts.tsv'), since = Date.now() - hours * 3600e3;
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split('\t'))
    .filter((p) => Date.parse(p[0]) >= since).map((p) => ({ name: p[1], side: p[2] }));
}

// One line of history for an email, from headless-stats.json (refreshed by every matrix report).
function statLine(kind, key) {
  const st = readJSON(path.join(DIR, 'headless-stats.json'), null);
  const v = st && st[kind] && st[kind][key];
  if (!v) return '';
  const p = (x) => (x == null ? '–' : Math.round(100 * x) + '%');
  return kind === 'flips'
    ? `History (${key}, n=${v.n}): right way ${p(v['4h'].right)} after 4h, ${p(v['24h'].right)} after 24h.`
    : `History (${key}, n=${v.n}): price came back into the gap ${p(v.tested)} of the time and held ${p(v.held)}; right way ${p(v['24h'].right)} after 24h.`;
}

function rallyVol() { return (CFG.fvg && CFG.fvg.rallyVolX) || 2.5; }

// Email layout: every email is built from a spec and rendered by email-ui.js (shared by all products).
const UI = require('./email-ui.js');
const ticketFields = (t) => [['Action', t.side], ['Size', t.qty ? `${t.qty} ${t.account.startsWith('futures') ? 'contract' : 'sh'}` : `$${t.notionalUsd}`], ['Limit', `~${t.entry}`], ['Stop', t.stop], ['Target', t.target], ['Risk', `≈ $${t.riskUsd}`]];
const ticketNote = (t) => `Order ticket ${t.id} · ${t.account}. You place it yourself; ask Claude "check ticket ${t.id}" for live quotes.`;
const evidenceLine = (e) => (e ? `Evidence: ${Math.round(100 * e.win)}% net win vs ${Math.round(100 * (e.baseline || 0))}% for random entries (n=${e.n}${e.scope ? ', ' + e.scope : ''}${e.days ? ', ' + e.days + ' days' : ''}).` : null);

function sendFvgEmail(fvgs) {
  const fmt = (x) => (x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : x.toPrecision(4));
  const closed = new Date(Math.max(...fvgs.map((f) => f.barTime + (f.tf || TF_MIN) * 60000))).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const rallies = fvgs.filter((f) => f.rally), fut = fvgs.filter((f) => !f.rally);
  const stars = fvgs.filter((f) => f.star).length;
  const names = fvgs.map((f) => f.name).join(', ');
  const kind = rallies.length && fut.length ? 'Early rally and futures gap' : rallies.length ? 'Early rally' : 'Futures fair value gap';
  const subject = `Flip Watcher · ${kind}: ${names} · ${closed} ET`;
  const cards = fvgs.map((f) => {
    const bull = f.fvg.side === 'BULL', tf = f.tf === 60 ? '1-hour' : `${f.tf}-minute`;
    return { title: f.name, badge: { text: f.rally ? 'EARLY RALLY' : bull ? 'BULL GAP' : 'BEAR GAP', tone: bull ? 'good' : 'bad' },
      sub: (f.rally ? `Bull gap on ${f.volx.toFixed(1)}× average volume (${tf} bars)` : `${bull ? 'Bullish' : 'Bearish'} fair value gap on ${tf} bars`) + ` · trend ${f.regime}${f.star ? ' · gap is in the direction of the trend ⭐' : ''}`,
      fields: f.ticket ? [['Gap range', `${fmt(f.fvg.bottom)} – ${fmt(f.fvg.top)}`], ['Gap size', `${f.fvg.size.toFixed(2)}× ATR`], ...ticketFields(f.ticket)]
                       : [['Gap range', `${fmt(f.fvg.bottom)} – ${fmt(f.fvg.top)}`], ['Gap size', `${f.fvg.size.toFixed(2)}× ATR`], ['Last price', fmt(f.price)]],
      lines: [evidenceLine(f.evidence), f.ticket ? ticketNote(f.ticket) : null].filter(Boolean) };
  });
  const spec = {
    kind: 'Signal alert · ' + kind, status: { text: `${fvgs.length} signal${fvgs.length > 1 ? 's' : ''}${stars ? ` · ${stars} ⭐` : ''}`, tone: 'info' },
    title: `${kind}: ${names}`, subtitle: `Confirmed on bars that closed by ${closed} ET. A fair value gap is a 3-candle jump that left a price range untraded.`,
    sections: [
      { title: 'Signals', blocks: [{ type: 'cards', items: cards }] },
      { title: 'History for these signals', blocks: [{ type: 'list', items: [
        rallies.length ? 'Early rallies: +2 ATR before −1 ATR happened 30% (older data) / 41% (recent) of the time vs 27% / 31% for a random bar. Break-even for 2:1 is 33%. The edge is modest and market-dependent.' : null,
        statLine('gaps', '⭐ with trend') || null, statLine('gaps', 'against trend') || null].filter(Boolean) }] },
      { title: 'How to read this', blocks: [{ type: 'list', items: [
        `Early rally = stocks, ETFs and crypto: a bull gap on at least ${rallyVol()}× average volume (${SIG.rally}-minute bars). Futures: both bullish and bearish gaps on ${SIG.gap === 60 ? '1-hour' : SIG.gap + '-minute'} bars (you can short them).`,
        `Confirmed = the 3-candle gap is complete on a closed bar and at least ${(CFG.fvg.minAtr || 0.2)}× ATR(14). Price often returns to fill a gap, so it is not a signal on its own.`] }] },
    ],
    footer: 'Sent by the Headless Flip Watcher (exchange data, no TradingView).',
  };
  UI.send(subject, spec);
}

async function sendEmail(flips) {
  const best = flips.some((f) => f.setup.label === 'STRONG') ? 'STRONG' : 'MODERATE';
  const names = flips.map((f) => `${f.name} → ${f.regime}`).join(', ');
  const closedAt = (f) => new Date(f.barTime + TF_MS).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const subject = `Flip Watcher · Trend flip: ${names} · ${best}`;
  const cards = flips.map((f) => ({ title: f.name, badge: { text: f.regime, tone: f.regime === 'BUY' ? 'good' : 'bad' },
    sub: `Trend turned ${f.regime} on the ${TF_MIN}-minute chart (bar closed ${closedAt(f)} ET) · setup ${f.setup.label} ${f.setup.score} of 5${f.star ? ' · ⭐ same-direction gap on this ticker in the last 2 hours' : ''}`,
    fields: f.ticket ? ticketFields(f.ticket) : [],
    lines: [evidenceLine(f.evidence), f.ticket ? ticketNote(f.ticket) : null].filter(Boolean) }));
  const spec = {
    kind: 'Signal alert · Trend flip', status: { text: best, tone: best === 'STRONG' ? 'good' : 'warn' },
    title: flips.length === 1 ? `${flips[0].name} turned ${flips[0].regime} on the ${TF_MIN}-minute chart` : `${flips.length} trend flips: ${names}`,
    subtitle: 'A trend flip is a SuperTrend (3, 10) change of direction on a closed bar.',
    sections: [
      { title: 'Signals', blocks: [{ type: 'cards', items: cards }] },
      ...flips.map((f) => ({ title: `Why ${f.name} scores ${f.setup.score} of 5`, blocks: [{ type: 'list', items: f.setup.factors }] })),
      { title: 'History for this kind of signal', blocks: [{ type: 'para', text: [statLine('flips', flips[0].setup.label), flips.some((f) => f.star) ? statLine('flips', '⭐ confluence') : ''].filter(Boolean).join(' ') || 'Not enough history yet.' }] },
    ],
    footer: 'Sent by the Headless Flip Watcher (exchange data, no TradingView).',
  };
  UI.send(subject, spec);
}

// ---------- daily matrix report (08:00 + 16:30, com.dhruv.headlessmatrix) ----------

const MATRIX_FILE = path.join(DIR, 'headless-matrix.json');
const GROUP_ORDER = ['your picks', 'leveraged ETFs', 'futures', 'crypto', 'mega tech', 'semis', 'software/security', 'hardware', 'sector ETFs', 'financials'];

async function matrix(send) {
  const results = await evaluateAll();
  const last = readJSON(MATRIX_FILE, {});
  const since = last.sentAt ? Date.parse(last.sentAt) : Date.now() - 24 * 3600e3;
  const et = (t, opt) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', ...opt });
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const groupOf = Object.fromEntries(CFG.symbols.map((x) => [x.tv, x.group || 'other']));
  const ok = results.filter((r) => !r.error), bad = results.filter((r) => r.error);
  const buys = ok.filter((r) => r.regime === 'BUY').length;

  // flips since the last report (all scores — the report is where MODERATE/WEAK get seen)
  const changes = fs.existsSync(ALERTS) ? fs.readFileSync(ALERTS, 'utf8').trim().split('\n').flatMap((line) => {
    const [ts, , detail, , score] = line.split('\t');
    const m = detail && detail.match(/^(\S+) (BUY|SELL) → (BUY|SELL)/);
    return m && Date.parse(ts) > since ? [{ t: Date.parse(ts), name: m[1], to: m[3], score: score || '' }] : [];
  }) : [];
  const flippedNames = new Set(changes.map((c) => c.name));

  const px = (x) => (x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : x.toPrecision(4));
  const hm = (t) => et(t, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const pc = (x) => (x == null ? '–' : Math.round(100 * x) + '%');
  const hour24 = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  const isAM = hour24 < 12;
  const sells = ok.length - buys;

  // 1. Trend by group: BUY chips first, then SELL; flipped since the last report get an amber ring.
  const chipRows = [];
  for (const g of GROUP_ORDER.concat([...new Set(Object.values(groupOf))].filter((x) => !GROUP_ORDER.includes(x)))) {
    const items = ok.filter((r) => groupOf[r.tv] === g);
    if (!items.length) continue;
    const b = items.filter((r) => r.regime === 'BUY'), sl = items.filter((r) => r.regime === 'SELL');
    chipRows.push({ label: g, sub: `${b.length} of ${items.length} BUY`, chips: b.concat(sl).map((r) => {
      const stale = Date.now() - (r.barTime + TF_MS) > 90 * 60e3;
      return { text: r.name, tone: r.regime === 'BUY' ? 'good' : 'bad', ring: flippedNames.has(r.name), note: stale ? '· ' + et(r.barTime + TF_MS, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '' };
    }) });
  }
  const changeRows = changes.map((c) => ({ t: hm(c.t), name: { v: c.name, bold: true }, to: { v: c.to, tone: c.to === 'BUY' ? 'good' : 'bad', bold: true }, score: c.score || '' }));

  // 2. FVGs and early rallies since the last report, same tradable rule as the FVG emails: bull for all, bear for futures only.
  const futNames = new Set(CFG.symbols.filter((x) => x.group === 'futures').map((x) => x.tv.split(':')[1]));
  const fvgFile = path.join(DIR, 'fvg-alerts.tsv');
  const gaps = fs.existsSync(fvgFile) ? fs.readFileSync(fvgFile, 'utf8').trim().split('\n').flatMap((line) => {
    const [ts, name, side, bottom, top, size, , star, volx, rally] = line.split('\t');
    const show = futNames.has(name) || (side === 'BULL' && (rally === 'rally' || (CFG.fvg && CFG.fvg.nonFuturesMode === 'all')));
    return Date.parse(ts) > since && show
      ? [{ t: Date.parse(ts), name, side, bottom: +bottom, top: +top, size: +size, star: star === 'star', volx: +volx || 0, rally: rally === 'rally' }] : [];
  }) : [];
  const gapRows = gaps.map((g) => ({ t: hm(g.t), name: { v: g.name, bold: true }, kind: { v: (g.rally ? 'Early rally' : g.side === 'BULL' ? 'Bull gap' : 'Bear gap') + (g.star ? ' ⭐' : ''), tone: g.side === 'BULL' ? 'good' : 'bad' },
    range: `${px(g.bottom)} – ${px(g.top)}`, size: `${g.size.toFixed(2)}× ATR`, vol: g.rally ? `${g.volx.toFixed(1)}× volume` : '' }));

  // 3. Brief sections: watchlist (morning), option spreads, crypto, held-back signals, evidence.
  const secs = [];
  let actCount = null, cryptoSection = null, heldSection = null, evidenceSection = null, watchSection = null;
  try {
    const wlFile = path.join(require('os').homedir(), 'market-lab', 'event-desk', 'data', 'digest', new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), 'watchlist.json');
    if (isAM && fs.existsSync(wlFile)) {
      const wl = JSON.parse(fs.readFileSync(wlFile, 'utf8'));
      watchSection = wl.sections ? { blocks: wl.sections.flatMap((s) => s.blocks) }
                                 : { blocks: [{ type: 'raw', html: wl.body, text: String(wl.body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }] };
    }
    const ev = JSON.parse(fs.readFileSync(ledger.EVIDENCE, 'utf8'));
    const evRows = Object.entries(ev.groups).map(([k, v]) => [k, v['*']]).sort((a, b) => (b[1].proven - a[1].proven) || b[1].n - a[1].n)
      .map(([k, r]) => ({ sig: { v: k.replace('|', ' · '), bold: true }, n: String(r.n), win: pc(r.win), rnd: pc(r.baseline), net: r.meanNet == null ? '–' : (100 * r.meanNet).toFixed(2) + '%',
        verdict: { v: r.proven ? 'PROVEN: real-time email' : 'brief only', tone: r.proven ? 'good' : 'neutral', bold: !!r.proven } }));
    evidenceSection = { title: `Evidence: which signals earn a real-time email (last ${ev.windowDays} days, after costs)`,
      note: `Proven = at least ${ev.minN} graded signals over at least ${ev.minDays || 10} separate days, a win rate whose lower bound beats random entries for the same assets, and an average net return still positive after subtracting one standard error. A market-condition slice only overrides the overall record with at least ${ev.regimeMinN || 60} signals. Everything else waits for these briefs.`,
      blocks: [{ type: 'table', columns: [{ key: 'sig', label: 'Signal' }, { key: 'n', label: 'n', align: 'right' }, { key: 'win', label: 'Net win', align: 'right' }, { key: 'rnd', label: 'Random', align: 'right' }, { key: 'net', label: 'Mean net', align: 'right' }, { key: 'verdict', label: 'Verdict' }], rows: evRows }] };
    const dayStart = new Date(new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' })).getTime();
    const spreads = ledger.open().prepare(`SELECT kind, sym, price, meta, ticket FROM signals WHERE product='market-iv' AND t >= ? ORDER BY kind`).all(dayStart);
    if (spreads.length || !isAM) {
      actCount = spreads.length;
      const rows = spreads.map((x) => { const m = JSON.parse(x.meta || '{}'), tk = x.ticket ? JSON.parse(x.ticket) : null;
        return { tk: { v: x.sym.split(':')[1], bold: true }, sector: x.kind.replace('spread:', ''), trade: `Buy ${String(m.exp || '').slice(5)} $${m.long}C / sell $${m.short}C`, px: `$${x.price.toFixed(2)} × ${m.qty}`,
          p: `${Math.round(100 * (m.p_profit || 0))}%`, note: { v: (m.event_before_exp ? 'event before expiry · ' : '') + (tk ? `ticket ${tk.id}` : ''), tone: m.event_before_exp ? 'warn' : 'neutral' } }; });
      secs.push({ title: `Actionable bull call spreads today: ${spreads.length} (market-iv, all sectors)`,
        blocks: [{ type: 'table', empty: 'None passed today.', columns: [{ key: 'tk', label: 'Ticker' }, { key: 'sector', label: 'Sector' }, { key: 'trade', label: 'Trade' }, { key: 'px', label: 'Debit × qty', align: 'right' }, { key: 'p', label: 'P(profit)', align: 'right' }, { key: 'note', label: 'Note' }], rows }] });
    }
    const cs = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'crypto-state.json'), 'utf8')); } catch { return null; } })();
    if (cs && cs.board) {
      const chip = (b) => ({ text: `${b.name} ${b.score > 0 ? '+' : ''}${b.score}`, tone: b.score >= 15 ? 'good' : b.score <= -15 ? 'bad' : 'neutral' });
      const csig = ledger.open().prepare(`SELECT kind, sym, t, price, emailed FROM signals WHERE product='crypto' AND source='live' AND t > ? ORDER BY t`).all(since);
      cryptoSection = { title: `Crypto: ${cs.counts.ok} coins on Coinbase and Robinhood · BTC 24h ${cs.btc24 == null ? '–' : (100 * cs.btc24).toFixed(1) + '%'}`,
        note: 'Bias score runs −100 to +100 (SuperTrend on 15m/1h/4h, EMA stack, RSI, strength vs BTC, volume). It is context only: in testing it did not predict the next 24 hours.',
        blocks: [{ type: 'chipRows', items: [{ label: 'Highest bias', chips: cs.board.slice(0, 12).map(chip) }, { label: 'Lowest bias', chips: cs.board.slice(-8).reverse().map(chip) }] },
          { type: 'table', empty: 'No crypto signals since the last brief.', columns: [{ key: 't', label: 'When' }, { key: 'c', label: 'Coin' }, { key: 'k', label: 'Signal' }, { key: 'p', label: 'Price', align: 'right' }, { key: 'e', label: 'Emailed' }],
            rows: csig.map((x) => ({ t: hm(x.t), c: { v: x.sym.split(':')[1], bold: true }, k: x.kind, p: px(x.price), e: x.emailed ? { v: 'yes', tone: 'good' } : 'held for brief' })) }] };
    }
    const held = ledger.open().prepare(`SELECT kind, sym, side, t, price FROM signals WHERE product='headless' AND source='live' AND emailed=0 AND t > ?
      AND (kind IN ('flip:STRONG','rally','gap:futures')) ORDER BY t`).all(since);
    heldSection = { title: `Held back: not proven enough for a real-time email (${held.length})`,
      blocks: [{ type: 'table', empty: 'None.', columns: [{ key: 't', label: 'When' }, { key: 'tk', label: 'Ticker' }, { key: 'k', label: 'Signal' }, { key: 'd', label: 'Direction' }, { key: 'p', label: 'Price', align: 'right' }],
        rows: held.map((x) => ({ t: hm(x.t), tk: { v: x.sym.split(':')[1], bold: true }, k: x.kind, d: { v: x.side === 'long' ? 'long' : 'short', tone: x.side === 'long' ? 'good' : 'bad' }, p: px(x.price) })) }] };
  } catch (e) { log('brief sections failed: ' + e.message); }
  let scoreSection = null;
  try {
    const st = await require('./headless-stats.js').computeStats();
    scoreSection = { title: `Scoreboard: what happened after past signals (since ${st.from.slice(0, 10)})`,
      note: '"Right" = price moved in the signal\'s direction (BUY/bull long, SELL/bear short). Held = came back into the gap without closing through it. Before fees. History, not advice.',
      blocks: [{ type: 'table', columns: [{ key: 'k', label: 'Trend flips' }, { key: 'n', label: 'n', align: 'right' }, { key: 'r4', label: 'Right after 4h', align: 'right' }, { key: 'r24', label: 'Right after 24h', align: 'right' }],
          rows: Object.entries(st.flips).map(([k, v]) => ({ k: { v: k, bold: true }, n: String(v.n), r4: pc(v['4h'].right), r24: { v: pc(v['24h'].right), bold: true } })) },
        { type: 'table', columns: [{ key: 'k', label: 'Tradable gaps' }, { key: 'n', label: 'n', align: 'right' }, { key: 'tested', label: 'Tested in 24h', align: 'right' }, { key: 'held', label: 'Held', align: 'right' }, { key: 'r24', label: 'Right after 24h', align: 'right' }, { key: 'r21', label: '2:1 rally', align: 'right' }],
          rows: Object.entries(st.gaps).map(([k, v]) => ({ k: { v: k, bold: true }, n: String(v.n), tested: pc(v.tested), held: { v: pc(v.held), bold: true }, r24: pc(v['24h'].right), r21: pc(v.rally21) })) }] };
  } catch (e) { log('scoreboard failed: ' + e.message); }

  const when = et(Date.now(), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const sections = [
    { blocks: [{ type: 'kpis', items: [{ label: 'BUY', value: String(buys), tone: 'good', sub: `of ${ok.length} tickers` }, { label: 'SELL', value: String(sells), tone: 'bad', sub: `${Math.round(100 * sells / (ok.length || 1))}% of tickers` },
      { label: 'Flips', value: String(changes.length), sub: 'since last report' }, { label: 'Gaps and rallies', value: String(gaps.length), sub: 'since last report' }].concat(actCount == null ? [] : [{ label: 'Option spreads', value: String(actCount), sub: 'actionable today' }]) }] },
    { title: 'Trend by group', note: `SuperTrend (3, 10) on closed ${TF_MIN}-minute bars. Amber ring = flipped since the last report. A time after a ticker = its last closed bar is older than 90 minutes (market closed or a lagging feed).${last.buys != null ? ` Last report: ${last.buys} BUY / ${last.sells} SELL.` : ''}`, blocks: [{ type: 'chipRows', items: chipRows }] },
    { title: `Trend flips since the last report (${changes.length})`, blocks: [{ type: 'table', empty: 'No flips.', columns: [{ key: 't', label: 'When' }, { key: 'name', label: 'Ticker' }, { key: 'to', label: 'Now' }, { key: 'score', label: 'Setup' }], rows: changeRows }] },
    { title: `Early rallies and futures gaps since the last report (${gaps.length})`, note: `Early rally = stocks, ETFs and crypto: a bull gap on at least ${(CFG.fvg && CFG.fvg.rallyVolX) || 2.5}× average volume. Futures: bullish and bearish gaps. Gaps of at least ${(CFG.fvg && CFG.fvg.minAtr) || 0.2}× ATR on closed bars.`,
      blocks: [{ type: 'table', empty: 'None.', columns: [{ key: 't', label: 'When' }, { key: 'name', label: 'Ticker' }, { key: 'kind', label: 'Type' }, { key: 'range', label: 'Gap range', align: 'right' }, { key: 'size', label: 'Size', align: 'right' }, { key: 'vol', label: 'Volume', align: 'right' }], rows: gapRows }] },
  ];
  for (const s of [watchSection, ...secs.splice(0), cryptoSection, heldSection, evidenceSection, scoreSection]) if (s) sections.push(s);
  if (bad.length) sections.push({ title: 'No data', blocks: [{ type: 'callout', tone: 'warn', text: bad.map((r) => `${r.name} (${r.error})`).join(', ') }] });
  const emailMode = CFG.flipsEmailConfluence && CFG.minScore > 5 ? 'confluence only' : CFG.minScore >= 4 ? 'STRONG only' : 'MODERATE and STRONG';
  const spec = {
    kind: isAM ? 'Morning brief' : 'Closing brief', status: { text: `${buys} BUY · ${sells} SELL`, tone: buys >= sells ? 'good' : 'bad' },
    title: `${isAM ? 'Morning' : 'Closing'} Brief: Trend Matrix, Gaps and Signals for ${ok.length} Tickers`,
    subtitle: `${when} ET · stocks, ETFs, futures and crypto`,
    sections, footer: `Real-time flip emails: ${emailMode}. Sent by the Headless Flip Watcher.`,
  };
  const subject = `Flip Watcher ${isAM ? 'Morning' : 'Closing'} Brief · ${et(Date.now(), { hour: 'numeric', minute: '2-digit' })} ET · ${buys} BUY / ${sells} SELL` + (changes.length ? ` · ${changes.length} flip${changes.length > 1 ? 's' : ''}` : '') + (gaps.length ? ` · ${gaps.length} gap${gaps.length > 1 ? 's' : ''}` : '');
  const html = UI.render(spec).html;
  if (!send) { fs.writeFileSync(path.join(DIR, 'headless-matrix-preview.html'), html); console.log(subject + '\npreview -> headless-matrix-preview.html'); return; }
  UI.send(subject, spec, { timeoutMs: 60000 });
  if (process.env.EMAIL_SUBJECT_PREFIX) return;   // sample send: leave the real report bookkeeping alone
  fs.writeFileSync(MATRIX_FILE, JSON.stringify({ sentAt: new Date().toISOString(), buys, sells: ok.length - buys }, null, 1));
  log(`MATRIX sent: ${buys} BUY / ${ok.length - buys} SELL · ${changes.length} flips since last`);
}

async function status() {
  const results = await evaluateAll();
  const paused = true /* chart watcher retired 2026-09-28 */;
  const chart = paused ? {} : chartRegimes();
  const state = readJSON(STATE_FILE, { regimes: {} });
  const et = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let agree = 0;
  for (const r of results) {
    if (r.error) { console.log(`${r.name.padEnd(10)} ERROR ${r.error}`); continue; }
    const closed = et(r.barTime + TF_MS);
    const pending = state.regimes[r.tv] && state.regimes[r.tv] !== r.regime ? '  (flip pending: next run emails it)' : '';
    if (paused) { console.log(`${r.name.padEnd(10)} ${r.regime.padEnd(4)}  bar closed ${closed} ET${pending}`); continue; }
    const c = chart[r.tv] || '-';
    if (c === r.regime) agree++;
    console.log(`${r.name.padEnd(10)} headless ${r.regime.padEnd(4)}  chart ${c.padEnd(4)} ${c === r.regime ? ' ' : '≠'}  bar closed ${closed} ET`);
  }
  const ok = results.filter((r) => !r.error);
  const buys = ok.filter((r) => r.regime === 'BUY').length;
  console.log(`\n${ok.length}/${results.length} symbols ok · ${buys} BUY / ${ok.length - buys} SELL · mode ${CFG.mode}, emails ${CFG.flipsEmailConfluence && CFG.minScore > 5 ? '⭐ only' : CFG.flipsEmailConfluence ? `⭐ or score ≥ ${CFG.minScore}` : CFG.minScore >= 4 ? 'STRONG only' : 'MODERATE + STRONG'}` +
    (paused ? ' · chart watcher paused (no comparison)' : ` · agree with chart ${agree}/${ok.length}`));
}

async function reseed() {
  const state = readJSON(STATE_FILE, { regimes: {}, bars: {} }), results = await evaluateAll();
  let changed = 0;
  for (const r of results) if (!r.error) { if (state.regimes[r.tv] !== r.regime) changed++; state.regimes[r.tv] = r.regime; state.bars[r.tv] = r.barTime; }
  state.updated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  log(`RESEED: ${changed} regimes changed by recalculation (not emailed)`);
}

async function fvgReplay(hours) {
  const since = Date.now() - hours * 3600e3, perBar = {};
  await pool(CFG.symbols, CFG.concurrency || 8, async (sym) => {
    try {
      const bars = (await core.getBars(sym)).filter((b) => b.t + TF_MS <= Date.now()), atr = atrSeries(bars);
      for (let i = 2; i < bars.length; i++) if (bars[i].t + TF_MS >= since) {
        const f = fvgAt(bars, i, atr, (CFG.fvg && CFG.fvg.minAtr) || 0.2);
        if (f) (perBar[bars[i].t] = perBar[bars[i].t] || []).push(sym.tv.split(':')[1] + ' ' + f.side);
      }
    } catch (e) { console.log(sym.tv, e.message); }
  });
  const counts = Object.values(perBar).map((a) => a.length), total = counts.reduce((a, b) => a + b, 0);
  console.log(`last ${hours}h: ${total} FVGs on ${counts.length} bars (= emails), ~${(counts.length / (hours / 24)).toFixed(0)} emails/day, max ${Math.max(...counts)} tickers in one bar`);
}

async function replay(hours) {
  // Recompute historical flips from bar history, write them to a temp tsv, compare.
  const since = Date.now() - hours * 3600e3, lines = [];
  await pool(CFG.symbols, CFG.concurrency || 8, async (sym) => {
    try {
      const bars = (await core.getBars(sym)).filter((b) => b.t + TF_MS <= Date.now());
      const regs = supertrendRegimes(bars, CFG.factor, CFG.atrLen);
      for (let i = 1; i < bars.length; i++) {
        const close = bars[i].t + TF_MS;
        if (close >= since && regs[i - 1] && regs[i] !== regs[i - 1])
          lines.push(`${new Date(close).toISOString()}\tr\t${sym.tv.split(':')[1]} ${regs[i - 1]} → ${regs[i]}\n`);
      }
    } catch (e) { console.log(`${sym.tv}: ${e.message}`); }
  });
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

module.exports = { CFG, TF_MS, DIR, SOURCES, pool, supertrendRegimes, scoreCore, atrSeries, fvgAt, sendFvgEmail, sendEmail, mail, agg, SIG };

if (require.main === module) {
const arg = process.argv[2];
(arg === '--reseed' ? reseed() : arg === '--fvg-replay' ? fvgReplay(+process.argv[3] || 72) : arg === '--matrix' ? matrix(true) : arg === '--matrix-preview' ? matrix(false) : arg === '--status' ? status() : arg === '--replay' ? replay(+process.argv[3] || 72) : arg === '--compare' ? Promise.resolve(compare(+process.argv[3] || 48)) : run())
  .catch((e) => { log('FATAL ' + (e.stack || e.message)); process.exit(1); });
}
