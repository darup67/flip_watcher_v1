#!/usr/bin/env node
// Crypto scanner (2026-09-29): every coin you can trade on Robinhood, Coinbase or Coinbase Wallet,
// with the same signals as the stock/ETF watcher plus a bias score, wired into trade-core.
//
// Universe (rebuilt daily, crypto-universe.json):
//   Robinhood  robinhood-crypto.json — from the Robinhood MCP (Claude-only; refreshed by a monthly
//              Claude scheduled task). Coins halted only in some states are kept, with the states.
//   Coinbase   public Advanced Trade market API: USD spot pairs, online, >= $2M 24h volume.
//   Wallet     GeckoTerminal top pools on Base and Solana: >= $1M liquidity, >= 7 days old, token not
//              on an exchange above (brand-new launches are coin-launch-agent's job).
//   Stablecoins and wrapped assets are excluded. The 10 coins the headless watcher already signals
//   are scored for bias here but signal there (no duplicate alerts).
// Signals (long-only: spot crypto can't be shorted on Robinhood/Coinbase):
//   flip:<label>  SuperTrend(3,10) BUY on 15m, scored 0-5 within the crypto field
//   rally         🚀 bull FVG on 30m with >= 2.5x volume (the tested early-rally trigger)
//   gap:bull      bull FVG on 1h
// Bias score (-100..+100): SuperTrend 15m/1h/4h (±15 each), 1h EMA20/50 stack (±15), RSI14 1h (±20),
//   24h strength vs BTC (±10), volume surge in the direction of the move (±10).
// Every signal goes to the ledger (product "crypto"); real-time email only when PROVEN; the rest and
// the bias board go into the briefs (crypto-state.json).
//
//   node crypto-scan.js              one scan (com.dhruv.cryptoscan, :06 :21 :36 :51)
//   node crypto-scan.js --universe   rebuild the universe now
//   node crypto-scan.js --backfill   replay history into the ledger (evidence from day one)
//   node crypto-scan.js --bias-lab   does the bias score predict the next 24h? (by bucket, both halves)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const H = require('./headless-flip.js');
const core = require(path.join(os.homedir(), 'trade-core', 'bars.js'));
const ledger = require(path.join(os.homedir(), 'trade-core', 'ledger.js'));

