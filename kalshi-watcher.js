#!/usr/bin/env node
/**
 * Kalshi Watcher — desktop + email alerts for Kalshi prediction markets.
 *
 * Sibling to flip-notifier.js. Same alert channels, same hardening patterns,
 * different asset class: CFTC-regulated event contracts instead of equities.
 *
 * Data comes from Kalshi's PUBLIC market-data API — no API key, no account
 * needed for reading. (Trading would need auth; this watcher never trades.)
 *
 * Signals it fires on:
 *   FLIP    the YES mid crosses 50c — the market's majority belief inverted
 *   MOVE    the YES mid jumped >= thresholds.move_cents since the last poll
 *   VOLUME  24h volume multiplied by >= thresholds.vol_spike_x
 *
 * Usage:
 *   node kalshi-watcher.js            poll once, alert on change
 *   node kalshi-watcher.js --status   print watched markets, no alerts
 *   node kalshi-watcher.js --test     fire a sample alert
 *   node kalshi-watcher.js --reset    clear state (next run re-baselines)
 *   node kalshi-watcher.js --alerts   replay recent alerts
 *   node kalshi-watcher.js --discover <query>   find series tickers by keyword
 */

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync,
         statSync, renameSync, openSync, closeSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_FILE = join(HERE, 'kalshi-watchlist.json');
const STATE_FILE     = join(HERE, 'kalshi-state.json');
const LOG_FILE       = join(HERE, 'kalshi-watcher.log');
const ALERTS_FILE    = join(HERE, 'kalshi-alerts.tsv');
const LOCK_FILE      = join(HERE, '.kalshi.lock');

const API = process.env.KALSHI_API || 'https://external-api.kalshi.com/trade-api/v2';
const HTTP_TIMEOUT_MS = 15000;
const CMD_TIMEOUT_MS  = 15000;
const LOCK_STALE_MS   = 5 * 60 * 1000;
const LOG_MAX_BYTES   = 512 * 1024;

// Kalshi markets move on news, not on a bar clock, so there is no burst window
// to exploit — a steady interval is the whole story. 5 min balances latency
// against being a good citizen on a free public API.
const STALE_WAKE_S = 30 * 60;   // 6 missed 5-min polls -> treat as a gap, not live moves
const SETTLE_S     = 60;

// A watcher that goes quiet looks exactly like a watcher with nothing to report.
const BLIND_AFTER = 3;          // consecutive failed polls (~15 min at 5-min interval)

const args = new Set(process.argv.slice(2));
const argVal = flag => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

/* ------------------------------------------------------------------ *
 * Plumbing — atomic writes, lockfile, logging. Mirrors flip-notifier.js.
 * ------------------------------------------------------------------ */

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function acquireLock() {
  try {
    const fd = openSync(LOCK_FILE, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
      const pid = Number(readFileSync(LOCK_FILE, 'utf8').trim());
      if (age < LOCK_STALE_MS && pid && pid !== process.pid) {
        try { process.kill(pid, 0); return false; } catch { /* dead -> stale */ }
      }
      unlinkSync(LOCK_FILE);
      const fd = openSync(LOCK_FILE, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch { return false; }
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK_FILE) &&
        readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) {
      unlinkSync(LOCK_FILE);
    }
  } catch { /* best effort */ }
}

function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`;
  process.stdout.write(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      const kept = readFileSync(LOG_FILE, 'utf8').split('\n').slice(-500).join('\n');
      writeFileSync(LOG_FILE, kept);
    }
    appendFileSync(LOG_FILE, line);
  } catch { /* logging is best-effort */ }
}

let shuttingDown = false;
function onShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} received — cleaning up`);
  releaseLock();
  process.exit(0);
}
process.on('SIGTERM', () => onShutdown('SIGTERM'));
process.on('SIGINT',  () => onShutdown('SIGINT'));

/* ------------------------------------------------------------------ *
 * Alert delivery — same four channels as the flip notifier.
 * ------------------------------------------------------------------ */

const run = (cmd, cmdArgs) => new Promise(resolve => {
  execFile(cmd, cmdArgs, { timeout: CMD_TIMEOUT_MS, killSignal: 'SIGKILL' },
    err => resolve(err ? err.message : null));
});

/**
 * Which delivery channels are live. Set from the watchlist's `alerts` block
 * once it loads; until then everything is on, so an early failure alert (a
 * missing or corrupt watchlist) can still reach you.
 *
 * `kalshi-alerts.tsv` is deliberately NOT a channel — it is always written.
 * Muting a channel should change where a signal goes, never whether it is
 * recorded, or a quiet period becomes a hole in the history.
 */
let channels = { banner: true, sound: true, speak: true, email: true };

const CHANNEL_DEFAULTS = { banner: true, sound: true, speak: true, email: true };

