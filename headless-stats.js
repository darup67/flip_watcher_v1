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
const { CFG, TF_MS, DIR, SOURCES, pool, supertrendRegimes, scoreCore, atrSeries, fvgAt } = require('./headless-flip.js');

const OUT = path.join(DIR, 'headless-stats.json');
const H = { '1h': 3600e3, '4h': 4 * 3600e3, '24h': 24 * 3600e3 };
const CONFLUENCE_MS = 2 * 3600e3;

function exitPrice(bars, i, ms) {
  // close of the last bar that closed by entry + ms; null if history doesn't reach that far yet
  const target = bars[i].t + TF_MS + ms;
  if (bars[bars.length - 1].t + TF_MS < target) return null;
  let j = i;
  while (j + 1 < bars.length && bars[j + 1].t + TF_MS <= target) j++;
  return bars[j].c;
}

const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a) => (a.length ? a.filter(Boolean).length / a.length : null);

async function computeStats() {
  const minAtr = (CFG.fvg && CFG.fvg.minAtr) || 0.2;
  const series = (await pool(CFG.symbols, CFG.concurrency || 8, async (sym) => {
    try {
      const bars = (await SOURCES[sym.source](sym.ticker)).filter((b) => b.t + TF_MS <= Date.now());
      if (bars.length < CFG.atrLen + 5) return null;
      return { sym, name: sym.tv.split(':')[1], fut: sym.group === 'futures', bars,
               regs: supertrendRegimes(bars, CFG.factor, CFG.atrLen), atr: atrSeries(bars) };
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
      const g = s.regs[i] ? fvgAt(s.bars, i, s.atr, minAtr) : null;
      if (g && (g.side === 'BULL' || s.fut)) {
        const prior = s.bars.slice(Math.max(0, i - 20), i).map((b) => b.v || 0), avg = prior.reduce((a, x) => a + x, 0) / (prior.length || 1);
        const volx = avg > 0 ? (s.bars[i].v || 0) / avg : 0;
        gaps.push({ s, i, g, star: (g.side === 'BULL') === (s.regs[i] === 'BUY'), rally: !s.fut && g.side === 'BULL' && volx >= ((CFG.fvg && CFG.fvg.rallyVolX) || 2.5) });
      }
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
      const star = gaps.some((x) => x.s === f.s && x.i <= f.i && f.s.bars[f.i].t - f.s.bars[x.i].t <= CONFLUENCE_MS
                                    && (x.g.side === 'BULL') === (f.side === 'BUY'));
      const dir = f.side === 'BUY' ? 1 : -1, entry = f.s.bars[f.i].c, ret = {};
      for (const [k, ms] of Object.entries(H)) { const x = exitPrice(f.s.bars, f.i, ms); ret[k] = x == null ? null : dir * (x / entry - 1); }
      flipRows.push({ label, star, ret, fut: f.s.fut });
    }
  }

  const rally21 = (s, i) => {   // +2 ATR before -1 ATR within 48 bars (the tested early-rally setup)
    const up = s.bars[i].c + 2 * s.atr[i], dn = s.bars[i].c - s.atr[i];
    for (let j = i + 1; j <= i + 48 && j < s.bars.length; j++) { if (s.bars[j].l <= dn) return 0; if (s.bars[j].h >= up) return 1; }
    return i + 48 < s.bars.length ? 0 : null;
  };
  const gapRows = gaps.map(({ s, i, g, star, rally }) => {
    const dir = g.side === 'BULL' ? 1 : -1, entry = s.bars[i].c, end = s.bars[i].t + TF_MS + H['24h'];
    const complete = s.bars[s.bars.length - 1].t + TF_MS >= end;
    let tested = false, broken = false;
    for (let j = i + 1; j < s.bars.length && s.bars[j].t + TF_MS <= end; j++) {
      const b = s.bars[j];
      if (dir > 0 ? b.l <= g.top : b.h >= g.bottom) tested = true;
      if (dir > 0 ? b.c < g.bottom : b.c > g.top) broken = true;
    }
    const ret = {};
    for (const k of ['4h', '24h']) { const x = exitPrice(s.bars, i, H[k]); ret[k] = x == null ? null : dir * (x / entry - 1); }
    return { star, rally, fut: s.fut, complete, tested, broken, ret, r21: g.side === 'BULL' ? rally21(s, i) : null };
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
  const gapStats = { '🚀 early rally': gstats(gapRows.filter((x) => x.rally)), '⭐ with trend': gstats(gapRows.filter((x) => x.star)), 'against trend': gstats(gapRows.filter((x) => !x.star)),
                     'all tradable': gstats(gapRows) };
  const first = Math.min(...series.map((s) => s.bars[0].t));
  const stats = { updated: new Date().toISOString(), from: new Date(first).toISOString(), symbols: series.length,
                  minAtr, flips, gaps: gapStats };
  fs.writeFileSync(OUT, JSON.stringify(stats, null, 1));
  return stats;
}

function fmt(stats) {
  const p = (x) => (x == null ? '  –' : `${Math.round(100 * x)}%`.padStart(4));
  const r = (x) => (x == null ? '    –' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`.padStart(6));
  const L = [`Signal scoreboard · ${stats.symbols} symbols · history since ${stats.from.slice(0, 10)}`, '',
    'FLIPS (BUY = long, SELL = short; "right" = moved the right way)',
    '                  n   right 1h  right 4h  right 24h   median 4h  median 24h'];
  for (const [k, v] of Object.entries(stats.flips))
    L.push(`${k.padEnd(14)} ${String(v.n).padStart(5)}   ${p(v['1h'].right)}      ${p(v['4h'].right)}      ${p(v['24h'].right)}      ${r(v['4h'].median)}     ${r(v['24h'].median)}`);
  L.push('', `GAPS (bull all, bear futures only; ≥ ${stats.minAtr}× ATR; within 24h)`,
    '                  n   tested  broken  held*   right 4h  right 24h  median 24h  2:1 rally');
  for (const [k, v] of Object.entries(stats.gaps))
    L.push(`${k.padEnd(14)} ${String(v.n).padStart(5)}    ${p(v.tested)}    ${p(v.broken)}   ${p(v.held)}      ${p(v['4h'].right)}      ${p(v['24h'].right)}     ${r(v['24h'].median)}     ${p(v.rally21)}`);
  L.push('', '* held = came back into the gap and did not close through it. Before fees and slippage; history, not advice.');
  return L.join('\n');
}

module.exports = { computeStats, fmt, OUT };

if (require.main === module) computeStats().then((s) => console.log(fmt(s))).catch((e) => { console.error(e); process.exit(1); });
