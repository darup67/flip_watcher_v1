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
const TF_MIN = CFG.tfMinutes || 30;
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
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${TF_MIN}m&range=30d${ext}`);
  const res = j.chart.result[0];
  const q = res.indicators.quote[0];
  return (res.timestamp || []).map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume ? q.volume[i] || 0 : 0 }))
    .filter((b) => b.o != null && b.h != null && b.l != null && b.c != null)
    // With includePrePost Yahoo also returns off-grid points (e.g. 5:26:40 PM, zero volume): a stale
    // last trade, not a 30m bar. One produced a false BLK flip + 2.9x ATR "gap" (2026-09-28 18:01).
    .filter((b) => b.t % TF_MS === 0);
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
  const j = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${TF_MIN}m&limit=1000`);
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

// ---------- core ----------

async function evaluate(sym) {
  const bars = await SOURCES[sym.source](sym.ticker);
  const now = Date.now();
  const confirmed = bars.filter((b) => b.t + TF_MS <= now);
  if (confirmed.length < CFG.atrLen + 5) throw new Error(`only ${confirmed.length} confirmed bars`);
  const regs = supertrendRegimes(confirmed, CFG.factor, CFG.atrLen);
  const n = confirmed.length;
  const atrs = atrSeries(confirmed);
  const fvg = fvgAt(confirmed, n - 1, atrs, (CFG.fvg && CFG.fvg.minAtr) || 0.2);
  const prior = confirmed.slice(Math.max(0, n - 21), n - 1).map((b) => b.v || 0), vavg = prior.reduce((a, x) => a + x, 0) / (prior.length || 1);
  const volx = vavg > 0 ? (confirmed[n - 1].v || 0) / vavg : 0;
  return { tv: sym.tv, name: sym.tv.split(':')[1], regime: regs[n - 1], prev: regs[n - 2], fvg, volx, atr: atrs[n - 1], price: confirmed[n - 1].c, barTime: confirmed[n - 1].t, ageMin: Math.round((now - confirmed[n - 1].t - TF_MS) / 60000) };
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
    const known = state.regimes[r.tv];
    if (state.bars[r.tv] === r.barTime) continue;           // bar already processed
    if (known && known !== r.regime) flips.push(r);
    if (r.fvg && state.bars[r.tv]) fvgs.push(r);            // skip a symbol's very first bar (no baseline yet)
    state.regimes[r.tv] = r.regime;
    state.bars[r.tv] = r.barTime;
  }
  state.updated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

  const chartPaused = fs.existsSync(path.join(DIR, 'CHART_WATCHER_PAUSED'));
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
  const minScore = CFG.minScore ?? 2;
  const toSend = flips.filter((f) => f.setup.score >= minScore || (CFG.flipsEmailConfluence && f.star));
  const held = flips.filter((f) => !toSend.includes(f));
  if (toSend.length && CFG.mode === 'live') await sendEmail(toSend);
  for (const f of fvgs) fs.appendFileSync(path.join(DIR, 'fvg-alerts.tsv'), `${new Date().toISOString()}\t${f.name}\t${f.fvg.side}\t${f.fvg.bottom}\t${f.fvg.top}\t${f.fvg.size.toFixed(2)}\tbar ${new Date(f.barTime).toISOString()}\t${(f.fvg.side === 'BULL') === (f.regime === 'BUY') ? 'star' : ''}\t${f.volx.toFixed(2)}\t${f.rally ? 'rally' : ''}\n`);
  // What you can trade (user, 2026-09-28): futures can be shorted, so both sides; everything else is
  // long-only, so bullish gaps only. All gaps are still logged above.
  const groupOf = Object.fromEntries(CFG.symbols.map((x) => [x.tv, x.group]));
  // Non-futures (2026-09-28 rally lab): only volume-backed bull gaps are emailed, as 🚀 early-rally calls.
  // Bull gap + volume >= rallyVolX x its 20-bar average reached a 2:1 rally (+2 ATR before -1 ATR)
  // 30% / 41% of the time (older / newest third of history) vs 27% / 31% for any bar and 24% / 26%
  // for the SuperTrend BUY flip, firing ~1 bar before the flip. Plain bull gaps: 23% / 30%.
  const rallyX = (CFG.fvg && CFG.fvg.rallyVolX) || 2.5;
  for (const f of fvgs) f.rally = groupOf[f.tv] !== 'futures' && f.fvg.side === 'BULL' && f.volx >= rallyX;
  const tradable = fvgs.filter((f) => groupOf[f.tv] === 'futures' || (f.fvg.side === 'BULL' && (f.rally || (CFG.fvg && CFG.fvg.nonFuturesMode === 'all'))));
  for (const f of tradable) f.star = (f.fvg.side === 'BULL') === (f.regime === 'BUY');   // ⭐ gap with the trend
  const toMail = CFG.fvg && CFG.fvg.onlyConfluence ? tradable.filter((f) => f.star) : tradable;
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

