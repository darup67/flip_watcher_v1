#!/usr/bin/env node
// Rally lab (2026-09-28): which bull trigger catches rallies EARLIER than the SuperTrend BUY flip,
// on everything except futures? Chosen on the older 2/3 of history, confirmed on the newest 1/3.
//
// Rally = within 48 bars, the high reaches entry + 2×ATR before the low reaches entry − 1×ATR
//         (a 2:1 reward/risk trade, so 33% is break-even before fees).
// Lead  = bars before the next SuperTrend(3,10) BUY flip on that symbol (within 16 bars).
const { CFG, TF_MS, SOURCES, pool, supertrendRegimes, atrSeries, fvgAt } = require('./headless-flip.js');

const ema = (xs, n) => { const k = 2 / (n + 1); let e = null; return xs.map((x) => (e = e == null ? x : x * k + e * (1 - k))); };
const sma = (xs, n) => xs.map((_, i) => { if (i < n) return null; let s = 0; for (let j = i - n; j < i; j++) s += xs[j]; return s / n; });   // prior n bars

function features(bars) {
  const c = bars.map((b) => b.c), v = bars.map((b) => b.v || 0);
  const f = { atr: atrSeries(bars), e9: ema(c, 9), e21: ema(c, 21), e50: ema(c, 50), vavg: sma(v, 20),
              st: supertrendRegimes(bars, 3, 10), fast: supertrendRegimes(bars, 2, 7) };
  f.hi8 = bars.map((_, i) => (i < 8 ? null : Math.max(...bars.slice(i - 8, i).map((b) => b.h))));
  f.fvg = bars.map((_, i) => (f.st[i] ? fvgAt(bars, i, f.atr, 0.5) : null));
  return f;
}

const volx = (b, f, i, x) => f.vavg[i] > 0 && (b[i].v || 0) >= x * f.vavg[i];
const bullGap = (f, i) => f.fvg[i] && f.fvg[i].side === 'BULL';
const gapRecent = (f, i, n) => { for (let j = i; j > i - n && j >= 0; j--) if (bullGap(f, j)) return true; return false; };

const TRIGGERS = {
  'ST 3/10 BUY flip (current)': (b, f, i) => f.st[i] === 'BUY' && f.st[i - 1] === 'SELL',
  'Bull FVG ≥0.5 ATR (current)': (b, f, i) => bullGap(f, i),
  'Fast ST 2/7 BUY flip': (b, f, i) => f.fast[i] === 'BUY' && f.fast[i - 1] === 'SELL',
  'EMA 9/21 cross up': (b, f, i) => f.e9[i] > f.e21[i] && f.e9[i - 1] <= f.e21[i - 1],
  'Breakout 4h high + vol 1.5x': (b, f, i) => f.hi8[i] && b[i].c > f.hi8[i] && volx(b, f, i, 1.5),
  'Bull FVG + vol 1.5x': (b, f, i) => bullGap(f, i) && volx(b, f, i, 1.5),
  'Bull FVG above EMA21, pre-flip': (b, f, i) => bullGap(f, i) && b[i].c > f.e21[i] && f.st[i] === 'SELL',
  'Breakout + bull FVG (2 bars)': (b, f, i) => f.hi8[i] && b[i].c > f.hi8[i] && gapRecent(f, i, 2),
  'Breakout + FVG + vol, pre-flip': (b, f, i) => f.hi8[i] && b[i].c > f.hi8[i] && gapRecent(f, i, 2) && volx(b, f, i, 1.5) && f.st[i] === 'SELL',
  'FVG + vol 2x': (b, f, i) => bullGap(f, i) && volx(b, f, i, 2),
  'FVG + vol 2.5x': (b, f, i) => bullGap(f, i) && volx(b, f, i, 2.5),
  'FVG ≥1 ATR + vol 1.5x': (b, f, i) => bullGap(f, i) && f.fvg[i].size >= 1 && volx(b, f, i, 1.5),
  'FVG + vol 1.5x + EMA9>21': (b, f, i) => bullGap(f, i) && volx(b, f, i, 1.5) && f.e9[i] > f.e21[i],
  'FVG + vol 1.5x + above EMA50': (b, f, i) => bullGap(f, i) && volx(b, f, i, 1.5) && b[i].c > f.e50[i],
  'FVG + vol 2x + above EMA50': (b, f, i) => bullGap(f, i) && volx(b, f, i, 2) && b[i].c > f.e50[i],
  'Reclaim EMA21 + FVG, above EMA50': (b, f, i) => b[i].c > f.e21[i] && b[i - 1].c <= f.e21[i - 1] && gapRecent(f, i, 3) && b[i].c > f.e50[i],
};

