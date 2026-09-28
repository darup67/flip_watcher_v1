#!/usr/bin/env node
// Timeframe lab (2026-09-28): which bar size gives the earliest *useful* early-rally signal on
// stocks/ETFs/crypto? Same trigger on every timeframe: bull FVG (>= 0.5 ATR of that TF) on
// >= 2.5x its 20-bar average volume. Every signal is judged on one yardstick, the 30m ATR:
//   rally   = +2 ATR30 before -1 ATR30 within 24h (break-even 33%)
//   runup   = how far price had already risen from its 4h low when the signal fired, in ATR30
//             (smaller = caught earlier)
// Stocks via Yahoo (with pre/post), crypto via Binance USDT pairs (all TFs from one source).
const { CFG, pool, atrSeries, fvgAt } = require('./headless-flip.js');

const TFS = { '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3 };
const DAYS = 25;
const get = async (url) => { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(r.status); return r.json(); };

async function yahoo(t, tf) {
  const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=${tf === '1h' ? '60m' : tf}&range=${DAYS}d&includePrePost=true`);
  const r = j.chart.result[0], q = r.indicators.quote[0];
  return (r.timestamp || []).map((x, i) => ({ t: x * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }))
    .filter((b) => b.c != null && b.h != null && b.l != null && b.t % TFS[tf] === 0);
}
async function binance(sym, tf) {
  const out = []; let end = Date.now();
  while (out.length * TFS[tf] < DAYS * 864e5) {
    const k = await get(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${tf}&limit=1000&endTime=${end}`);
    if (!k.length) break;
    out.unshift(...k.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })));
    end = k[0][0] - 1;
  }
  return out;
}

async function main() {
  const syms = CFG.symbols.filter((s) => s.group !== 'futures').map((s) => {
    const n = s.tv.split(':')[1];
    return s.source === 'yahoo' ? { n, f: (tf) => yahoo(s.ticker, tf) } : { n, f: (tf) => binance(n.replace(/USDT?$/, '') + 'USDT', tf) };
  });
  const res = {};
  for (const tf of Object.keys(TFS)) res[tf] = { r: [], run: [], n: 0 };
  await pool(syms, 6, async (s) => {
    let b30;
    try { b30 = (await s.f('30m')).filter((b) => b.t + 1800e3 <= Date.now()); } catch { return; }
    if (b30.length < 100) return;
    const a30 = atrSeries(b30);
    const atr30At = (t) => { let lo = 0, hi = b30.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b30[m].t + 1800e3 <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k < 20 ? null : a30[k]; };
    for (const [tf, ms] of Object.entries(TFS)) {
      let b; try { b = (await s.f(tf)).filter((x) => x.t + ms <= Date.now()); } catch { continue; }
      if (b.length < 60) continue;
      const atr = atrSeries(b); let last = -1e15;
      for (let i = 21; i < b.length; i++) {
        const g = fvgAt(b, i, atr, 0.5); if (!g || g.side !== 'BULL') continue;
        const avg = b.slice(i - 20, i).reduce((a, x) => a + x.v, 0) / 20; if (!(avg > 0 && b[i].v >= 2.5 * avg)) continue;
        const tSig = b[i].t + ms; if (tSig - last < 2 * 3600e3) continue; last = tSig;   // 2h cooldown
        const A = atr30At(tSig); if (!A) continue;
        const entry = b[i].c, up = entry + 2 * A, dn = entry - A;
        let out = null;
        for (let j = i + 1; j < b.length && b[j].t < tSig + 24 * 3600e3; j++) { if (b[j].l <= dn) { out = 0; break; } if (b[j].h >= up) { out = 1; break; } }
        if (out == null && b[b.length - 1].t >= tSig + 24 * 3600e3) out = 0;
        const low4h = Math.min(...b.filter((x) => x.t >= tSig - 4 * 3600e3 && x.t + ms <= tSig).map((x) => x.l));
        res[tf].n++;
        if (out != null) res[tf].r.push(out);
        if (isFinite(low4h)) res[tf].run.push((entry - low4h) / A);
      }
    }
  });
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  console.log(`${syms.length} stocks/ETFs/crypto · ~${DAYS} days · trigger: bull FVG on ≥2.5× volume · yardstick: 30m ATR\n`);
  console.log('timeframe   signals/day   2:1 rally   run-up already done (median, ATR30)');
  for (const [tf, v] of Object.entries(res)) {
    const rate = v.r.length ? v.r.reduce((a, x) => a + x, 0) / v.r.length : NaN;
    console.log(`${tf.padEnd(10)} ${(v.n / DAYS).toFixed(1).padStart(9)}     ${(100 * rate).toFixed(0).padStart(4)}% (${v.r.length})       ${v.run.length ? med(v.run).toFixed(2) : '–'}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