function sendFvgEmail(fvgs) {
  const fmt = (x) => (x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : x.toPrecision(4));
  const closed = new Date(fvgs[0].barTime + TF_MS).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const bull = fvgs.filter((f) => f.fvg.side === 'BULL'), bear = fvgs.filter((f) => f.fvg.side === 'BEAR');
  const stars = fvgs.filter((f) => f.star).length, rallies = fvgs.filter((f) => f.rally);
  const fut = fvgs.filter((f) => !f.rally);   // futures gaps (both sides), or plain bull gaps if nonFuturesMode = 'all'
  const futTxt = fut.length ? `${fut.length} FVG (${fut.map((f) => `${f.name} ${f.fvg.side === 'BULL' ? '🟩' : '🟥'}`).join(', ')})` : '';
  const subject = rallies.length
    ? `🚀 Early rally ${closed}: ${rallies.map((f) => f.name).join(', ')}${futTxt ? ' · ' + futTxt : ''}`
    : `🟩🟥 FVG ${closed}${stars ? ` ⭐${stars}` : ''}: ${futTxt}`;
  const line = (f) => f.rally
    ? `🚀 ${f.name}  EARLY RALLY · bull gap ${fmt(f.fvg.bottom)} – ${fmt(f.fvg.top)} on ${f.volx.toFixed(1)}× volume · entry ~${fmt(f.price)}, stop ${fmt(f.price - f.atr)} (−1 ATR), target ${fmt(f.price + 2 * f.atr)} (+2 ATR) · trend ${f.regime}${f.star ? ' ⭐' : ''}`
    : `${f.star ? '⭐' : '  '}${f.fvg.side === 'BULL' ? '🟩' : '🟥'} ${f.name}  gap ${fmt(f.fvg.bottom)} – ${fmt(f.fvg.top)}  (${f.fvg.size.toFixed(2)}× ATR)  last ${fmt(f.price)}  · trend ${f.regime}`;
  const body = `Signals confirmed on the ${TF_MIN}m bar that closed ${closed} ET.\n🚀 = early rally (stocks/ETFs/crypto): bull gap on ≥ ${rallyVol()}× average volume. Futures: bullish and bearish gaps (shortable).\n\n` + [...rallies, ...fut].map(line).join('\n') +
    (rallies.length ? `\n\nEarly-rally history: +2 ATR before −1 ATR hit 30% (older) / 41% (recent) of the time vs 27% / 31% for a random bar; break-even for 2:1 is 33%. Edge is modest and market-dependent.` : '') +
    `\n\n⭐ = gap in the direction of the ticker's trend. ${statLine('gaps', '⭐ with trend')}\n${statLine('gaps', 'against trend')}` +
    `\n\nConfirmed = 3-candle gap complete on a closed bar, at least ${(CFG.fvg.minAtr || 0.2)}× ATR(14). Price often returns to fill a gap; not a signal on its own. Not advice.\n— Headless Flip Watcher`;
  mail(subject, body);
}