const DIR = __dirname;
const UNI = path.join(DIR, 'crypto-universe.json'), STATE = path.join(DIR, 'crypto-state.json'), LOG = path.join(DIR, 'crypto-scan.log');
const CFG = H.CFG, TF = 15 * 60000, minAtr = (CFG.fvg && CFG.fvg.minAtr) || 0.2, rallyX = (CFG.fvg && CFG.fvg.rallyVolX) || 2.5;
const STABLE = new Set(['USDC', 'USDT', 'DAI', 'PYUSD', 'USDG', 'EURC', 'GUSD', 'USDS', 'FDUSD', 'TUSD', 'USDP', 'RLUSD', 'USD1', 'EUROC', 'USDE', 'LUSD', 'FRAX', 'GHO', 'CRVUSD', 'SUSD', 'USDB', 'XSGD']);
const WRAPPED = new Set(['WBTC', 'CBBTC', 'WETH', 'WSOL', 'SOL', 'ETH', 'CBETH', 'WSTETH', 'STETH', 'RETH', 'MSOL', 'JITOSOL', 'BSOL', 'WEETH', 'EZETH', 'TBTC', 'LBTC']);
const log = (m) => { const l = `${new Date().toISOString()}  ${m}`; fs.appendFileSync(LOG, l + '\n'); if (process.stdout.isTTY) console.log(l); };
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const getJSON = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`); return r.json(); };

// ---------------------------------------------------------------- universe
async function buildUniverse() {
  const rh = readJSON(path.join(DIR, 'robinhood-crypto.json'), { coins: {} }).coins;
  const cb = {};
  const j = await getJSON('https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT&limit=1000');
  for (const p of j.products || []) {
    if (p.quote_currency_id !== 'USD' || p.status !== 'online' || p.trading_disabled || p.is_disabled) continue;
    cb[p.base_currency_id] = { usdVol: (+p.volume_24h || 0) * (+p.price || 0), name: p.base_name };
  }
  const core10 = new Set(CFG.symbols.filter((s) => s.group === 'crypto').map((s) => s.tv.split(':')[1].replace(/USDT?$/, '')));
  const coins = new Set([...Object.keys(rh), ...Object.keys(cb).filter((b) => cb[b].usdVol >= 2e6)]);
  const symbols = [];
  for (const b of [...coins].sort()) {
    if (STABLE.has(b) || (WRAPPED.has(b) && b !== 'ETH' && b !== 'SOL')) continue;
    const onCb = !!cb[b];
    symbols.push({ tv: `CRYPTO:${b}`, name: b, group: 'crypto', source: onCb ? 'coinbase' : 'binance', ticker: onCb ? `${b}-USD` : `${b}USDT`,
                   venues: { robinhood: !!rh[b], coinbase: onCb, haltedIn: (rh[b] && rh[b].halted_regions) || [] },
                   usdVol24h: onCb ? Math.round(cb[b].usdVol) : null, signals: !core10.has(b) });
  }
  // Coinbase Wallet: onchain tokens with real liquidity that no exchange above lists
  const listed = new Set(symbols.map((s) => s.name));
  const STOCK_TOKEN = /tokeni[sz]ed|xstock|backed|\bstock\b|ondo global|dinari|\(ondo\)/i;
  const usTickers = new Set(CFG.symbols.filter((x) => x.tv.startsWith('US:') || x.tv.startsWith('BATS:')).map((x) => x.tv.split(':')[1]));
  for (const net of ['base', 'solana']) {
    const seen = new Set(); let kept = 0;
    for (const page of [1, 2]) {
      try {
        const g = await getJSON(`https://api.geckoterminal.com/api/v2/networks/${net}/pools?sort=h24_volume_usd_desc&page=${page}&include=base_token`);
        const tok = Object.fromEntries((g.included || []).map((t) => [t.id, t.attributes]));
        for (const p of g.data || []) {
          const a = p.attributes, bt = tok[p.relationships && p.relationships.base_token && p.relationships.base_token.data.id] || {};
          const sym = String(bt.symbol || String(a.name || '').split(' / ')[0]).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
          const tname = String(bt.name || '');
          const ageD = (Date.now() - Date.parse(a.pool_created_at)) / 864e5;
          const stockLike = STOCK_TOKEN.test(tname) || usTickers.has(sym.replace(/(ON|C|X)$/, ''));
          if (!sym || seen.has(sym) || listed.has(sym) || STABLE.has(sym) || WRAPPED.has(sym) || stockLike) continue;
          // >= $1M liquidity, >= 7 days old, and turnover <= 20x liquidity (46x on BSW looked like wash trading)
          if (+a.reserve_in_usd < 1e6 || ageD < 7 || +a.volume_usd.h24 > 20 * +a.reserve_in_usd) continue;
          seen.add(sym); kept++;
          symbols.push({ tv: `${net.toUpperCase()}:${sym}`, name: sym, fullName: tname, group: 'crypto', source: 'gecko', ticker: `${net}:${a.address}`, onchain: net,
                         venues: { wallet: net }, usdVol24h: Math.round(+a.volume_usd.h24 || 0), liquidityUsd: Math.round(+a.reserve_in_usd), signals: true });
          if (kept >= 8) break;
        }
      } catch (e) { log(`universe: gecko ${net} p${page} failed ${e.message}`); }
      await new Promise((r) => setTimeout(r, 6500));
      if (kept >= 8) break;
    }
  }
  const u = { updated: new Date().toISOString(), counts: { robinhood: symbols.filter((s) => s.venues.robinhood).length,
              coinbase: symbols.filter((s) => s.venues.coinbase).length, wallet: symbols.filter((s) => s.onchain).length, total: symbols.length }, symbols };
  fs.writeFileSync(UNI, JSON.stringify(u, null, 1));
  log(`universe: ${u.counts.total} coins (Robinhood ${u.counts.robinhood}, Coinbase ${u.counts.coinbase}, Wallet ${u.counts.wallet})`);
  return u;
}

async function universe() {
  const u = readJSON(UNI, null);
  return u && Date.now() - Date.parse(u.updated) < 20 * 3600e3 ? u : buildUniverse();
}