async function notify(title, body, { sound = 'Submarine', speak = null } = {}) {
  const esc = s => String(s)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');

  if (channels.banner) {
    const bannerErr = await run('/usr/bin/osascript',
      ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]);
    if (bannerErr) log(`WARN banner call failed: ${bannerErr}`);
  }

  // Durable record — always, regardless of which channels are muted.
  try {
    appendFileSync(ALERTS_FILE, `${new Date().toISOString()}\t${title}\t${body.replace(/\n/g, ' | ')}\n`);
  } catch { /* best effort */ }

  if (channels.sound) {
    const soundFile = `/System/Library/Sounds/${sound}.aiff`;
    if (existsSync(soundFile)) await run('/usr/bin/afplay', [soundFile]);
  }

  if (channels.speak && speak && process.env.FLIP_SPEAK !== '0') {
    run('/usr/bin/say', ['-r', '210', '-v', 'Samantha', speak]).catch(() => {});
  }

  // Email — the only channel that survives a closed lid.
  if (!channels.email) return;
  let gmailPw = process.env.FLIP_GMAIL_APP_PASSWORD;
  if (!gmailPw) {
    try {
      gmailPw = execFileSync('/usr/bin/security',
        ['find-generic-password', '-a', 'darup67@gmail.com', '-s', 'flip-notifier-gmail', '-w'],
        { timeout: 5000, encoding: 'utf8' }).trim();
    } catch { /* no Keychain entry — email disabled */ }
  }
  if (gmailPw) {
    const emailScript = join(HERE, 'send-email.js');
    const emailErr = await new Promise(resolve => {
      execFile(process.execPath, [emailScript, title, body],
        { timeout: 35000, killSignal: 'SIGKILL',
          env: { PATH: process.env.PATH, HOME: process.env.HOME,
                 FLIP_GMAIL_APP_PASSWORD: gmailPw } },
        (err, _out, stderr) => resolve(err ? (stderr ? stderr.trim() : err.message) : null));
    });
    if (emailErr) log(`WARN email failed: ${emailErr}`);
  }
}

/* ------------------------------------------------------------------ *
 * Kalshi API
 * ------------------------------------------------------------------ */

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Kalshi rate-limits the public API. Pagination walks many pages back to back,
// which is exactly the pattern that trips it, so pace the requests and back off
// when told to rather than failing the whole poll on one 429.
const API_GAP_MS      = 120;   // minimum spacing between requests
const API_RETRIES     = 4;
const API_BACKOFF_MS  = 1000;  // doubles each retry: 1s, 2s, 4s, 8s

let _lastApiCall = 0;

async function apiGet(path, params = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  let lastErr;
  for (let attempt = 0; attempt <= API_RETRIES; attempt++) {
    // Pace: never fire two requests closer than API_GAP_MS apart.
    const since = Date.now() - _lastApiCall;
    if (since < API_GAP_MS) await sleep(API_GAP_MS - since);
    _lastApiCall = Date.now();

    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: { 'Accept': 'application/json' },
      });
    } catch (e) {
      lastErr = e;                                  // network/timeout — retry
      if (attempt < API_RETRIES) { await sleep(API_BACKOFF_MS * 2 ** attempt); continue; }
      throw new Error(`${e.message} on ${path}`);
    }

    if (res.ok) return res.json();

    // 429 and 5xx are transient; 4xx (other than 429) will never succeed on retry.
    const retryable = res.status === 429 || res.status >= 500;
    lastErr = new Error(`HTTP ${res.status} on ${path}`);
    if (!retryable || attempt === API_RETRIES) throw lastErr;

    // Honour Retry-After when the server sends it, else exponential backoff.
    const ra = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0
      ? Math.min(ra * 1000, 15000)
      : API_BACKOFF_MS * 2 ** attempt;
    await sleep(wait);
  }
  throw lastErr;
}

const money = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The YES mid in cents. Bid and ask are the honest read — last_price can be
 * hours stale on a thin market, and a stale price masquerading as a live one
 * is exactly the false signal this watcher exists to avoid.
 *
 * Returns null when the book is empty or crossed, i.e. there is no real price.
 */
function yesMidCents(m) {
  const bid = money(m.yes_bid_dollars) * 100;
  const ask = money(m.yes_ask_dollars) * 100;
  if (bid <= 0 && ask <= 0) return null;         // no book at all
  if (bid <= 0 || ask >= 100) return null;       // one-sided — not a real price
  if (ask < bid) return null;                    // crossed book, ignore
  return Math.round(((bid + ask) / 2) * 10) / 10;
}

const vol24 = m => money(m.volume_24h_fp);

/**
 * A readable name for one market.
 *
 * `title` alone is useless on strike ladders — every strike in KXBTCD is
 * titled "Bitcoin price on Sep 6, 2026?", so 50 different contracts would
 * alert under one indistinguishable name. The strike lives in yes_sub_title
 * ("$88,800 or above"), so join the two and drop the trailing question mark
 * that reads badly mid-sentence.
 */
function marketName(m) {
  const { base, strike } = marketParts(m);
  return strike ? `${base}: ${strike}` : base;
}

/**
 * Split a market's name into the part shared across a strike ladder ("Bitcoin
 * price on Sep 6, 2026") and the strike that distinguishes it ("$79,800 or
 * above"). The ladder collapse groups on the first and summarises the second.
 */
function marketParts(m) {
  const title = String(m.title || '').replace(/\?\s*$/, '').trim();
  const sub = String(m.yes_sub_title || m.subtitle || '').trim();
  if (!title) return { base: sub || m.ticker, strike: '' };
  if (!sub || sub.toLowerCase() === title.toLowerCase()) return { base: title, strike: '' };
  return { base: title, strike: sub };
}

