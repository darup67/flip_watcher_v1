#!/usr/bin/env node
// Signal scoreboard for the headless watcher (added 2026-09-28): does acting on a flip or a gap pay?
//
// Replays every symbol's bar history (Yahoo ~30d, crypto sources ~6-20d) and rebuilds each flip and
// each tradable FVG exactly as the live watcher would have seen it: same SuperTrend, same 0-5 score,
// same FVG rule and size threshold, same tradable rule (bull gaps for all, bear gaps futures-only).
// Then it measures what came next from the signal's bar close:
//   flips  — direction-adjusted return after 1h / 4h / 24h (BUY = long, SELL = short) and how often
//            it went the right way; split by label (STRONG/MODERATE/WEAK) and ⭐ confluence.
//   gaps   — within 24h: did price come back into the gap (tested), close through its far side
//            (broken), and the direction-adjusted return at 4h / 24h; split by ⭐ confluence.
// ⭐ confluence: a gap in the direction of the symbol's current trend (bull gap while BUY, bear gap
// while SELL), or a flip that follows a same-direction tradable gap on that symbol within 2h.
//
// Recomputed on every matrix report (it's a pure replay, so it backfills itself and stays current).
//   node headless-stats.js          print the scoreboard and write headless-stats.json
const fs = require('fs');
const path = require('path');
const { CFG, TF_MS, DIR, SOURCES, pool, supertrendRegimes, scoreCore, atrSeries, fvgAt, agg, SIG } = require('./headless-flip.js');

const OUT = path.join(DIR, process.env.HEADLESS_TF ? `headless-stats-${process.env.HEADLESS_TF}m.json` : 'headless-stats.json');   // research runs don't touch the live file
const H = { '1h': 3600e3, '4h': 4 * 3600e3, '24h': 24 * 3600e3 };
const CONFLUENCE_MS = 2 * 3600e3;
const DAY_BARS = Math.round(24 * 3600e3 / TF_MS);   // 24h of bars at the configured timeframe

function exitPrice(bars, i, ms, barMs = TF_MS) {
  // close of the last bar that closed by entry + ms; null if history doesn't reach that far yet
  const target = bars[i].t + barMs + ms;
  if (bars[bars.length - 1].t + barMs < target) return null;
  let j = i;
  while (j + 1 < bars.length && bars[j + 1].t + barMs <= target) j++;
  return bars[j].c;
}

const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a) => (a.length ? a.filter(Boolean).length / a.length : null);