// ---------------------------------------------------------------- indicators
const ema = (xs, n) => { const k = 2 / (n + 1); let e = null; return xs.map((x) => (e = e == null ? x : x * k + e * (1 - k))); };
function rsi(closes, n = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= n && i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const clamp = (x, a) => Math.max(-a, Math.min(a, x));

/** Bias score on bars up to index end (15m base). btc24 = BTC's 24h return at the same time. */
function bias(b15, end, btc24) {
  const b = b15.slice(0, end + 1); if (b.length < 400) return null;
  const h1 = H.agg(b, 60), h4 = H.agg(b, 240); if (h1.length < 60 || h4.length < 20) return null;
  const st = (bars) => { const r = H.supertrendRegimes(bars, CFG.factor, CFG.atrLen); return r[r.length - 1] === 'BUY' ? 1 : -1; };
  const c1 = h1.map((x) => x.c), e20 = ema(c1, 20), e50 = ema(c1, 50), last = c1.length - 1;
  const parts = {
    trend: 15 * (st(b) + st(h1) + st(h4)),
    stack: c1[last] > e20[last] && e20[last] > e50[last] ? 15 : c1[last] < e20[last] && e20[last] < e50[last] ? -15 : 0,
    rsi: clamp((rsi(c1) - 50) * 0.8, 20),
  };
  const i24 = Math.max(0, b.length - 1 - 96), ret24 = b[b.length - 1].c / b[i24].c - 1;
  parts.rs = btc24 == null ? 0 : clamp((ret24 - btc24) * 200, 10);
  const v = b.map((x) => x.v || 0), vNow = v.slice(-96).reduce((a, x) => a + x, 0), vPrev = v.slice(-96 * 7, -96).reduce((a, x) => a + x, 0) / 6;
  parts.volume = vPrev > 0 && vNow >= 1.5 * vPrev ? (ret24 >= 0 ? 10 : -10) : 0;
  const score = Math.round(Object.values(parts).reduce((a, x) => a + x, 0));
  return { score, parts, ret24, label: score >= 40 ? 'strong bull' : score >= 15 ? 'bull' : score <= -40 ? 'strong bear' : score <= -15 ? 'bear' : 'neutral' };
}

/** Signal candidates on the last closed bar of each frame (live) — also used by the replay. */
function frameSignals(b15, i15) {
  const out = [];
  const b = b15.slice(0, i15 + 1);
  const regs = H.supertrendRegimes(b, CFG.factor, CFG.atrLen), n = b.length;
  if (regs[n - 1] === 'BUY' && regs[n - 2] === 'SELL') out.push({ kind: 'flip', tf: 15, bar: b[n - 1], atr: H.atrSeries(b)[n - 1] });
  for (const [tf, kind] of [[30, 'rally'], [60, 'gap:bull']]) {
    const f = H.agg(b, tf); if (f.length < 30) continue;
    // only when the last base bar completes this frame's bar
    if ((b[n - 1].t + TF) % (tf * 60000) !== 0) continue;
    const k = f.length - 1, atr = H.atrSeries(f), g = H.fvgAt(f, k, atr, minAtr);
    if (!g || g.side !== 'BULL') continue;
    const pr = f.slice(Math.max(0, k - 20), k).map((x) => x.v || 0), avg = pr.reduce((a, x) => a + x, 0) / (pr.length || 1);
    const volx = avg > 0 ? (f[k].v || 0) / avg : 0;
    if (kind === 'rally' && volx < rallyX) continue;
    out.push({ kind, tf, bar: f[k], atr: atr[k], volx, size: g.size });
  }
  return out;
}

const assetOf = (s) => (s.onchain ? 'dex' : 'crypto');
const account = (s) => (s.venues.robinhood ? `Robinhood crypto${s.venues.haltedIn.length ? ` (halted in ${s.venues.haltedIn.join(', ')})` : ''}`
  : s.venues.coinbase ? 'Coinbase' : `Coinbase Wallet (${s.onchain})`);
function ticket(lid, s, price, stop, target) {
  let h = 0; for (const ch of lid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const risk = (CFG.tickets && CFG.tickets.riskUsd) || 100;
  return { id: 'C' + h.toString(36).toUpperCase().slice(0, 5), sym: s.name, side: 'BUY', entry: +price.toPrecision(6), stop: +stop.toPrecision(6),
           target: +target.toPrecision(6), riskUsd: risk, notionalUsd: Math.round((risk / Math.abs(price - stop)) * price), account: account(s) };
}

// ---------------------------------------------------------------- scan
async function scan() {
  const u = await universe();
  const st = readJSON(STATE, { regimes: {}, seen: {}, recentFlips: {} });
  const btc = await core.getBars(CFG.symbols.find((s) => s.tv === 'BITSTAMP:BTCUSD'));
  const btc24 = btc.length > 97 ? btc[btc.length - 1].c / btc[btc.length - 97].c - 1 : null;
  const results = await H.pool(u.symbols, 8, async (s) => {
    try { const b = (await core.getBars(s)).filter((x) => x.t + TF <= Date.now()); return b.length > 60 ? { s, b } : { s, err: `${b.length} bars` }; }
    catch (e) { return { s, err: e.message }; }
  });
  const ok = results.filter((r) => r.b), board = [], signals = [];
  const regimes = {};
  for (const r of ok) {
    const n = r.b.length, regs = H.supertrendRegimes(r.b, CFG.factor, CFG.atrLen);
    regimes[r.s.tv] = regs[n - 1];
    const bi = bias(r.b, n - 1, btc24);
    if (bi) board.push({ tv: r.s.tv, name: r.s.name, price: r.b[n - 1].c, ...bi, venues: r.s.venues, onchain: r.s.onchain || null, signals: r.s.signals });
    if (!r.s.signals) continue;
    for (const sig of frameSignals(r.b, n - 1)) {
      const key = `${r.s.tv}|${sig.kind}`, t = sig.bar.t + sig.tf * 60000;
      if (st.seen[key] === t) continue;
      const first = st.seen[key] === undefined; st.seen[key] = t;
      if (first && sig.kind !== 'flip') continue;             // first sighting of a frame = baseline only
      if (sig.kind === 'flip' && !st.regimes[r.s.tv]) continue; // need a prior regime to call it a flip
      signals.push({ s: r.s, ...sig, t, bias: bi });
    }
  }
  // score flips within the crypto field (same 0-5 rules as stocks)
  const flips = signals.filter((x) => x.kind === 'flip');
  for (const f of flips) {
    const recent = (st.recentFlips[f.s.tv] || []).filter((t) => t > Date.now() - 864e5).length;
    const sc = H.scoreCore('BUY', flips.length, regimes, recent);
    f.kind = `flip:${sc.label}`; f.score = sc.score; f.factors = sc.factors;
    st.recentFlips[f.s.tv] = [...(st.recentFlips[f.s.tv] || []).filter((t) => t > Date.now() - 864e5), f.t];
  }
  st.regimes = { ...st.regimes, ...regimes };
  // ledger + gating + tickets
  const mailed = [];
  for (const x of signals) {
    const price = x.bar.c, stop = price - x.atr, target = price + 2 * x.atr, asset = assetOf(x.s);
    x.lid = ledger.add({ product: 'crypto', kind: x.kind, sym: x.s.tv, asset, tf: x.tf, side: 'long', t: x.t, price, stop, target, atr: x.atr,
                         meta: { volx: x.volx, size: x.size, score: x.score, bias: x.bias && x.bias.score, venues: x.s.venues } });
    x.evidence = ledger.isProven('crypto', x.kind, ledger.regimeAt(asset, x.t));
    const live = (CFG.crypto && CFG.crypto.realtimeKinds) || ['flip:STRONG'];
    if (!live.includes(x.kind) || (CFG.gateByEvidence !== false && !x.evidence.proven)) continue;
    x.ticket = ticket(x.lid, x.s, price, stop, target); ledger.markEmailed(x.lid, x.ticket); mailed.push(x);
  }
  if (mailed.length && CFG.mode === 'live') email(mailed);
  board.sort((a, b) => b.score - a.score);
  fs.writeFileSync(STATE, JSON.stringify({ ...st, updated: new Date().toISOString(), btc24, board,
    counts: { ...u.counts, ok: ok.length, failed: results.length - ok.length },
    lastSignals: signals.map((x) => ({ tv: x.s.tv, name: x.s.name, kind: x.kind, t: x.t, price: x.bar.c, bias: x.bias && x.bias.score, emailed: !!x.ticket })) }, null, 1));
  log(`${ok.length}/${results.length} coins · ${signals.length ? 'signals ' + signals.map((x) => `${x.s.name}:${x.kind}`).join(' ') : 'no signals'} · emailed ${mailed.length}` +
      ` · top bias ${board.slice(0, 3).map((b) => `${b.name} ${b.score}`).join(', ')}` + (results.length - ok.length ? ` · failed ${results.filter((r) => r.err).map((r) => r.s.name).slice(0, 8).join(',')}` : ''));
}

function email(xs) {
  const et = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const label = (k) => (k === 'rally' ? '🚀 EARLY RALLY (30m)' : k === 'gap:bull' ? '🟩 bull gap (1h)' : `⬆️ ${k.replace('flip:', '')} flip → BUY (15m)`);
  const subject = `🪙 Crypto ${et(Math.max(...xs.map((x) => x.t)))}: ` + xs.map((x) => `${x.s.name} ${x.kind === 'rally' ? '🚀' : x.kind.startsWith('flip') ? '⬆️' : '🟩'}`).join(', ');
  const body = xs.map((x) => `${label(x.kind)}  ${x.s.name}${x.s.onchain ? ` (${x.s.onchain} onchain)` : ''} · price ${x.bar.c.toPrecision(6)}` +
    (x.volx ? ` · ${x.volx.toFixed(1)}× volume` : '') + (x.bias ? ` · bias ${x.bias.score >= 0 ? '+' : ''}${x.bias.score} (${x.bias.label})` : '') +
    `\n  🎫 ${x.ticket.id}: BUY $${x.ticket.notionalUsd} of ${x.s.name}, stop ${x.ticket.stop}, target ${x.ticket.target} (risk ≈ $${x.ticket.riskUsd}) · ${x.ticket.account} · you place it yourself; say "check ticket ${x.ticket.id}" for live quotes` +
    `\n  evidence: ${Math.round(100 * x.evidence.win)}% net win vs ${Math.round(100 * (x.evidence.baseline || 0))}% random (n=${x.evidence.n}, ${x.evidence.days} days)`).join('\n\n') +
    '\n\nOnly signal types the trade-core ledger has proven (after costs, vs random entry) are emailed; everything else is in the 08:55 / 16:30 briefs.\nNot advice.\n— Crypto scanner';
  H.mail(subject, body);
}

// ---------------------------------------------------------------- research: replay + bias lab
async function history() {
  const u = await universe();
  const btc = await core.getBars(CFG.symbols.find((s) => s.tv === 'BITSTAMP:BTCUSD'), { days: 45, fetchNew: false });
  const series = (await H.pool(u.symbols, 8, async (s) => { try { const b = await core.getBars(s, { days: 45 }); return b.length > 500 ? { s, b } : null; } catch { return null; } })).filter(Boolean);
  const btcAt = new Map(btc.map((x, i) => [x.t, i >= 96 ? x.c / btc[i - 96].c - 1 : null]));
  return { series, btcAt };
}

async function backfill() {
  const { series } = await history();
  // clear earlier crypto replay rows so labels are recomputed consistently
  const d = ledger.open();
  d.exec("DELETE FROM outcomes WHERE id IN (SELECT id FROM signals WHERE product='crypto' AND source='backfill')");
  d.exec("DELETE FROM signals WHERE product='crypto' AND source='backfill'");
  // flips scored exactly like live: the whole crypto field at each bar (same-direction count, regime map, 24h chop)
  const regsBy = new Map(), flipsByT = new Map();
  for (const x of series) {
    const regs = H.supertrendRegimes(x.b, CFG.factor, CFG.atrLen); regsBy.set(x.s.tv, regs); x.flipT = [];
    for (let i = 401; i < x.b.length; i++) if (regs[i] === 'BUY' && regs[i - 1] === 'SELL') { x.flipT.push(x.b[i].t); if (x.s.signals) (flipsByT.get(x.b[i].t) || flipsByT.set(x.b[i].t, []).get(x.b[i].t)).push({ x, i }); }
  }
  const regAt = (x, t) => { const b = x.b; let lo = 0, hi = b.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m].t <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a < 0 ? null : regsBy.get(x.s.tv)[a]; };
  let n = 0;
  for (const [t, list] of flipsByT) {
    const regimes = {}; for (const x of series) { const r = regAt(x, t); if (r) regimes[x.s.tv] = r; }
    for (const { x, i } of list) {
      const recent = x.flipT.filter((u) => u < t && u >= t - 864e5).length, { label, score } = H.scoreCore('BUY', list.length, regimes, recent);
      const atr = H.atrSeries(x.b.slice(0, i + 1))[i], p = x.b[i].c;
      ledger.add({ product: 'crypto', kind: `flip:${label}`, sym: x.s.tv, asset: assetOf(x.s), tf: 15, side: 'long', t: t + TF, price: p, stop: p - atr, target: p + 2 * atr, atr,
                   meta: { score, replay: true }, source: 'backfill' }); n++;
    }
  }
  for (const { s, b } of series) {
    if (!s.signals) continue;
    const seen = {};
    for (let i = 400; i < b.length; i++) for (const sig of frameSignals(b, i)) {
      if (sig.kind === 'flip') continue;
      const t = sig.bar.t + sig.tf * 60000; if (seen[sig.kind] === t) continue; seen[sig.kind] = t;
      ledger.add({ product: 'crypto', kind: sig.kind, sym: s.tv, asset: assetOf(s), tf: sig.tf, side: 'long', t, price: sig.bar.c, stop: sig.bar.c - sig.atr,
                   target: sig.bar.c + 2 * sig.atr, atr: sig.atr, meta: { volx: sig.volx, size: sig.size, replay: true }, source: 'backfill' }); n++;
    }
  }
  const g = ledger.grade(), ev = ledger.evidence();
  const days = (Date.now() - Math.min(...series.map((x) => x.b[400].t))) / 864e5;
  console.log(`crypto backfill: ${n} signals from ${series.length} coins over ~${days.toFixed(0)} days · graded ${g}`);
  for (const [k, v] of Object.entries(ev.groups)) if (k.startsWith('crypto|')) { const r = v['*'];
    console.log(`  ${k.padEnd(22)} n ${String(r.n).padStart(5)} (${(r.n / days).toFixed(1)}/day) days ${String(r.days).padStart(3)}  win ${(100 * r.win).toFixed(0)}%  random ${r.baseline == null ? '–' : (100 * r.baseline).toFixed(0) + '%'}  mean net ${r.meanNet == null ? '–' : (100 * r.meanNet).toFixed(2) + '%'}  ${r.proven ? 'PROVEN' : 'not proven'}`); }
}

async function biasLab() {
  const { series, btcAt } = await history();
  const rows = [];
  for (const { s, b } of series) for (let i = 400; i + 96 < b.length; i += 16) {
    const bi = bias(b, i, btcAt.get(b[i].t)); if (!bi) continue;
    rows.push({ t: b[i].t, label: bi.label, ret: b[i + 96].c / b[i].c - 1 - ledger.roundTrip(assetOf(s), b[i].t) });
  }
  rows.sort((a, b) => a.t - b.t); const mid = rows[rows.length >> 1].t;
  console.log(`bias lab: ${rows.length} observations (every 4h per coin), next-24h return after costs, long\n`);
  console.log('bucket         n      up%    mean     older up%  newer up%');
  for (const L of ['strong bull', 'bull', 'neutral', 'bear', 'strong bear']) {
    const g = rows.filter((r) => r.label === L); if (!g.length) continue;
    const up = (a) => a.length ? Math.round(100 * a.filter((r) => r.ret > 0).length / a.length) + '%' : '–';
    console.log(`${L.padEnd(12)} ${String(g.length).padStart(6)}  ${up(g).padStart(5)}  ${(100 * g.reduce((a, r) => a + r.ret, 0) / g.length).toFixed(2).padStart(6)}%    ${up(g.filter((r) => r.t < mid)).padStart(5)}     ${up(g.filter((r) => r.t >= mid)).padStart(5)}`);
  }
}

module.exports = { bias, frameSignals, buildUniverse, email };
if (require.main === module) {
  const a = process.argv[2];
  (a === '--universe' ? buildUniverse().then(() => {}) : a === '--backfill' ? backfill() : a === '--bias-lab' ? biasLab() : scan())
    .catch((e) => { log('FATAL ' + (e.stack || e.message)); process.exit(1); });
}