function rally(b, f, i) {
  const up = b[i].c + 2 * f.atr[i], dn = b[i].c - f.atr[i];
  for (let j = i + 1; j <= i + 48 && j < b.length; j++) {
    if (b[j].l <= dn) return 0;      // stop first (same-bar tie counts as a loss)
    if (b[j].h >= up) return 1;
  }
  return i + 48 < b.length ? 0 : null;   // unresolved at the end of history
}

async function main() {
  const syms = CFG.symbols.filter((s) => s.group !== 'futures');
  const data = (await pool(syms, CFG.concurrency || 8, async (s) => {
    try { const b = (await require(require('path').join(require('os').homedir(), 'trade-core', 'bars.js')).getBars(s)).filter((x) => x.t + TF_MS <= Date.now()); return b.length > 80 ? { s, b, f: features(b) } : null; }
    catch { return null; }
  })).filter(Boolean);
  const tMin = Math.min(...data.map((d) => d.b[60].t)), tMax = Math.max(...data.map((d) => d.b[d.b.length - 49].t));
  const split = tMin + (tMax - tMin) * 2 / 3, days = (tMax - tMin) / 864e5;

  // unconditional baseline: every bar
  const base = { disc: [], hold: [] };
  const res = {};
  for (const name of Object.keys(TRIGGERS)) res[name] = { disc: [], hold: [], lead: [], anticipated: 0, flips: 0 };
  for (const { b, f } of data) {
    const flips = []; for (let i = 61; i < b.length; i++) if (f.st[i] === 'BUY' && f.st[i - 1] === 'SELL') flips.push(i);
    for (let i = 60; i < b.length - 1; i++) {
      const r = rally(b, f, i); if (r == null) continue;
      (b[i].t < split ? base.disc : base.hold).push(r);
    }
    for (const [name, fn] of Object.entries(TRIGGERS)) {
      let last = -99; const fires = [];
      for (let i = 60; i < b.length; i++) {
        if (i - last < 4 || !fn(b, f, i)) continue;   // 2h cooldown per symbol
        last = i; fires.push(i);
        const r = rally(b, f, i); if (r == null) continue;
        (b[i].t < split ? res[name].disc : res[name].hold).push(r);
        const nf = flips.find((k) => k >= i); if (nf != null && nf - i <= 16) res[name].lead.push(nf - i);
      }
      for (const k of flips) { res[name].flips++; if (fires.some((i) => i <= k && k - i <= 16)) res[name].anticipated++; }
    }
  }
  const rate = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const P = (x) => (isNaN(x) ? '  –' : `${Math.round(100 * x)}%`.padStart(4));
  console.log(`${data.length} non-futures symbols · ${days.toFixed(0)} days · discover < ${new Date(split).toISOString().slice(0, 10)} ≤ holdout`);
  console.log(`baseline (any bar): rally ${P(rate(base.disc))} discover / ${P(rate(base.hold))} holdout   (break-even 33%)\n`);
  console.log('trigger                              per day  rally disc  rally hold   median lead   BUY flips caught early');
  for (const [name, r] of Object.entries(res)) {
    const n = r.disc.length + r.hold.length;
    console.log(`${name.padEnd(36)} ${(n / days).toFixed(1).padStart(6)}     ${P(rate(r.disc))} (${String(r.disc.length).padStart(4)})  ${P(rate(r.hold))} (${String(r.hold.length).padStart(4)})    ${isNaN(med(r.lead)) ? '  –' : (med(r.lead) + ' bars').padStart(7)}      ${P(r.anticipated / r.flips)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