async function computeStats() {
  const minAtr = (CFG.fvg && CFG.fvg.minAtr) || 0.2;
  const series = (await pool(CFG.symbols, CFG.concurrency || 8, async (sym) => {
    try {
      const bars = (await require(require('path').join(require('os').homedir(), 'trade-core', 'bars.js')).getBars(sym)).filter((b) => b.t + TF_MS <= Date.now());
      if (bars.length < CFG.atrLen + 5) return null;
      const mk = (tf) => { const b = agg(bars, tf); return { tf, ms: tf * 60000, bars: b, regs: supertrendRegimes(b, CFG.factor, CFG.atrLen), atr: atrSeries(b) }; };
      return { sym, name: sym.tv.split(':')[1], fut: sym.group === 'futures', bars,
               regs: supertrendRegimes(bars, CFG.factor, CFG.atrLen), atr: atrSeries(bars), fRally: mk(SIG.rally), fGap: mk(SIG.gap) };
    } catch { return null; }
  })).filter(Boolean);

  // Per-bar events across all symbols (bars share a 30m grid), so scoring sees the whole field.
  const flipsByT = new Map(), gaps = [];
  for (const s of series) {
    s.flipIdx = [];
    for (let i = 1; i < s.bars.length; i++) {
      if (s.regs[i] && s.regs[i - 1] && s.regs[i] !== s.regs[i - 1]) {
        s.flipIdx.push(i);
        const t = s.bars[i].t;
        (flipsByT.get(t) || flipsByT.set(t, []).get(t)).push({ s, i, side: s.regs[i] });
      }
    }
    // gaps on the gap frame (1h): bull for all, bear for futures; rallies on the rally frame (30m)
    const volxAt = (F, i) => { const pr = F.bars.slice(Math.max(0, i - 20), i).map((b) => b.v || 0), a = pr.reduce((x, y) => x + y, 0) / (pr.length || 1); return a > 0 ? (F.bars[i].v || 0) / a : 0; };
    for (let i = 2; i < s.fGap.bars.length; i++) {
      const g = s.fGap.regs[i] ? fvgAt(s.fGap.bars, i, s.fGap.atr, minAtr) : null;
      if (g && (g.side === 'BULL' || s.fut)) gaps.push({ s, F: s.fGap, i, g, star: (g.side === 'BULL') === (s.fGap.regs[i] === 'BUY'), rally: false });
    }
    if (!s.fut) for (let i = 2; i < s.fRally.bars.length; i++) {
      const g = s.fRally.regs[i] ? fvgAt(s.fRally.bars, i, s.fRally.atr, minAtr) : null;
      if (g && g.side === 'BULL' && volxAt(s.fRally, i) >= ((CFG.fvg && CFG.fvg.rallyVolX) || 2.5))
        gaps.push({ s, F: s.fRally, i, g, star: s.fRally.regs[i] === 'BUY', rally: true });
    }
  }
  const regimeAt = (s, t) => {   // regime as of the latest bar at or before t
    let lo = 0, hi = s.bars.length - 1, ans = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (s.bars[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans == null ? null : s.regs[ans];
  };

  const flipRows = [];
  for (const [t, list] of flipsByT) {
    const regimes = {};
    for (const s of series) { const r = regimeAt(s, t); if (r) regimes[s.sym.tv] = r; }
    for (const f of list) {
      const same = list.filter((x) => x.side === f.side).length;
      const recent = f.s.flipIdx.filter((j) => j < f.i && f.s.bars[j].t >= t - 24 * 3600e3).length;
      const { label } = scoreCore(f.side, same, regimes, recent);
      const tf = f.s.bars[f.i].t + TF_MS;
      const star = gaps.some((x) => { const tg = x.F.bars[x.i].t + x.F.ms; return x.s === f.s && tg <= tf && tf - tg <= CONFLUENCE_MS
                                      && (x.g.side === 'BULL') === (f.side === 'BUY'); });
      const dir = f.side === 'BUY' ? 1 : -1, entry = f.s.bars[f.i].c, ret = {};
      for (const [k, ms] of Object.entries(H)) { const x = exitPrice(f.s.bars, f.i, ms); ret[k] = x == null ? null : dir * (x / entry - 1); }
      flipRows.push({ label, star, ret, fut: f.s.fut, t });
    }
  }

  const rally21 = (F, i) => {   // +2 ATR before -1 ATR within 24h (the tested early-rally setup), on F's own bars
    const day = Math.round(24 * 3600e3 / F.ms), up = F.bars[i].c + 2 * F.atr[i], dn = F.bars[i].c - F.atr[i];
    for (let j = i + 1; j <= i + day && j < F.bars.length; j++) { if (F.bars[j].l <= dn) return 0; if (F.bars[j].h >= up) return 1; }
    return i + day < F.bars.length ? 0 : null;
  };
  const gapRows = gaps.map(({ s, F, i, g, star, rally }) => {
    const dir = g.side === 'BULL' ? 1 : -1, entry = F.bars[i].c, end = F.bars[i].t + F.ms + H['24h'];
    const complete = F.bars[F.bars.length - 1].t + F.ms >= end;
    let tested = false, broken = false;
    for (let j = i + 1; j < F.bars.length && F.bars[j].t + F.ms <= end; j++) {
      const b = F.bars[j];
      if (dir > 0 ? b.l <= g.top : b.h >= g.bottom) tested = true;
      if (dir > 0 ? b.c < g.bottom : b.c > g.top) broken = true;
    }
    const ret = {};
    for (const k of ['4h', '24h']) { const x = exitPrice(F.bars, i, H[k], F.ms); ret[k] = x == null ? null : dir * (x / entry - 1); }
    return { star, rally, fut: s.fut, complete, tested, broken, ret, r21: g.side === 'BULL' ? rally21(F, i) : null, t: F.bars[i].t };
  });

  const summarize = (rows, keys) => {
    const o = { n: rows.length };
    for (const k of keys) {
      const r = rows.map((x) => x.ret[k]).filter((x) => x != null);
      o[k] = { n: r.length, right: pct(r.map((x) => x > 0)), median: med(r) };
    }
    return o;
  };
  const flips = {};
  for (const label of ['STRONG', 'MODERATE', 'WEAK']) flips[label] = summarize(flipRows.filter((x) => x.label === label), Object.keys(H));
  flips['⭐ confluence'] = summarize(flipRows.filter((x) => x.star), Object.keys(H));
  flips['all'] = summarize(flipRows, Object.keys(H));
  const gstats = (rows) => {
    const c = rows.filter((x) => x.complete);
    return { ...summarize(rows, ['4h', '24h']), done24h: c.length,
             tested: pct(c.map((x) => x.tested)), broken: pct(c.map((x) => x.broken)),
             held: pct(c.filter((x) => x.tested).map((x) => !x.broken)),
             rally21: pct(rows.map((x) => x.r21).filter((x) => x != null).map(Boolean)) };
  };
  const gapStats = { '🚀 early rally': gstats(gapRows.filter((x) => x.rally)), '⭐ with trend': gstats(gapRows.filter((x) => !x.rally && x.star)), 'against trend': gstats(gapRows.filter((x) => !x.rally && !x.star)),
                     'all gaps': gstats(gapRows.filter((x) => !x.rally)) };
  // Trust check: does each group hold in both halves of history, and does it beat random entry?
  const all = flipRows.concat(gapRows).map((x) => x.t).sort((a, b) => a - b), mid = all[all.length >> 1];
  const half = (rows, get) => [rows.filter((x) => x.t < mid), rows.filter((x) => x.t >= mid)].map((h) => {
    const v = h.map(get).filter((x) => x != null); return { n: v.length, rate: pct(v.map(Boolean)) };
  });
  const r24 = (x) => (x.ret['24h'] == null ? null : x.ret['24h'] > 0), r21 = (x) => x.r21;
  const baseRows = [];   // random entry: every 8th bar, long, non-futures
  for (const s of series) if (!s.fut) for (let i = 30; i < s.fRally.bars.length; i += 4) {
    const F = s.fRally, x = exitPrice(F.bars, i, H['24h'], F.ms); baseRows.push({ t: F.bars[i].t, ret: { '24h': x == null ? null : x / F.bars[i].c - 1 }, r21: rally21(F, i) });
  }
  const split = {
    'flips STRONG (right 24h)': half(flipRows.filter((x) => x.label === 'STRONG'), r24),
    'flips ⭐ (right 24h)': half(flipRows.filter((x) => x.star), r24),
    'flips all (right 24h)': half(flipRows, r24),
    '🚀 early rally (2:1)': half(gapRows.filter((x) => x.rally), r21),
    'random long entry (2:1)': half(baseRows, r21),
    'random long entry (up 24h)': half(baseRows, r24),
  };
  const first = Math.min(...series.map((s) => s.bars[0].t));
  const stats = { updated: new Date().toISOString(), from: new Date(first).toISOString(), symbols: series.length,
                  minAtr, flips, gaps: gapStats, split, tf: TF_MS / 60000, mix: { flips: TF_MS / 60000, rally: SIG.rally, gaps: SIG.gap } };
  fs.writeFileSync(OUT, JSON.stringify(stats, null, 1));
  return stats;
}

function fmt(stats) {
  const p = (x) => (x == null ? '  –' : `${Math.round(100 * x)}%`.padStart(4));
  const r = (x) => (x == null ? '    –' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`.padStart(6));
  const L = [`Signal scoreboard · ${stats.symbols} symbols · history since ${stats.from.slice(0, 10)} · flips ${stats.mix.flips}m, 🚀 ${stats.mix.rally}m, gaps ${stats.mix.gaps}m`, '',
    'FLIPS (BUY = long, SELL = short; "right" = moved the right way)',
    '                  n   right 1h  right 4h  right 24h   median 4h  median 24h'];
  for (const [k, v] of Object.entries(stats.flips))
    L.push(`${k.padEnd(14)} ${String(v.n).padStart(5)}   ${p(v['1h'].right)}      ${p(v['4h'].right)}      ${p(v['24h'].right)}      ${r(v['4h'].median)}     ${r(v['24h'].median)}`);
  L.push('', `GAPS (🚀 on ${stats.mix.rally}m bars; others on ${stats.mix.gaps}m: bull all, bear futures only; ≥ ${stats.minAtr}× ATR; within 24h)`,
    '                  n   tested  broken  held*   right 4h  right 24h  median 24h  2:1 rally');
  for (const [k, v] of Object.entries(stats.gaps))
    L.push(`${k.padEnd(14)} ${String(v.n).padStart(5)}    ${p(v.tested)}    ${p(v.broken)}   ${p(v.held)}      ${p(v['4h'].right)}      ${p(v['24h'].right)}     ${r(v['24h'].median)}     ${p(v.rally21)}`);
  L.push('', '* held = came back into the gap and did not close through it. Before fees and slippage; history, not advice.');
  return L.join('\n');
}

module.exports = { computeStats, fmt, OUT };

if (require.main === module) computeStats().then((s) => console.log(fmt(s))).catch((e) => { console.error(e); process.exit(1); });