/** Numeric strike, for describing the band a ladder move covered. */
function strikeValue(strike) {
  const m = /\$?([\d,]+(?:\.\d+)?)/.exec(String(strike || ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const fmtStrike = n =>
  n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n}`;

/** Fetch every open market for one series, following pagination. */
async function fetchSeries(seriesTicker) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {          // hard cap: 10k markets
    const d = await apiGet('/markets', {
      series_ticker: seriesTicker,
      status: 'open',
      limit: 1000,
      mve_filter: 'exclude',                        // skip multivariate parlays
      cursor: cursor || undefined,
    });
    out.push(...(d.markets || []));
    cursor = d.cursor;
    if (!cursor || !(d.markets || []).length) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Watchlist
 * ------------------------------------------------------------------ */

const DEFAULT_THRESHOLDS = {
  min_volume_24h: 500,
  move_cents: 10,
  vol_spike_x: 3.0,
  vol_spike_floor: 1000,
  no_flip: false,      // suppress FLIP signals for this series
  no_volume: false,    // suppress VOLUME-spike signals for this series
};

/**
 * Per-series thresholds, falling back to the file's defaults, falling back to
 * DEFAULT_THRESHOLDS.
 *
 * Sports and macro cannot share one setting. A 10c move is real news on a Fed
 * contract that trades a thousand times a day; on an NFL moneyline during a
 * live game it is just the third quarter happening. Likewise crossing 50c means
 * the market inverted on a macro contract, but a football favourite crosses it
 * routinely — so sports series set no_flip and a much wider move_cents.
 */
function loadWatchlist() {
  if (!existsSync(WATCHLIST_FILE)) {
    return { state: 'absent', series: [], pinned: [], thresholds: {} };
  }
  try {
    const w = JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8'));
    const raw = Array.isArray(w.series) ? w.series.filter(s => s && s.ticker) : [];
    if (!raw.length) return { state: 'corrupt', series: [], pinned: [], thresholds: {} };

    const base = { ...DEFAULT_THRESHOLDS, ...(w.thresholds || {}) };
    const series = raw.map(s => ({
      ticker: s.ticker,
      label: s.label || s.ticker,
      thresholds: { ...base, ...(s.thresholds || {}) },
    }));

    return {
      state: 'ok',
      series,
      pinned: Array.isArray(w.pinned) ? w.pinned : [],
      thresholds: base,
      alerts: { ...CHANNEL_DEFAULTS, ...(w.alerts || {}) },
      // The vol alert is opt-in separately: the user muted signal noise but
      // still wants to hear about a calm book, so it must not inherit that mute.
      volAlerts: { ...CHANNEL_DEFAULTS, ...(w.volAlerts || {}) },
      // BTC-only mode. Skips FLIP/MOVE/VOLUME detection entirely rather than
      // computing signals and throwing them away — the series stay in the
      // watchlist so this is one flag to undo.
      signalsPaused: !!w.signals_paused,
    };
  } catch { return { state: 'corrupt', series: [], pinned: [], thresholds: {} }; }
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let stateWasCorrupt = false;

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { stateWasCorrupt = true; return null; }
}

function saveState(obj) {
  try { writeAtomic(STATE_FILE, JSON.stringify(obj, null, 2)); }
  catch (e) { log(`WARN could not persist state: ${e.message}`); }
}

async function recordFailure(reason) {
  const prev = loadState() || {};
  const failures = (prev.failures || 0) + 1;
  const alreadyAlerted = !!prev.blindAlerted;

  const sinceGoodS = prev.updated
    ? (Date.now() - new Date(prev.updated).getTime()) / 1000 : Infinity;
  const wasDown = sinceGoodS > STALE_WAKE_S;
  const shouldAlert = failures >= BLIND_AFTER && !alreadyAlerted && !wasDown;

  saveState({ ...prev, failures, blindAlerted: alreadyAlerted || shouldAlert,
              lastFailure: reason, lastFailureAt: new Date().toISOString() });
  log(`FAIL (${failures}) ${reason}${wasDown ? ' [was down — alert suppressed]' : ''}`);

  if (shouldAlert) {
    await notify('⚠️ Kalshi Watcher is blind', reason,
      { sound: 'Basso', speak: 'Warning. Kalshi watcher cannot reach the API.' });
    log(`ALERTED: blind for ${failures} polls — ${reason}`);
  }
  process.exitCode = 1;
}

async function recordRecovery(prev) {
  if (prev?.blindAlerted) {
    await notify('✅ Kalshi Watcher recovered', 'Reading markets again',
      { sound: 'Glass', speak: 'Kalshi watcher is reading markets again.' });
    log('ALERTED: recovered');
  }
}

/* ------------------------------------------------------------------ *
 * Signal detection + scoring
 *
 * Three signal types, each scored 0-5 the same way the flip watcher scores
 * a regime flip — so a Kalshi alert and a TradingView alert mean the same
 * thing when they say STRONG.
 *
 *   Magnitude   (0-2)  how far the price moved, or how big the volume spike
 *   Liquidity   (0-2)  is there enough 24h volume for the move to mean anything
 *   Correlation (0-1)  did sibling markets in the same series move too
 * ------------------------------------------------------------------ */

const SCORE_EMOJI = { STRONG: '🔥', MODERATE: '⚡', WEAK: '💤' };

function scoreSignal(sig, allSignals, globalTh) {
  // Score against the thresholds this market was actually judged by — a 25c
  // move is "large" for macro but merely par for an NFL series whose bar is 25c.
  const th = sig.th || globalTh;
  const factors = [];
  let score = 0;

  // 1. Magnitude
  if (sig.type === 'LADDER') {
    // A whole curve repricing is a stronger statement than one strike twitching,
    // so judge on the largest member move and let breadth count below.
    if (sig.maxDelta >= th.move_cents * 2) { score += 2; factors.push(`band moved up to ${sig.maxDelta.toFixed(0)}¢`); }
    else if (sig.maxDelta > 0) { score += 1; factors.push(`band moved up to ${sig.maxDelta.toFixed(0)}¢`); }
    else { score += 1; factors.push(`${sig.kinds.join('+').toLowerCase()} across the band`); }
    if (sig.mixed) factors.push('mixed direction — strikes diverged');
  } else if (sig.type === 'FLIP') {
    const dist = Math.abs(sig.to - 50);
    if (dist >= 10) { score += 2; factors.push(`decisive cross (now ${sig.to.toFixed(0)}¢)`); }
    else if (dist >= 4) { score += 1; factors.push(`crossed 50¢ (now ${sig.to.toFixed(0)}¢)`); }
    else { factors.push(`hovering at 50¢ (${sig.to.toFixed(0)}¢)`); }
  } else if (sig.type === 'MOVE') {
    const d = Math.abs(sig.delta);
    if (d >= th.move_cents * 2) { score += 2; factors.push(`large move (${sig.delta > 0 ? '+' : ''}${sig.delta.toFixed(0)}¢)`); }
    else { score += 1; factors.push(`moved ${sig.delta > 0 ? '+' : ''}${sig.delta.toFixed(0)}¢`); }
  } else { // VOLUME
    if (sig.mult >= th.vol_spike_x * 2) { score += 2; factors.push(`volume ${sig.mult.toFixed(1)}x`); }
    else { score += 1; factors.push(`volume ${sig.mult.toFixed(1)}x`); }
  }

  // 2. Liquidity — a 20c move on a market nobody trades is noise, not news.
  const v = sig.volume;
  if (v >= th.min_volume_24h * 20) { score += 2; factors.push(`liquid (${v.toLocaleString()} 24h vol)`); }
  else if (v >= th.min_volume_24h * 4) { score += 1; factors.push(`decent volume (${v.toLocaleString()})`); }
  else { factors.push(`thin (${v.toLocaleString()} 24h vol)`); }

  // 3. Correlation — the whole curve repricing beats one strike wobbling.
  // For a collapsed ladder that breadth is already the member count.
  if (sig.type === 'LADDER') {
    if (sig.n >= 4) { score += 1; factors.push(`${sig.n} strikes repriced together`); }
    else { factors.push(`${sig.n} strikes repriced`); }
  } else {
    const siblings = allSignals.filter(s => s.series === sig.series && s.ticker !== sig.ticker);
    if (siblings.length >= 2) { score += 1; factors.push(`${siblings.length + 1} markets in ${sig.series} moved`); }
    else if (siblings.length === 1) { factors.push(`1 sibling market also moved`); }
    else { factors.push('isolated'); }
  }

  const label = score >= 4 ? 'STRONG' : score >= 2 ? 'MODERATE' : 'WEAK';
  return { score, label, factors };
}

/* ------------------------------------------------------------------ *
 * Strike-ladder collapse
 *
 * A series like KXBTCD is a ladder: 50+ contracts on one underlying at $100
 * increments. Move BTC $200 and every strike near the money reprices at once,
 * so one fact — "BTC is chopping around 79.7k" — arrives as a dozen alerts,
 * and the same strike re-fires each time price oscillates back across it.
 * Measured over one afternoon: 124 individual signals, 74% of them Bitcoin,
 * one alert carrying 11 markets, the $79,700 strike alone firing 15 times.
 *
 * Grouping on the event ticker (one underlying at one expiry) collapses that
 * into a single signal describing the band that moved. Nothing is lost: the
 * member count, strike range and largest move all survive into the summary,
 * and the per-market rows are still in kalshi-alerts.tsv.
 * ------------------------------------------------------------------ */

const LADDER_MIN = 2;   // 2+ signals on one event collapse into one

function collapseLadders(signals) {
  const byEvent = new Map();
  for (const s of signals) {
    if (!byEvent.has(s.event)) byEvent.set(s.event, []);
    byEvent.get(s.event).push(s);
  }

  const out = [];
  for (const [event, group] of byEvent) {
    if (group.length < LADDER_MIN) { out.push(...group); continue; }

    const deltas = group.map(g => g.delta).filter(d => typeof d === 'number');
    const ups = deltas.filter(d => d > 0).length;
    const downs = deltas.filter(d => d < 0).length;
    const dir = ups > downs ? 1 : downs > ups ? -1 : 0;

    const vals = group.map(g => strikeValue(g.strike)).filter(v => v !== null);
    const band = vals.length
      ? { lo: Math.min(...vals), hi: Math.max(...vals) }
      : null;

    const absDeltas = deltas.map(Math.abs);
    out.push({
      type: 'LADDER',
      event,
      series: group[0].series,
      label: group[0].label,
      base: group[0].base,
      title: group[0].base,
      th: group[0].th,
      n: group.length,
      dir,
      band,
      mixed: ups > 0 && downs > 0,
      avgDelta: absDeltas.length ? absDeltas.reduce((a, b) => a + b, 0) / absDeltas.length : 0,
      maxDelta: absDeltas.length ? Math.max(...absDeltas) : 0,
      // The group's liquidity is what makes the move meaningful, so score on
      // the total rather than on whichever single strike happened to be first.
      volume: group.reduce((a, g) => a + (g.volume || 0), 0),
      kinds: [...new Set(group.map(g => g.type))],
      members: group,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * BTC 15-minute volatility index
 *
 * KXBTC15M ("BTC price up in next 15 mins?") is the deepest 15-minute crypto
 * market on Kalshi — ~8k trades per window against 2-5k for ETH/XRP/SOL. That
 * depth is what makes it measurable: the book reprices in small increments
 * rather than jumping between prints.
 *
 * The index is the mean intra-window price RANGE (max - min of executed
 * trades) over the last VOL_WINDOWS settled windows. Range beats standard
 * deviation here because it answers the question a trader actually has —
 * how far did this thing travel while I held it.
 *
 * Bands are measured, not guessed. Over 48 consecutive settled windows
 * (12 h, 2026-09-06/07) single-window range ran 2.4c - 98.3c, median 34.4c.
 * Smoothed over 4 windows the index ran 7.2c - 65.5c, and these cuts put
 * roughly a fifth of the time in each tail:
 *
 *   LOW    < 28c   calm book, ~22% of observed hours
 *   NORMAL          28-52c
 *   HIGH   > 52c   ~16%
 *
 * Per-window ranges are cached by ticker in state, so a poll only fetches
 * windows it has never seen — steady state is one new window per 15 minutes,
 * not a full recompute every 5.
 * ------------------------------------------------------------------ */

const VOL_SERIES     = 'KXBTC15M';
const VOL_WINDOWS    = 4;      // 1 hour of 15-minute windows
const VOL_LOW        = 28;     // cents — below this the book is calm
const VOL_HIGH       = 52;
const VOL_TRADE_PAGES = 8;     // 1000 trades/page; a window runs ~8k
const VOL_CACHE_MAX  = 40;     // keep the cache from growing without bound

const volBand = v => (v < VOL_LOW ? 'LOW' : v > VOL_HIGH ? 'HIGH' : 'NORMAL');

/** Executed-price range for one settled window, in cents. */
async function volWindowRange(ticker) {
  let cursor = null, lo = Infinity, hi = -Infinity, n = 0;
  for (let page = 0; page < VOL_TRADE_PAGES; page++) {
    // Reuse apiGet so this inherits the pacing, 429 backoff and retries —
    // paging trades is exactly the pattern that trips Kalshi's rate limiter.
    const d = await apiGet('/markets/trades',
      { ticker, limit: 1000, ...(cursor ? { cursor } : {}) });
    const trades = d?.trades || [];
    for (const t of trades) {
      let p = t.yes_price_dollars ?? t.yes_price;
      if (p == null) continue;
      p = Number(p);
      if (!Number.isFinite(p)) continue;
      if (p <= 1.001) p *= 100;          // dollars -> cents
      if (p < lo) lo = p;
      if (p > hi) hi = p;
      n++;
    }
    cursor = d?.cursor;
    if (!cursor || !trades.length) break;
  }
  // A window with almost no prints cannot produce a meaningful range.
  if (n < 20 || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return { range: hi - lo, trades: n };
}

/**
 * Recompute the index and, on a NEW entry into LOW, alert.
 *
 * Edge-triggered: the band must actually change. A calm hour would otherwise
 * re-fire every 5 minutes, which is the same mistake the Core probe made.
 */
async function updateBtcVolIndex(prev) {
  let markets;
  try {
    const d = await apiGet('/markets', {
      series_ticker: VOL_SERIES, status: 'settled',
      limit: VOL_WINDOWS + 4, mve_filter: 'exclude' });
    markets = (d?.markets || []).filter(m => m?.ticker);
  } catch (e) {
    log(`vol index: cannot list ${VOL_SERIES} — ${e.message}`);
    return null;
  }
  if (markets.length < VOL_WINDOWS) return null;

  const cache = { ...(prev.volCache || {}) };
  const recent = markets.slice(0, VOL_WINDOWS);
  const ranges = [];

  for (const m of recent) {
    if (cache[m.ticker] != null) { ranges.push(cache[m.ticker]); continue; }
    let r = null;
    try { r = await volWindowRange(m.ticker); }
    catch (e) { log(`vol index: trades failed for ${m.ticker} — ${e.message}`); }
    if (!r) continue;
    cache[m.ticker] = r.range;
    ranges.push(r.range);
  }
  if (ranges.length < VOL_WINDOWS) return null;   // partial hour — do not judge

  const index = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const band  = volBand(index);
  const was   = prev.volBand || null;

  // Trim the cache to the most recent tickers we know about.
  const keep = new Set(markets.slice(0, VOL_CACHE_MAX).map(m => m.ticker));
  for (const k of Object.keys(cache)) if (!keep.has(k)) delete cache[k];

  return { index, band, was, cache, windows: ranges };
}

/** The vol alert has its OWN channels — see volAlerts in the watchlist. */
let volChannels = { ...CHANNEL_DEFAULTS };

// Report cadence. This is deliberately SEPARATE from VOL_WINDOWS: the index
// still measures a 1-hour window (4 x 15 min), it is just reported twice as
// often, so a regime change surfaces within ~30 min instead of ~60. Polls run
// every 5 minutes, so a report lands on the first poll past each half hour.
const VOL_REPORT_MS = 30 * 60 * 1000;

const VOL_ICON = { LOW: '\u{1F7E2}', NORMAL: '\u26AA', HIGH: '\u{1F534}' };

/**
 * Hourly volatility read. Deliberately NOT edge-triggered: the user wants to
 * know the regime on a schedule, not only when it changes — a band that holds
 * LOW all morning is still worth being told about at 9, 10 and 11.
 *
 * Returns the timestamp to record, or the previous one when nothing was sent.
 */
async function reportBtcVol(v, prev) {
  if (!v) return prev.lastVolReport || 0;

  const last = prev.lastVolReport || 0;
  const now  = Date.now();
  if (now - last < VOL_REPORT_MS) return last;      // not yet due

  const icon    = VOL_ICON[v.band] || '\u26AA';
  const changed = v.was && v.was !== v.band ? `  (was ${v.was})` : '';
  const windows = v.windows.map(r => `${r.toFixed(0)}c`).join(' ');

  const title = `${icon} BTC 15m vol ${v.band} \u2014 ${v.index.toFixed(0)}c${changed}`;
  const body  =
    `${VOL_SERIES} index ${v.index.toFixed(1)}c over ${v.windows.length} windows: ${windows}\n` +
    `bands: LOW <${VOL_LOW}c \u00b7 NORMAL ${VOL_LOW}-${VOL_HIGH}c \u00b7 HIGH >${VOL_HIGH}c`;

  const saved = channels;
  channels = volChannels;                           // bypasses the signal mute
  try {
    await notify(title, body, {
      sound: v.band === 'LOW' ? 'Hero' : 'Pop',
      speak: `Bitcoin fifteen minute volatility is ${v.band.toLowerCase()}, ` +
             `${v.index.toFixed(0)} cent average range.`,
    });
  } finally { channels = saved; }

  log(`VOL REPORT: ${v.band} index ${v.index.toFixed(1)}c${changed}`);
  return now;
}

const SIG_ICON = { FLIP: '🔄', MOVE: '📈', VOLUME: '📊' };

function sigHeadline(s) {
  if (s.type === 'LADDER') {
    const arrow = s.mixed ? '↕️' : s.dir > 0 ? '⬆️' : s.dir < 0 ? '⬇️' : '📊';
    const bandTxt = s.band
      ? (s.band.lo === s.band.hi
          ? ` ${fmtStrike(s.band.lo)}`
          : ` ${fmtStrike(s.band.lo)}–${fmtStrike(s.band.hi)}`)
      : '';
    const mag = s.maxDelta ? `, up to ${s.maxDelta.toFixed(0)}¢` : '';
    return `${arrow} ${s.base} — ${s.n} strikes${bandTxt}${mag}`;
  }
  if (s.type === 'FLIP') {
    const dir = s.to >= 50 ? 'YES' : 'NO';
    return `🔄 ${s.title} → ${dir} (${s.from.toFixed(0)}¢→${s.to.toFixed(0)}¢)`;
  }
  if (s.type === 'MOVE') {
    const arrow = s.delta > 0 ? '⬆️' : '⬇️';
    return `${arrow} ${s.title} ${s.from.toFixed(0)}¢→${s.to.toFixed(0)}¢`;
  }
  return `📊 ${s.title} volume ${s.mult.toFixed(1)}x`;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  // Apply the channel config before anything can alert — including --test, so
  // a test fires through exactly the channels a real signal would.
  const wlEarly = loadWatchlist();
  if (wlEarly.state === 'ok') {
    channels = wlEarly.alerts;
    volChannels = wlEarly.volAlerts;
  }
  const muted = Object.entries(channels).filter(([, on]) => !on).map(([k]) => k);

  if (args.has('--test')) {
    if (muted.length) log(`note: ${muted.join(', ')} muted in kalshi-watchlist.json`);
    await notify('🔄 Fed cuts in Sept → YES (44¢→57¢)',
      '🔄 Fed above 4.00% → YES (44¢→57¢)  🔥 STRONG\n' +
      '  · decisive cross (now 57¢)\n  · liquid (48,200 24h vol)\n  · 3 markets in KXFED moved',
      { speak: 'Kalshi. Fed rate market flipped to yes. Strong setup.' });
    log('sent test alert');
    return;
  }

  if (args.has('--discover')) {
    const q = (argVal('--discover') || '').toUpperCase();
    if (!q) { log('usage: --discover <keyword>'); process.exitCode = 1; return; }
    // One page is not enough: on any game day the first thousand open markets
    // are all sports props, so a macro series would never appear. Walk pages
    // until the keyword's series stop showing up.
    const seen = new Map();
    let cursor = null, scanned = 0;
    for (let page = 0; page < 25; page++) {
      const d = await apiGet('/markets', {
        status: 'open', limit: 1000, mve_filter: 'exclude', cursor: cursor || undefined,
      });
      const batch = d.markets || [];
      scanned += batch.length;
      for (const m of batch) {
        const series = String(m.ticker || '').split('-')[0];
        if (!series.includes(q) && !String(m.title || '').toUpperCase().includes(q)) continue;
        const cur = seen.get(series) || { series, n: 0, vol: 0, sample: marketName(m) };
        cur.n += 1; cur.vol += vol24(m);
        seen.set(series, cur);
      }
      cursor = d.cursor;
      if (!cursor || !batch.length) break;
    }
    log(`scanned ${scanned.toLocaleString()} open markets`);
    const rows = [...seen.values()].sort((a, b) => b.vol - a.vol).slice(0, 25);
    if (!rows.length) { log(`no open series matched "${q}"`); return; }
    process.stdout.write(`\nseries matching "${q}"\n\n`);
    for (const r of rows) {
      process.stdout.write(`  ${r.series.padEnd(22)} ${String(r.n).padStart(4)} mkts  ` +
        `${r.vol.toLocaleString().padStart(12)} 24h vol   ${String(r.sample).slice(0, 50)}\n`);
    }
    process.stdout.write('\n');
    return;
  }

  if (args.has('--alerts')) {
    if (!existsSync(ALERTS_FILE)) { log('no alerts recorded yet'); return; }
    const lines = readFileSync(ALERTS_FILE, 'utf8').trim().split('\n').slice(-25);
    process.stdout.write(`\nlast ${lines.length} Kalshi alerts\n\n`);
    for (const l of lines) {
      const [ts, title] = l.split('\t');
      process.stdout.write(`  ${ts.slice(0, 19).replace('T', ' ')}  ${title}\n`);
    }
    process.stdout.write('\n');
    return;
  }

  if (args.has('--reset')) {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    log('state cleared; next run re-baselines without alerting');
    return;
  }

  const wl = loadWatchlist();
  if (wl.state === 'absent')  return recordFailure('kalshi-watchlist.json missing');
  if (wl.state === 'corrupt') return recordFailure('kalshi-watchlist.json unreadable or has no series');

  const th = wl.thresholds;

  // Fetch every watched series. One bad series must not blind the whole poll.
  const markets = [];
  const seriesErrors = [];
  for (const s of wl.series) {
    try {
      const ms = await fetchSeries(s.ticker);
      for (const m of ms) {
        markets.push({ ...m, _series: s.ticker, _label: s.label, _th: s.thresholds });
      }
    } catch (e) { seriesErrors.push(`${s.ticker}: ${e.message}`); }
  }

  if (!markets.length) {
    return recordFailure(seriesErrors.length
      ? `no markets read — ${seriesErrors.join('; ')}`
      : 'no open markets in any watched series');
  }
  if (seriesErrors.length) log(`WARN partial read — ${seriesErrors.join('; ')}`);

  // Keep only markets with a real price, and either enough volume or a pin.
  const pinned = new Set(wl.pinned);
  const tracked = [];
  for (const m of markets) {
    const mid = yesMidCents(m);
    if (mid === null) continue;
    const v = vol24(m);
    const mth = m._th || th;
    if (v < mth.min_volume_24h && !pinned.has(m.ticker)) continue;
    const parts = marketParts(m);
    tracked.push({
      ticker: m.ticker,
      series: m._series,
      label: m._label,
      title: marketName(m),
      base: parts.base,
      strike: parts.strike,
      // Kalshi's own grouping: one event = one underlying at one expiry, which
      // is exactly the set of strikes that reprice together.
      event: m.event_ticker || m.ticker,
      mid,
      volume: v,
      close: m.close_time,
      th: mth,
    });
  }

  if (args.has('--status')) {
    log(`${tracked.length} tracked markets across ${wl.series.length} series ` +
        `(${markets.length} open, ${markets.length - tracked.length} filtered out)`);
    log(muted.length
      ? `alert channels: ${Object.entries(channels).filter(([, on]) => on).map(([k]) => k).join(', ') || 'none'} ` +
        `· MUTED: ${muted.join(', ')}`
      : 'alert channels: all live');
    const bySeries = new Map();
    for (const t of tracked) {
      if (!bySeries.has(t.series)) bySeries.set(t.series, []);
      bySeries.get(t.series).push(t);
    }
    for (const [series, list] of bySeries) {
      list.sort((a, b) => b.volume - a.volume);
      process.stdout.write(`\n  ${series} — ${list[0].label}\n`);
      for (const t of list.slice(0, 8)) {
        process.stdout.write(`    ${String(t.mid.toFixed(0)).padStart(3)}¢  ` +
          `${t.volume.toLocaleString().padStart(10)} vol   ${t.title.slice(0, 62)}\n`);
      }
      if (list.length > 8) process.stdout.write(`    …and ${list.length - 8} more\n`);
    }
    process.stdout.write('\n');
    return;
  }

  const prev = loadState();
  await recordRecovery(prev);

  const now = Date.now();
  const snapshot = {};
  for (const t of tracked) snapshot[t.ticker] = { mid: t.mid, volume: t.volume };

  const base = { updated: new Date().toISOString(), markets: snapshot,
                 failures: 0, blindAlerted: false };

  // First run, or state was lost: baseline silently.
  if (!prev?.markets) {
    saveState({ ...base, settleUntil: null });
    if (stateWasCorrupt) {
      await notify('⚠️ Kalshi Watcher state was corrupt',
        'Baseline rebuilt — prior prices lost, no signals this cycle',
        { sound: 'Basso', speak: 'Warning. Kalshi watcher state was corrupt and has been rebuilt.' });
      log(`ALERTED: kalshi-state.json unreadable — rebaselined from ${tracked.length} markets`);
    } else {
      log(`baseline saved (${tracked.length} markets) — no alerts on first run`);
    }
    return;
  }

  // Gap since the last good poll: prices moved while we were not looking, so
  // reporting them as live signals would be lying about when they happened.
  const gapS = (now - new Date(prev.updated).getTime()) / 1000;
  if (gapS > STALE_WAKE_S) {
    saveState({ ...base, settleUntil: now + SETTLE_S * 1000 });
    const mins = Math.round(gapS / 60);
    const human = mins >= 120 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
    let moved = 0;
    for (const t of tracked) {
      const p = prev.markets[t.ticker];
      if (p && Math.abs(t.mid - p.mid) >= th.move_cents) moved++;
    }
    await notify(`⏰ Kalshi watcher back after ${human}`,
      `${tracked.length} markets tracked · ${moved} moved while down — NOT live signals`,
      { sound: 'Blow',
        speak: `Kalshi watcher back online after ${human}. ${moved} markets moved while it was down. Not live signals.` });
    log(`STALE WAKE: down ${human}, ${moved} moved (re-baselined, not reported as signals)`);
    return;
  }

  if (prev.settleUntil && now < prev.settleUntil) {
    saveState({ ...base, settleUntil: prev.settleUntil });
    log(`settling (${Math.ceil((prev.settleUntil - now) / 1000)}s left) — re-baselining, not judging`);
    return;
  }

  // Detect signals against the previous snapshot.
  const signals = [];
  for (const t of tracked) {
    const p = prev.markets[t.ticker];
    if (!p) continue;                              // new market — baseline it, judge next poll
    const mth = t.th;

    // FLIP: the majority belief inverted. Strictly-crossing test so a market
    // resting exactly at 50c does not re-fire every poll. Suppressed on series
    // where crossing 50c is routine rather than meaningful (live sports).
    if (!mth.no_flip &&
        ((p.mid < 50 && t.mid >= 50) || (p.mid >= 50 && t.mid < 50))) {
      signals.push({ type: 'FLIP', ...t, from: p.mid, to: t.mid });
      continue;                                    // one signal per market per poll
    }

    const delta = t.mid - p.mid;
    if (Math.abs(delta) >= mth.move_cents) {
      signals.push({ type: 'MOVE', ...t, from: p.mid, to: t.mid, delta });
      continue;
    }

    if (!mth.no_volume && p.volume >= 1 && t.volume >= mth.vol_spike_floor) {
      const mult = t.volume / p.volume;
      if (mult >= mth.vol_spike_x) {
        signals.push({ type: 'VOLUME', ...t, from: p.mid, to: t.mid, mult });
      }
    }
  }

  // The BTC vol index runs on every poll, and deliberately BEFORE the
  // no-signals early return: a calm book produces no signals, which is exactly
  // the state the LOW alert exists to catch. Putting it after would mean it
  // never fired in the case it was built for.
  let volState = {};
  try {
    const v = await updateBtcVolIndex(prev);
    if (v) {
      const stamp = await reportBtcVol(v, prev);
      volState = { volBand: v.band, volIndex: Number(v.index.toFixed(2)),
                   volCache: v.cache, lastVolReport: stamp };
    }
  } catch (e) {
    log(`vol index failed (non-fatal): ${e.message}`);   // never break a poll over it
  }

  saveState({ ...base, ...volState, settleUntil: null });

  // BTC-only mode: state is still tracked above, so un-pausing resumes from a
  // current baseline rather than re-alerting a backlog of stale moves.
  if (wl.signalsPaused) {
    log(`BTC-only mode \u2014 ${signals.length} signal(s) suppressed, ${tracked.length} markets tracked` +
        (volState.volIndex != null ? ` \u00b7 BTC vol ${volState.volIndex}c ${volState.volBand}` : ''));
    return;
  }

  if (!signals.length) {
    log(`no signals (${tracked.length} markets checked)` +
        (volState.volIndex != null ? ` · BTC vol ${volState.volIndex}c ${volState.volBand}` : ''));
    return;
  }

  // Collapse strike ladders before scoring, so one repricing curve is one alert.
  const collapsed = collapseLadders(signals);
  const scored = collapsed.map(s => ({ ...s, setup: scoreSignal(s, collapsed, th) }));
  scored.sort((a, b) => b.setup.score - a.setup.score);

  // Title is the only text that renders on this Mac (previews are off), so it
  // carries the strongest signal; the body carries everything.
  const top = scored[0];
  const more = scored.length > 1 ? `  +${scored.length - 1}` : '';
  const title = `${sigHeadline(top).slice(0, 56)}${more}`;

  const body = scored.map(s => {
    const e = SCORE_EMOJI[s.setup.label];
    let block = `${sigHeadline(s)}  ${e} ${s.setup.label}\n` +
                `  ${s.series} · ${s.label}\n` +
                s.setup.factors.map(f => `  · ${f}`).join('\n');
    // Name the strikes a collapse folded away, so the summary is auditable
    // without opening the TSV.
    if (s.type === 'LADDER') {
      const lines = s.members
        .slice()
        .sort((a, b) => (strikeValue(a.strike) ?? 0) - (strikeValue(b.strike) ?? 0))
        .map(m => `    ${m.strike || m.ticker}  ${m.from?.toFixed(0)}¢→${m.to?.toFixed(0)}¢` +
                  (m.type === 'VOLUME' ? `  (vol ${m.mult?.toFixed(1)}x)` : ''));
      block += `\n  folded:\n${lines.join('\n')}`;
    }
    return block;
  }).join('\n\n');

  const spoken = `Kalshi. ${scored.slice(0, 3).map(s => {
    if (s.type === 'LADDER') {
      const d = s.mixed ? 'diverged' : s.dir > 0 ? 'up' : s.dir < 0 ? 'down' : 'repriced';
      return `${s.label}, ${s.n} strikes ${d} up to ${s.maxDelta.toFixed(0)} cents`;
    }
    if (s.type === 'FLIP') return `${s.label} flipped to ${s.to >= 50 ? 'yes' : 'no'}`;
    if (s.type === 'VOLUME') return `${s.label} volume ${s.mult?.toFixed(1)} times`;
    return `${s.label} moved ${Math.abs(s.delta ?? 0).toFixed(0)} cents`;
  }).join(', ')}. ${top.setup.label.toLowerCase()} setup.`;

  await notify(title, body, { sound: 'Submarine', speak: spoken });
  // Name the muted channels on every alert. A silenced watcher and a broken one
  // look identical in the log otherwise, and that ambiguity is the whole thing
  // this stack exists to avoid.
  const folded = signals.length - collapsed.length;
  log(`ALERTED${muted.length ? ` (${muted.join('+')} muted)` : ''}: ` +
      scored.map(s => s.type === 'LADDER'
        ? `${s.event} LADDER×${s.n} [${s.setup.label}:${s.setup.score}]`
        : `${s.ticker} ${s.type} [${s.setup.label}:${s.setup.score}]`).join(', ') +
      (folded > 0 ? ` · ${signals.length} signals folded to ${collapsed.length}` : ''));
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

const READ_ONLY = args.has('--status') || args.has('--alerts') || args.has('--discover');

if (!READ_ONLY && !acquireLock()) {
  log('another poll still running — skipping this tick');
  process.exit(0);
}

main()
  .catch(err => { log(`FATAL ${err.stack || err.message}`); process.exitCode = 1; })
  .finally(() => { if (!READ_ONLY) releaseLock(); });