async function sendEmail(flips) {
  const best = flips.some((f) => f.setup.label === 'STRONG') ? '🔥' : '⚡';
  const subject = `${best} ${flips.map((f) => `${f.regime === 'BUY' ? '⬆️' : '⬇️'} ${f.name} → ${f.regime}`).join(' · ')}`;
  const body = flips.map((f) => `${f.star ? '⭐ ' : ''}${f.regime === 'BUY' ? '⬆️' : '⬇️'} ${f.name} → ${f.regime}  ${SCORE_EMOJI[f.setup.label]} ${f.setup.label} (${f.setup.score}/5)\n` +
    (f.star ? '  · ⭐ confluence: same-direction FVG on this ticker in the last 2h\n' : '') +
    f.setup.factors.map((x) => `  · ${x}`).join('\n') + `\n  · ${TF_MIN}m bar closed ${new Date(f.barTime + TF_MS).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET`).join('\n\n') +
    `\n\n${statLine('flips', flips[0].setup.label)}${flips.some((f) => f.star) ? '\n' + statLine('flips', '⭐ confluence') : ''}` +
    '\n\n— Headless Flip Watcher (exchange data, no TradingView)';
  mail(subject, body);
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

  const chip = (r) => {
    const buy = r.regime === 'BUY', stale = Date.now() - (r.barTime + TF_MS) > 90 * 60e3;
    return `<td style="padding:5px 8px;border-radius:4px;background:${buy ? '#089981' : '#f23645'};color:#fff;font:600 12px -apple-system,Helvetica,Arial;white-space:nowrap${flippedNames.has(r.name) ? ';outline:2px solid #f5a623' : ''}">${esc(r.name)}${stale ? ' <span style="opacity:.75;font-weight:400">·' + esc(et(r.barTime + TF_MS, { weekday: 'short', hour: 'numeric', minute: '2-digit' })) + '</span>' : ''}</td>`;
  };
  const rows = [];
  for (const g of GROUP_ORDER.concat([...new Set(Object.values(groupOf))].filter((x) => !GROUP_ORDER.includes(x)))) {
    const items = ok.filter((r) => groupOf[r.tv] === g);
    if (!items.length) continue;
    const b = items.filter((r) => r.regime === 'BUY'), sl = items.filter((r) => r.regime === 'SELL');
    const cells = b.concat(sl);
    const lines = [];
    for (let i = 0; i < cells.length; i += 7) lines.push('<tr>' + cells.slice(i, i + 7).map(chip).join('\n') + '</tr>');
    rows.push(`<tr><td style="padding:10px 10px 4px 0;vertical-align:top;font:600 13px -apple-system,Helvetica,Arial;color:#222;white-space:nowrap">${esc(g)}<br><span style="font-weight:400;color:#666">${b.length}/${items.length} BUY</span></td>` +
      `<td style="padding-top:6px"><table cellspacing="3" cellpadding="0">\n${lines.join('\n')}\n</table></td></tr>`);
  }
  const when = et(Date.now(), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const changeHtml = changes.length
    ? changes.map((c) => `<li>${esc(et(c.t, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))} · <b>${esc(c.name)}</b> → <span style="color:${c.to === 'BUY' ? '#089981' : '#f23645'};font-weight:600">${c.to}</span> <span style="color:#888">${esc(c.score)}</span></li>`).join('\n')
    : '<li style="color:#888">none</li>';
  // FVGs since the last report, same tradable rule as the FVG emails: bull for all, bear for futures only.
  const futNames = new Set(CFG.symbols.filter((x) => x.group === 'futures').map((x) => x.tv.split(':')[1]));
  const fvgFile = path.join(DIR, 'fvg-alerts.tsv');
  const gaps = fs.existsSync(fvgFile) ? fs.readFileSync(fvgFile, 'utf8').trim().split('\n').flatMap((line) => {
    const [ts, name, side, bottom, top, size, , star, volx, rally] = line.split('\t');
    const show = futNames.has(name) || (side === 'BULL' && (rally === 'rally' || (CFG.fvg && CFG.fvg.nonFuturesMode === 'all')));
    return Date.parse(ts) > since && show
      ? [{ t: Date.parse(ts), name, side, bottom: +bottom, top: +top, size: +size, star: star === 'star', volx: +volx || 0, rally: rally === 'rally' }] : [];
  }) : [];
  const px = (x) => (x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : x.toPrecision(4));
  const gapHtml = gaps.length
    ? gaps.map((g) => `<li>${esc(et(g.t, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))} · ${g.rally ? '🚀' : ''}${g.star ? '⭐' : ''}${g.side === 'BULL' ? '🟩' : '🟥'} <b>${esc(g.name)}</b>${g.rally ? ` <span style="color:#089981">early rally, ${g.volx.toFixed(1)}× vol</span>` : ''} ${px(g.bottom)} – ${px(g.top)} <span style="color:#888">${g.size.toFixed(2)}× ATR</span></li>`).join('\n')
    : '<li style="color:#888">none</li>';
  let board = '';
  try {
    const st = await require('./headless-stats.js').computeStats();
    const p = (x) => (x == null ? '–' : Math.round(100 * x) + '%');
    const td = (x, b) => `<td style="padding:2px 8px;text-align:right${b ? ';font-weight:600' : ''}">${x}</td>`;
    const fr = Object.entries(st.flips).map(([k, v]) => `<tr><td style="padding:2px 8px">${esc(k)}</td>${td(v.n)}${td(p(v['4h'].right))}${td(p(v['24h'].right), 1)}</tr>`).join('\n');
    const gr = Object.entries(st.gaps).map(([k, v]) => `<tr><td style="padding:2px 8px">${esc(k)}</td>${td(v.n)}${td(p(v.tested))}${td(p(v.held), 1)}${td(p(v['24h'].right))}${td(p(v.rally21))}</tr>`).join('\n');
    const th = (a) => a.map((x) => `<th style="padding:2px 8px;text-align:right;color:#666;font-weight:400">${x}</th>`).join('');
    board = `<h3 style="margin:18px 0 4px">Scoreboard: what happened after past signals (since ${esc(st.from.slice(0, 10))})</h3>
<table cellspacing="0" style="font-size:13px;border-collapse:collapse"><tr><th style="text-align:left;padding:2px 8px">Flips</th>${th(['n', 'right 4h', 'right 24h'])}</tr>
${fr}
</table>
<table cellspacing="0" style="font-size:13px;border-collapse:collapse;margin-top:8px"><tr><th style="text-align:left;padding:2px 8px">Tradable gaps</th>${th(['n', 'tested 24h', 'held', 'right 24h', '2:1 rally'])}</tr>
${gr}
</table>
<div style="color:#666;font-size:12px">"Right" = moved in the signal's direction (BUY/bull long, SELL/bear short). Held = came back into the gap without closing through it. Before fees; history, not advice.</div>`;
  } catch (e) { log('scoreboard failed: ' + e.message); }
  const html = `<div style="font:14px -apple-system,Helvetica,Arial;color:#222;max-width:760px">
<h2 style="margin:0 0 4px">Flip matrix · ${esc(when)} ET</h2>
<div style="font-size:15px;margin-bottom:12px"><b style="color:#089981">${buys} BUY</b> / <b style="color:#f23645">${ok.length - buys} SELL</b> of ${ok.length} · ${Math.round(100 * (ok.length - buys) / (ok.length || 1))}% SELL${last.buys != null ? ` · last report ${last.buys} BUY / ${last.sells} SELL` : ''}</div>
<table cellspacing="0" cellpadding="0">
${rows.join('\n')}
</table>
<h3 style="margin:18px 0 4px">Flips since last report (${changes.length})</h3>
<ul style="margin:0;padding-left:18px">
${changeHtml}
</ul>
<h3 style="margin:18px 0 4px">🚀 Early rallies & futures FVGs since last report (${gaps.length})</h3>
<div style="color:#666;font-size:12px;margin-bottom:4px">🚀 = stocks/ETFs/crypto bull gap on ≥ ${(CFG.fvg && CFG.fvg.rallyVolX) || 2.5}× average volume (early rally). Futures: bullish and bearish gaps. Gaps ≥ ${(CFG.fvg && CFG.fvg.minAtr) || 0.2}× ATR on closed ${TF_MIN}m bars.</div>
<ul style="margin:0;padding-left:18px">
${gapHtml}
</ul>
${board}
<p style="color:#666;font-size:12px;margin-top:16px">SuperTrend 3/10 on closed ${TF_MIN}m bars. Orange outline = flipped since last report. A time after a ticker = its last closed bar is older than 90 min (market closed or a lagging feed).${bad.length ? '<br><b style="color:#f23645">No data:</b> ' + esc(bad.map((r) => r.name + ' (' + r.error + ')').join(', ')) : ''}<br>Flip alerts email ${CFG.flipsEmailConfluence && CFG.minScore > 5 ? '⭐ confluence only' : CFG.minScore >= 4 ? 'STRONG only' : 'MODERATE + STRONG'} · Headless Flip Watcher · not trading advice.</p>
</div>`;
  const subject = `📊 Flip matrix ${et(Date.now(), { hour: 'numeric', minute: '2-digit' })} · ${buys} BUY / ${ok.length - buys} SELL` + (changes.length ? ` · ${changes.length} flip${changes.length > 1 ? 's' : ''}` : '') + (gaps.length ? ` · ${gaps.length} FVG${gaps.length > 1 ? 's' : ''}` : '');
  if (!send) { fs.writeFileSync(path.join(DIR, 'headless-matrix-preview.html'), html); console.log(subject + '\npreview -> headless-matrix-preview.html'); return; }
  mail(subject, html, true);
  fs.writeFileSync(MATRIX_FILE, JSON.stringify({ sentAt: new Date().toISOString(), buys, sells: ok.length - buys }, null, 1));
  log(`MATRIX sent: ${buys} BUY / ${ok.length - buys} SELL · ${changes.length} flips since last`);
}

async function status() {
  const results = await evaluateAll();
  const paused = fs.existsSync(path.join(DIR, 'CHART_WATCHER_PAUSED'));
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
      const bars = (await SOURCES[sym.source](sym.ticker)).filter((b) => b.t + TF_MS <= Date.now()), atr = atrSeries(bars);
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
      const bars = (await SOURCES[sym.source](sym.ticker)).filter((b) => b.t + TF_MS <= Date.now());
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

module.exports = { CFG, TF_MS, DIR, SOURCES, pool, supertrendRegimes, scoreCore, atrSeries, fvgAt, sendFvgEmail };

if (require.main === module) {
const arg = process.argv[2];
(arg === '--reseed' ? reseed() : arg === '--fvg-replay' ? fvgReplay(+process.argv[3] || 72) : arg === '--matrix' ? matrix(true) : arg === '--matrix-preview' ? matrix(false) : arg === '--status' ? status() : arg === '--replay' ? replay(+process.argv[3] || 72) : arg === '--compare' ? Promise.resolve(compare(+process.argv[3] || 48)) : run())
  .catch((e) => { log('FATAL ' + (e.stack || e.message)); process.exit(1); });
}
