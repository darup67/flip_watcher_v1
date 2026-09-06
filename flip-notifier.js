#!/usr/bin/env node
/**
 * Flip Notifier — local macOS desktop notifications for the TradingView
 * "Watchlist Flip Scanner" Pine study.
 *
 * Independent of TradingView's alert system. Reads the study's on-chart table
 * straight out of the running TradingView Desktop app over CDP (port 9222),
 * diffs each symbol's BUY/SELL regime against the last poll, and fires a
 * macOS notification when any symbol flips.
 *
 * Usage:
 *   node flip-notifier.js           poll once, notify on change
 *   node flip-notifier.js --test    fire a sample notification, exit
 *   node flip-notifier.js --status  print current regimes, no notification
 *   node flip-notifier.js --reset   clear saved state (next run re-baselines)
 *   node flip-notifier.js --core    show Phantom Flow Core's live signal values
 *   node flip-notifier.js --alerts  replay recent alerts (in case a banner was missed)
 *   node flip-notifier.js --accept-symbols   adopt the current symbol list as expected
 */

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync, statSync,
         renameSync, openSync, closeSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ws lives in the tradingview-mcp install; reuse it rather than duplicating deps.
const require = createRequire(join(homedir(), 'tradingview-mcp', 'package.json'));
const WebSocket = require('ws');

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, 'state.json');
const LOG_FILE = join(HERE, 'flip-notifier.log');
const EXPECTED_FILE = join(HERE, 'expected-symbols.json');
const ALERTS_FILE = join(HERE, 'alerts.tsv');

// Overridable so the failure path can be exercised without closing TradingView.
const CDP_HOST = process.env.FLIP_CDP || '127.0.0.1:9222';
const STUDY_FILTER = 'Flip';          // substring match on the study description
const CDP_TIMEOUT_MS = 10000;

// The study's table repaints intrabar (it is drawn under barstate.islast, not
// barstate.isconfirmed), so a regime can flip and un-flip inside one bar.
//
// 'intrabar' (default, user's choice): alert the moment the table changes —
// fastest possible, but a flip that does not survive the bar still alerts, and
// reverting produces a second alert. Treat alerts as "go look", not as signals.
//
// 'confirmed' (FLIP_MODE=confirmed): judge each 30m bar only once it has closed,
// reproducing the script's own alert.freq_once_per_bar_close semantics.
const MODE = process.env.FLIP_MODE === 'confirmed' ? 'confirmed' : 'intrabar';
const BAR_MS = 30 * 60 * 1000;

// Sleep (lid close) stops launchd firing entirely, so the notifier cannot even
// detect its own absence — the blind guard never runs. On wake, regimes may have
// moved hours ago. Reporting those as fresh flips would be worse than silence:
// you would act on a stale signal. Anything older than this is treated as a gap,
// not as a live flip.
const STALE_WAKE_S = 360;   // 6 missed polls

// After a wake, TradingView still renders pre-sleep values until it reconnects
// and backfills. Re-baselining on that stale table would make the catch-up look
// like a burst of live flips on the NEXT poll. So after a gap we deliberately
// keep re-baselining, without judging, until the data has had time to settle.
const SETTLE_S = 60;    // 1 poll — TradingView reconnects in ~15-30s on wake

// A flip can only appear when a 30-minute bar closes, so that is the only window
// worth polling hard. Ported from the earlier pine-alerts watcher: burst at 1s
// through the boundary, idle the rest of the time. A poll costs ~0.13s.
const BAR_MIN = 30;
const BURST_MS = 1000;
const BURST_AFTER_S = 120;   // keep bursting this long past the close
const BURST_BEFORE_S = 10;   // and start this long before it
const BURST_BUDGET_MS = Number(process.env.FLIP_BURST_BUDGET_MS) || 50000;  // never overrun the 60s launchd tick

// Transient CDP hiccups are common; failing on the first miss produces false
// blind alerts. Retry before declaring blindness.
const READ_ATTEMPTS = 4;
const READ_BACKOFF_MS = 2500;

// Zombie recovery: when the study is on the chart but stuck in a restart loop,
// producing no table output. Reloading the page forces TradingView to re-init
// all studies from the saved chart state, which clears runtime glitches.
const ZOMBIE_AFTER = 5;               // consecutive failures before attempting recovery
const ZOMBIE_COOLDOWN_MS = 10 * 60 * 1000;  // never reload more than once per 10 min
const ZOMBIE_MAX_ATTEMPTS = 3;        // give up and escalate after this many reloads

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Graceful shutdown — launchd sends SIGTERM before SIGKILL. Catching it
 * releases the lock and closes any open CDP connection immediately,
 * instead of relying on stale-lock detection on the next tick.
 * ------------------------------------------------------------------ */
let shuttingDown = false;
function onShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — cleaning up`);
  releaseLock();
  // Close any cached CDP WebSocket
  if (_cachedWs) { try { _cachedWs.close(); } catch {} _cachedWs = null; }
  process.exit(0);
}
process.on('SIGTERM', () => onShutdown('SIGTERM'));
process.on('SIGINT',  () => onShutdown('SIGINT'));

function secondsSinceBoundary() {
  const n = new Date();
  return (n.getMinutes() % BAR_MIN) * 60 + n.getSeconds();
}

function inBurstWindow() {
  if (process.env.FLIP_FORCE_BURST === '1') return true;   // test hook
  const since = secondsSinceBoundary();
  const until = BAR_MIN * 60 - since;
  return since <= BURST_AFTER_S || until <= BURST_BEFORE_S;
}

const args = new Set(process.argv.slice(2));

let cycle = 0;
const PROBE_EVERY = 30;
const HEARTBEAT_EVERY = 200;

const LOG_MAX_BYTES = 512 * 1024;
const LOCK_FILE = join(HERE, '.lock');
const LOCK_STALE_MS = 5 * 60 * 1000;
const CMD_TIMEOUT_MS = 15000;

/**
 * Write via temp file + rename. A process killed mid-write would otherwise leave
 * truncated JSON, and loadState() treats unparseable state as "no state" — which
 * silently re-baselines and loses the flip history. rename() is atomic on APFS.
 */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * Only one poll at a time. launchd will happily start the next interval while a
 * slow poll is still running; two processes interleaving read-modify-write on
 * state.json race each other and can double-alert.
 */
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
      unlinkSync(LOCK_FILE);            // stale or owner gone
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
    // Polling once a minute forever; keep the log from growing without bound.
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      const kept = readFileSync(LOG_FILE, 'utf8').split('\n').slice(-500).join('\n');
      writeFileSync(LOG_FILE, kept);
    }
    appendFileSync(LOG_FILE, line);
  } catch { /* logging is best-effort */ }
}

/* ------------------------------------------------------------------ *
 * macOS notification
 * ------------------------------------------------------------------ */

// Never let a stuck `say`/`afplay`/osascript hang the poll forever.
const run = (cmd, cmdArgs) => new Promise(resolve => {
  execFile(cmd, cmdArgs, { timeout: CMD_TIMEOUT_MS, killSignal: 'SIGKILL' },
    err => resolve(err ? err.message : null));
});

/**
 * Deliver an alert through every channel that works on this machine.
 *
 * `display notification` is unreliable here: osascript exits 0 whether or not
 * the banner is actually shown, and macOS has no notification client
 * registered for Script Editor, so banners are silently discarded. We still
 * attempt it (costs nothing, works if the permission is ever granted), but the
 * sound and speech are what you actually get — neither needs any permission.
 */
async function notify(title, body, { sound = 'Submarine', speak = null } = {}) {
  // AppleScript string literals cannot span lines, so a raw newline in the body
  // would terminate the literal and break the call — emit it as an \n escape.
  const esc = s => String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');

  // 1. Banner — best effort. osascript exits 0 whether or not anything is shown,
  // but a genuine failure (bad string, killed by timeout) DOES return an error,
  // and swallowing it meant the log said NOTIFIED when nothing had been attempted.
  const bannerErr = await run('/usr/bin/osascript',
    ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]);
  if (bannerErr) log(`WARN banner call failed: ${bannerErr}`);

  // Durable record, so a missed banner never means a lost signal.
  try {
    appendFileSync(ALERTS_FILE, `${new Date().toISOString()}\t${title}\t${body}\n`);
  } catch { /* best effort */ }

  // 2. Sound — always audible, no permission required.
  const soundFile = `/System/Library/Sounds/${sound}.aiff`;
  if (existsSync(soundFile)) await run('/usr/bin/afplay', [soundFile]);

  // 3. Speech — says what flipped, so it carries information without the screen.
  // Fire and forget: a slow TTS call must not delay the next poll.
  if (speak && process.env.FLIP_SPEAK !== '0') {
    run('/usr/bin/say', ['-r', '210', '-v', 'Samantha', speak]).catch(() => {});
  }

  // 4. Email — push to phone even with lid closed.
  // Awaited (up to 35s) so failures are always logged. The 3-retry logic lives
  // inside send-email.js; here we just capture the outcome.
  let gmailPw = process.env.FLIP_GMAIL_APP_PASSWORD;
  if (!gmailPw) {
    // Fallback: pull from Keychain directly if the env var is missing (e.g.
    // manual run outside the LaunchAgent).
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
        (err, stdout, stderr) => {
          if (err) resolve(stderr ? stderr.trim() : err.message);
          else resolve(null);
        });
    });
    if (emailErr) log(`WARN email failed: ${emailErr}`);
  }
}

/* ------------------------------------------------------------------ *
 * CDP: read the study's table out of the live chart
 * ------------------------------------------------------------------ */

// Mirrors tradingview-mcp's buildGraphicsJS('dwgtablecells','tableCells',filter).
const EXTRACT_JS = `
(function () {
  var out = [];
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var filter = ${JSON.stringify(STUDY_FILTER)};
    for (var si = 0; si < sources.length; si++) {
      var s = sources[si];
      if (!s.metaInfo) continue;
      try {
        var meta = s.metaInfo();
        var name = meta.description || meta.shortDescription || '';
        if (!name || name.indexOf(filter) === -1) continue;
        var g = s._graphics;
        if (!g || !g._primitivesCollection) continue;
        var outer = g._primitivesCollection.dwgtablecells;
        if (!outer) continue;
        var inner = outer.get('tableCells');
        if (!inner) continue;
        // Cell store sits directly on the collection in current desktop builds;
        // older ones nest it one level deeper behind .get(false).
        var coll = inner._primitivesDataById ? inner
                 : (typeof inner.get === 'function' ? inner.get(false) : null);
        if (!coll || !coll._primitivesDataById) continue;
        var cells = [];
        coll._primitivesDataById.forEach(function (v) {
          cells.push({ row: v.row, col: v.col, text: v.t || '' });
        });
        if (cells.length) out.push({ name: name, cells: cells });
      } catch (e) { /* skip this source */ }
    }
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
  return { studies: out };
})()
`;

/* ------------------------------------------------------------------ *
 * CDP target-list cache — during a burst we poll up to 50 times per
 * launchd tick. Hitting /json/list each time adds ~50 HTTP round trips
 * of pure overhead. Cache the result for a short window.
 * ------------------------------------------------------------------ */
let _cdpTargetsCache = null;
let _cdpTargetsCacheAt = 0;
const CDP_TARGET_CACHE_MS = 5000;   // 5s — plenty for burst, short enough to catch tab changes

async function cdpGetPages() {
  const now = Date.now();
  if (_cdpTargetsCache && now - _cdpTargetsCacheAt < CDP_TARGET_CACHE_MS) {
    return _cdpTargetsCache;
  }
  const res = await fetch(`http://${CDP_HOST}/json/list`, {
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
  });
  const targets = await res.json();
  const pages = targets.filter(t => t.type === 'page' && (t.url || '').includes('/chart/'));
  if (!pages.length) throw new Error('no TradingView chart tab found on CDP :9222');
  _cdpTargetsCache = pages;
  _cdpTargetsCacheAt = now;
  return pages;
}

/** Invalidate the target cache (called after page reload, or on connection error). */
function cdpInvalidateCache() {
  _cdpTargetsCache = null;
  _cdpTargetsCacheAt = 0;
  // Also close any cached WebSocket — the page it connects to may be gone.
  if (_cachedWs) { try { _cachedWs.close(); } catch {} _cachedWs = null; }
}

/* ------------------------------------------------------------------ *
 * CDP WebSocket connection cache — reuse a single WebSocket across
 * burst polls instead of opening and closing one per evaluation.
 * Falls back to a fresh connection if the cached one is dead.
 * ------------------------------------------------------------------ */
let _cachedWs = null;
let _cachedWsUrl = null;
let _cdpMsgId = 0;

function getCachedWs(wsUrl) {
  if (_cachedWs && _cachedWsUrl === wsUrl && _cachedWs.readyState === WebSocket.OPEN) {
    return _cachedWs;
  }
  // Close stale one
  if (_cachedWs) { try { _cachedWs.close(); } catch {} }
  _cachedWs = null;
  _cachedWsUrl = null;
  return null;
}

function createCachedWs(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  _cachedWs = ws;
  _cachedWsUrl = wsUrl;
  // If the connection drops unexpectedly, clear the cache so the next poll
  // creates a fresh one instead of sending into a dead socket.
  ws.on('close', () => { if (_cachedWs === ws) { _cachedWs = null; _cachedWsUrl = null; } });
  ws.on('error', () => { if (_cachedWs === ws) { _cachedWs = null; _cachedWsUrl = null; } });
  return ws;
}

/**
 * Evaluate against EVERY open chart tab and keep the first result that actually
 * answers. Taking targets[0] blindly meant a second chart tab without the study
 * on it could shadow the real one and blind the watcher permanently.
 */
async function cdpEvaluate(expression, isUseful = null) {
  const pages = await cdpGetPages();

  let lastErr = null, firstResult;
  for (const page of pages) {
    let value;
    try { value = await cdpEvalOn(page, expression); }
    catch (e) {
      lastErr = e;
      // Connection-level failures invalidate the cache — the target may have
      // reloaded and gotten a new WebSocket URL.
      if (e.message.includes('timed out') || e.message.includes('ECONNREFUSED') ||
          e.message.includes('not opened') || e.message.includes('close')) {
        cdpInvalidateCache();
      }
      continue;
    }
    if (firstResult === undefined) firstResult = value;
    if (!isUseful || isUseful(value)) return value;
  }
  if (firstResult !== undefined) return firstResult;
  throw lastErr || new Error('no chart tab responded');
}

function cdpEvalOn(page, expression) {
  return new Promise((resolve, reject) => {
    const wsUrl = page.webSocketDebuggerUrl;
    let ws = getCachedWs(wsUrl);
    const isNew = !ws;
    if (!ws) ws = createCachedWs(wsUrl);

    const msgId = ++_cdpMsgId;
    let settled = false;
    const settle = fn => (...args) => { if (!settled) { settled = true; clearTimeout(timer); fn(...args); } };

    const timer = setTimeout(settle(err => {
      // Don't close a cached connection on timeout — it may recover for the
      // next call. But DO reject this evaluation.
      reject(new Error('CDP evaluate timed out'));
    }), CDP_TIMEOUT_MS);

    function onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id !== msgId) return;
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
      settle(() => {})(/* clear timer */);
      if (msg.error) return reject(new Error(msg.error.message));
      const r = msg.result?.result;
      if (r?.subtype === 'error') return reject(new Error(r.description || 'page threw'));
      resolve(r?.value);
    }

    // If the WebSocket closes while we're waiting for a response, fail fast
    // instead of waiting for the full 10s timeout.
    function onClose(code) {
      ws.removeListener('message', onMessage);
      settle(err => reject(err))(new Error(`CDP WebSocket closed (code ${code}) before response`));
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);

    const sendEval = () => {
      ws.send(JSON.stringify({
        id: msgId,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: false },
      }));
    };

    if (isNew) {
      // Need to wait for open before sending
      ws.once('open', sendEval);
      // Handle connection failure for brand-new sockets
      ws.once('error', settle(err => reject(err)));
    } else {
      sendEval();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Zombie recovery: detect a stuck study and reload the page
 * ------------------------------------------------------------------ */

/**
 * Check whether the Flip Scanner study is on the chart but stuck (zombie).
 * A zombie study shows up in dataSources but never reaches status type 1
 * (completed), so it produces no table output.
 */
const ZOMBIE_CHECK_JS = `
(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s.metaInfo) continue;
      var meta = s.metaInfo();
      var name = meta.description || meta.shortDescription || '';
      if (name.indexOf('Flip') === -1) continue;
      var status = s.status ? s.status() : null;
      return {
        found: true,
        name: name,
        statusType: status ? status.type : -1,
        isStarted: !!s._isStarted,
        restarting: !!s._restarting,
        wasCompletedBefore: !!s._wasCompletedBefore,
        isZombie: !!status && status.type !== 1
      };
    }
    return { found: false };
  } catch(e) { return { error: e.message }; }
})()`;

/**
 * Reload the TradingView chart page via CDP. The chart state is auto-saved to
 * the cloud, so a reload re-initializes all studies cleanly from scratch,
 * breaking any runtime glitches (stuck restart loops, collapsed panes, etc.)
 * without losing the user's symbol inputs or layout.
 */
async function cdpReload() {
  const pages = await cdpGetPages();
  const page = pages[0];   // already filtered to chart tabs
  if (!page) throw new Error('no chart tab to reload');

  // A reload invalidates the page's WebSocket endpoint — the old one dies and
  // a new one is assigned. Close the cached connection BEFORE reloading so
  // subsequent polls don't send into a dead socket.
  cdpInvalidateCache();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('reload timed out'));
    }, 10000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: {} }));
    });
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) reject(new Error(msg.error.message));
      else resolve();
    });
    ws.on('close', () => { clearTimeout(timer); });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Called when we have had ZOMBIE_AFTER consecutive failures reading the scanner
 * table. Checks if the study is actually on the chart but stuck, and if so,
 * reloads the page to force a clean re-initialization.
 *
 * Returns true if a recovery was attempted, false if skipped.
 */
async function attemptZombieRecovery() {
  const prev = loadState() || {};
  const now = Date.now();

  // Cooldown: don't reload more than once per ZOMBIE_COOLDOWN_MS
  if (prev.lastZombieRecovery &&
      now - new Date(prev.lastZombieRecovery).getTime() < ZOMBIE_COOLDOWN_MS) {
    return false;
  }

  // Max attempts: don't keep reloading forever
  const attempts = (prev.zombieAttempts || 0) + 1;
  if (attempts > ZOMBIE_MAX_ATTEMPTS) {
    if (!prev.zombieGaveUp) {
      log(`ZOMBIE recovery exhausted (${ZOMBIE_MAX_ATTEMPTS} reloads) — manual fix needed`);
      await notify('🧟 Flip Scanner zombie — manual fix needed',
        `Scanner stuck after ${ZOMBIE_MAX_ATTEMPTS} page reloads. Open TradingView, remove the Scanner study, ` +
        'open Pine Editor → "Watchlist Flip Scanner" → Add to chart, then set timeframe to 30.',
        { sound: 'Basso', speak: 'Flip scanner is stuck. Manual intervention required.' });
      writeAtomic(STATE_FILE, JSON.stringify({ ...prev, zombieGaveUp: true }, null, 2));
    }
    return false;
  }

  // Check if the study is actually on the chart (zombie = present but not rendering)
  let check;
  try {
    check = await cdpEvaluate(ZOMBIE_CHECK_JS, v => v && !v.error);
  } catch (e) {
    log(`ZOMBIE detection failed (CDP error): ${e.message}`);
    return false;
  }

  if (!check || check.error) {
    log(`ZOMBIE detection failed: ${check?.error || 'no response'}`);
    return false;
  }

  if (!check.found) {
    // Study is genuinely missing from the chart — a reload won't help
    log('ZOMBIE check: study not on chart — reload would not help');
    return false;
  }

  // Study is on the chart but not producing output → zombie confirmed
  log(`ZOMBIE confirmed: ${check.name} · status=${check.statusType} ` +
      `started=${check.isStarted} restarting=${check.restarting} ` +
      `(attempt ${attempts}/${ZOMBIE_MAX_ATTEMPTS}) — reloading page`);

  try {
    await cdpReload();
  } catch (e) {
    log(`ZOMBIE page reload failed: ${e.message}`);
    return false;
  }

  // Mark the recovery attempt. Set settleUntil so the next poll re-baselines
  // instead of judging flips on potentially stale data.
  writeAtomic(STATE_FILE, JSON.stringify({
    ...prev,
    lastZombieRecovery: new Date().toISOString(),
    zombieAttempts: attempts,
    zombieGaveUp: false,
    // 90s settle: TradingView takes ~30-60s to fully reload + reconnect feeds
    settleUntil: now + 90 * 1000,
  }, null, 2));

  log('page reload sent — settling for 90s before next read');
  return true;
}

/**
 * Reassemble table cells into { SYMBOL: 'BUY'|'SELL' }.
 * Row 0 is the study's header ("Symbol | State") and is skipped.
 * Column 0 holds the ticker, column 1 the state.
 */
function parseRegimes(studies) {
  if (!studies || !studies.length) return null;
  const cells = studies[0].cells;
  const rows = new Map();
  for (const c of cells) {
    if (!rows.has(c.row)) rows.set(c.row, {});
    rows.get(c.row)[c.col] = c.text;
  }
  const regimes = {};
  for (const [rowNum, cols] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    if (rowNum === 0) continue;
    const symbol = (cols[0] || '').trim();
    const state = (cols[1] || '').trim().toUpperCase();
    if (!symbol || (state !== 'BUY' && state !== 'SELL')) continue;
    regimes[symbol] = state;
  }
  return Object.keys(regimes).length ? regimes : null;
}

/** Strip exchange prefix and delayed-feed suffix: "CME_MINI_DL:MNQ1!" -> "MNQ1!" */
const shortName = sym => sym.includes(':') ? sym.split(':').pop() : sym;

/**
 * The title is the entire visible payload on this Mac (previews are off), so
 * spend all of it on ticker names. Listing two and "+5" hid five symbols with no
 * way to see them; grouping by direction fits them instead.
 */
const TITLE_MAX = 62;

function fitGroup(arrow, list, budget) {
  let names = list.slice();
  let text = `${arrow}${list.length} ${names.join(' ')}`;
  while (names.length > 1 && text.length > budget) {
    names.pop();
    text = `${arrow}${list.length} ${names.join(' ')} +${list.length - names.length}`;
  }
  return text;
}

function buildTitle(flips) {
  if (flips.length === 1) return fmtFlip(flips[0]);
  const sells = flips.filter(f => f.to === 'SELL').map(f => f.ticker);
  const buys = flips.filter(f => f.to === 'BUY').map(f => f.ticker);
  if (sells.length && buys.length) {
    const half = Math.floor(TITLE_MAX / 2) - 2;
    return `${fitGroup('⬇️', sells, half)}  ${fitGroup('⬆️', buys, half)}`;
  }
  return sells.length
    ? fitGroup('⬇️', sells, TITLE_MAX)
    : fitGroup('⬆️', buys, TITLE_MAX);
}

/**
 * Banner text for one flip: "⬆️ TQQQ → BUY".
 * Kept short and single-line — macOS banners collapse newlines and truncate
 * long bodies, so the arrow, ticker and new regime are all that fit reliably.
 */
const fmtFlip = f => `${f.to === 'BUY' ? '⬆️' : '⬇️'} ${f.ticker} → ${f.to}`;

/* ------------------------------------------------------------------ *
 * Phantom Flow Core probe
 *
 * Core is already on the chart, so sampling it costs no indicator slot.
 * Open question this answers: are Core's Confluence/Osc plots actually live,
 * or is the script paywalled to a permanent 0.00? That decides whether the
 * Alert Bridge could ever fire, and therefore whether it is worth spending
 * both free-tier indicator slots on Core + Bridge.
 *
 * Reads the data-window values only — deliberately NOT s.inputs(), which on a
 * protected script is a ~35 KB encrypted blob.
 * ------------------------------------------------------------------ */

const CORE_CSV = join(HERE, 'core-probe.csv');

const CORE_JS = `
(function () {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s.metaInfo) continue;
      var meta = s.metaInfo();
      var name = meta.description || meta.shortDescription || '';
      if (name.indexOf('Phantom Flow Core') === -1) continue;
      var values = {};
      var dwv = s.dataWindowView && s.dataWindowView();
      if (dwv && dwv.items) {
        var items = dwv.items();
        for (var j = 0; j < items.length; j++) {
          var it = items[j];
          if (it._title && it._value && it._value !== '\u2205') values[it._title] = it._value;
        }
      }
      var sym = null;
      try {
        var w = window.TradingViewApi._activeChartWidgetWV.value();
        sym = w.symbol && w.symbol();
        if (sym && typeof sym === 'object') sym = sym.symbol || sym.full_name || null;
      } catch (e) {}
      return { found: true, values: values, symbol: typeof sym === 'string' ? sym : null };
    }
    return { found: false };
  } catch (e) { return { error: String(e && e.message || e) }; }
})()
`;

const CORE_SIGNAL_KEYS = ['Phantom Osc Buy', 'Phantom Osc Sell', 'Confluence Buy', 'Confluence Sell'];

const numeric = v => Number(String(v).replace(/[^0-9.\-]/g, '')) || 0;

async function probeCore() {
  let r;
  try { r = await cdpEvaluate(CORE_JS, v => v?.found); } catch { return; }   // never fatal
  if (!r || r.error || !r.found) return;

  const vals = r.values || {};
  const row = CORE_SIGNAL_KEYS.map(k => vals[k] ?? '');
  const anyLive = process.env.FLIP_FAKE_CORE === '1'      // test hook
    || CORE_SIGNAL_KEYS.some(k => numeric(vals[k]) !== 0);

  const sym = r.symbol || 'unknown';
  if (!existsSync(CORE_CSV)) {
    writeFileSync(CORE_CSV, `timestamp,symbol,${CORE_SIGNAL_KEYS.join(',')},anyNonZero\n`);
  }
  appendFileSync(CORE_CSV,
    `${new Date().toISOString()},"${sym}",${row.map(v => `"${v}"`).join(',')},${anyLive ? 1 : 0}\n`);

  // Edge-triggered. A Core impulse stays non-zero for several polls (the last
  // burst held for 14 consecutive samples over 4 minutes), so alerting on every
  // live poll would mean 14 chimes for one signal.
  // Core follows the chart, so it fires on whatever you happen to be browsing.
  // Only alert when that symbol is one you actually watch — otherwise chart-hopping
  // produces signals for instruments you have no position or interest in.
  // If the watchlist is unreadable, fail OPEN (alert anyway) rather than going
  // silently deaf.
  const { state: expState, tickers: watched } = loadExpected();
  const shortSym = sym.includes(':') ? sym.split(':').pop() : sym;
  const inWatchlist = expState !== 'ok' || watched.includes(shortSym);

  const prev = loadState() || {};
  const wasLive = !!prev.coreLive;
  const effectiveLive = anyLive && inWatchlist;

  if (anyLive && !inWatchlist) {
    log(`CORE fired on ${sym} — not in watchlist, alert suppressed`);
  }

  if (effectiveLive && !wasLive) {
    const fired = CORE_SIGNAL_KEYS.filter(k => numeric(vals[k]) !== 0);
    const short = sym.includes(':') ? sym.split(':').pop() : sym;
    const label = fired.map(k => k.replace('Phantom ', '').replace('Confluence ', 'Conf ')).join(' + ');
    await notify(`◆ Core ${label} · ${short}`,
      fired.map(k => `${k}=${vals[k]}`).join(' · '),
      { sound: 'Glass', speak: `Phantom Flow Core ${label} on ${short}` });
    log(`CORE FIRED on ${sym}: ${CORE_SIGNAL_KEYS.map(k => `${k}=${vals[k]}`).join(' ')}`);
  } else if (effectiveLive) {
    log(`CORE LIVE (already alerted) on ${sym}`);
  }

  if (effectiveLive !== wasLive) {
    try { writeAtomic(STATE_FILE, JSON.stringify({ ...prev, coreLive: effectiveLive }, null, 2)); }
    catch { /* non-fatal */ }
  }
}

/* ------------------------------------------------------------------ *
 * Symbol-set drift
 *
 * The curated symbol list lives on the STUDY INSTANCE, not the script. Remove
 * and re-add the study — which is exactly the fix for a dead instance — and its
 * inputs silently revert to the script defaults (SPX, DXY, VIX, FX pairs). The
 * scanner then keeps reporting confidently on a book you do not trade, and
 * nothing about it looks broken. This catches that.
 * ------------------------------------------------------------------ */

// Distinguish "never recorded" from "recorded but unreadable". Collapsing both to
// null meant a corrupt file silently adopted whatever symbols happened to be
// loaded, quietly disabling drift detection.
function loadExpected() {
  if (!existsSync(EXPECTED_FILE)) return { state: 'absent', tickers: null };
  try {
    const t = JSON.parse(readFileSync(EXPECTED_FILE, 'utf8')).tickers;
    if (!Array.isArray(t) || !t.length) return { state: 'corrupt', tickers: null };
    return { state: 'ok', tickers: t };
  } catch { return { state: 'corrupt', tickers: null }; }
}

function saveExpected(tickers) {
  writeAtomic(EXPECTED_FILE, JSON.stringify(
    { updated: new Date().toISOString(), tickers: [...tickers].sort() }, null, 2));
}

/** Compare on ticker only — exchange prefixes vary (NASDAQ vs BATS, _DL suffixes). */
function diffSymbols(live, expected) {
  const L = new Set(live), E = new Set(expected);
  return {
    missing: expected.filter(t => !L.has(t)),
    extra: live.filter(t => !E.has(t)),
  };
}

async function checkDrift(regimes) {
  const live = Object.keys(regimes).map(shortName).sort();
  const { state: expState, tickers: expected } = loadExpected();

  if (expState === 'absent') {
    saveExpected(live);
    log(`symbol baseline saved (${live.length})`);
    return;
  }
  if (expState === 'corrupt') {
    // Refuse to silently adopt. Say so loudly and leave the file alone.
    log('WARN expected-symbols.json is unreadable — drift detection is OFF until you run --accept-symbols');
    return;
  }

  const { missing, extra } = diffSymbols(live, expected);
  const drifted = missing.length || extra.length;
  const prev = loadState() || {};

  if (drifted && !prev.driftAlerted) {
    const detail = [
      missing.length ? `lost ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}` : '',
      extra.length ? `gained ${extra.slice(0, 4).join(', ')}${extra.length > 4 ? '…' : ''}` : '',
    ].filter(Boolean).join(' · ');
    await notify('⚠️ Flip Watcher watching wrong symbols', detail,
      { sound: 'Basso', speak: 'Warning. Flip watcher symbol list has changed.' });
    log(`ALERTED: symbol drift — ${detail}`);
    writeAtomic(STATE_FILE, JSON.stringify({ ...prev, driftAlerted: true }, null, 2));
  } else if (!drifted && prev.driftAlerted) {
    log('symbol set back to expected');
    writeAtomic(STATE_FILE, JSON.stringify({ ...prev, driftAlerted: false }, null, 2));
  }
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch {
    // Writes are atomic, so this means external damage. Losing the baseline is
    // recoverable, but doing it silently is not — you would never know the
    // watcher had forgotten every prior regime.
    stateWasCorrupt = true;
    return null;
  }
}
let stateWasCorrupt = false;

function saveState(regimes, extra = {}) {
  try { return saveStateUnsafe(regimes, extra); }
  catch (e) { log(`WARN could not persist state: ${e.message}`); }
}

function saveStateUnsafe(regimes, extra = {}) {
  const prev = loadState() || {};
  // Spread prev FIRST so flags set earlier in this run (driftAlerted) survive.
  // Rebuilding the object from scratch silently dropped them, which made the
  // drift alert re-fire on every poll instead of once.
  writeAtomic(STATE_FILE, JSON.stringify({
    ...prev,
    updated: new Date().toISOString(),
    regimes: regimes ?? prev.regimes,
    failures: 0,
    blindAlerted: false,
    ...extra,
  }, null, 2));
}

/**
 * A watcher that goes quiet is indistinguishable from a watcher with nothing to
 * report — that is the dangerous failure mode. Track consecutive read failures
 * and raise one alert when the watcher has been blind long enough to matter,
 * then one more when it recovers. Alert on the transitions only, never every poll.
 */
const BLIND_AFTER = 5; // consecutive failed polls (~5 minutes at 60s)

async function recordFailure(reason) {
  const prev = loadState() || {};
  const failures = (prev.failures || 0) + 1;
  const alreadyAlerted = !!prev.blindAlerted;

  // "Blind" is meant for: we were watching and TradingView broke. If the last
  // SUCCESSFUL poll is ancient, the machine was asleep or off — TradingView being
  // unreachable is then expected, not a fault, and sounding a Basso alarm during
  // a 3am dark wake would be pure noise. The stale-wake path reports it properly
  // once you are actually back.
  const sinceGoodS = prev.updated
    ? (Date.now() - new Date(prev.updated).getTime()) / 1000
    : Infinity;
  const wasDown = sinceGoodS > STALE_WAKE_S;

  const shouldAlert = failures >= BLIND_AFTER && !alreadyAlerted && !wasDown;

  writeAtomic(STATE_FILE, JSON.stringify({
    ...prev,
    failures,
    blindAlerted: alreadyAlerted || shouldAlert,
    lastFailure: reason,
    lastFailureAt: new Date().toISOString(),
  }, null, 2));

  log(`FAIL (${failures}) ${reason}${wasDown ? ' [machine was down — alert suppressed]' : ''}`);

  if (shouldAlert) {
    await notify('⚠️ Flip Watcher is blind', reason,
      { sound: 'Basso', speak: 'Warning. Flip watcher is not reading the chart.' });
    log(`ALERTED: blind for ${failures} polls — ${reason}`);
  }

  // Zombie auto-recovery: if the scanner table is consistently missing and the
  // study is still attached to the chart, it is stuck in a runtime glitch.
  // Reloading the page forces TradingView to re-init from saved state.
  if (failures >= ZOMBIE_AFTER && reason.includes('scanner table not found') && !wasDown) {
    const recovered = await attemptZombieRecovery();
    if (recovered) log('ZOMBIE recovery attempted — next poll will verify');
  }

  process.exitCode = 1;
}

async function recordRecovery() {
  const prev = loadState() || {};
  if (prev.blindAlerted) {
    const wasZombie = (prev.zombieAttempts || 0) > 0;
    const detail = wasZombie
      ? `Recovered after ${prev.zombieAttempts} zombie recovery reload(s)`
      : 'Reading the chart again';
    await notify('✅ Flip Watcher recovered', detail,
      { sound: 'Glass', speak: 'Flip watcher is reading the chart again.' });
    log(`ALERTED: recovered${wasZombie ? ` (zombie cleared after ${prev.zombieAttempts} reload(s))` : ''}`);
  }
  // Clear zombie tracking on successful read — the incident is over.
  if (prev.zombieAttempts || prev.zombieGaveUp) {
    writeAtomic(STATE_FILE, JSON.stringify({
      ...prev,
      zombieAttempts: 0,
      zombieGaveUp: false,
      lastZombieRecovery: null,
    }, null, 2));
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  if (args.has('--test')) {
    const sample = [
      { ticker: 'SQQQ', from: 'BUY', to: 'SELL' },
      { ticker: 'TQQQ', from: 'SELL', to: 'BUY' },
    ];
    await notify(sample.map(fmtFlip).join(' · '),
      sample.map(f => `${f.ticker} ${f.from} → ${f.to}`).join(' · '),
      { speak: 'SQQQ flipped to sell, TQQQ flipped to buy' });
    log('sent test alert (banner attempted, sound + speech delivered)');
    return;
  }

  if (args.has('--core')) {
    const r = await cdpEvaluate(CORE_JS, v => v?.found).catch(e => ({ error: e.message }));
    if (r?.error || !r?.found) {
      log(`Core not readable: ${r?.error || 'not on chart'}`);
      process.exitCode = 1;
      return;
    }
    const live = CORE_SIGNAL_KEYS.some(k => numeric(r.values[k]) !== 0);
    log(live ? 'Phantom Flow Core: EMITTING' : 'Phantom Flow Core: all signals 0.00 (idle or paywalled)');
    for (const [k, v] of Object.entries(r.values)) {
      process.stdout.write(`  ${k.padEnd(20)} ${v}\n`);
    }
    if (existsSync(CORE_CSV)) {
      const rows = readFileSync(CORE_CSV, 'utf8').trim().split('\n').slice(1);
      const nz = rows.filter(l => l.trim().endsWith(',1')).length;
      process.stdout.write(`\n  ${rows.length} samples logged, ${nz} with a non-zero signal\n`);
    }
    return;
  }

  if (args.has('--accept-symbols')) {
    const r = await cdpEvaluate(EXTRACT_JS, v => v?.studies?.length > 0).catch(() => null);
    const reg = parseRegimes(r?.studies);
    if (!reg) { log('cannot read scanner — symbol list unchanged'); process.exitCode = 1; return; }
    const live = Object.keys(reg).map(shortName).sort();
    saveExpected(live);
    const prev = loadState() || {};
    writeAtomic(STATE_FILE, JSON.stringify({ ...prev, driftAlerted: false }, null, 2));
    log(`accepted new symbol list (${live.length}): ${live.join(', ')}`);
    return;
  }

  if (args.has('--alerts')) {
    if (!existsSync(ALERTS_FILE)) { log('no alerts recorded yet'); return; }
    const lines = readFileSync(ALERTS_FILE, 'utf8').trim().split('\n').slice(-25);
    process.stdout.write(`\nlast ${lines.length} alerts\n\n`);
    for (const l of lines) {
      const [ts, title] = l.split('\t');
      process.stdout.write(`  ${ts.slice(0, 19).replace('T', ' ')}  ${title}\n`);
    }
    process.stdout.write('\n');
    return;
  }

  if (args.has('--reset')) {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    log('state cleared; next run re-baselines without notifying');
    return;
  }

  let payload, readErr = null;
  for (let i = 0; i < READ_ATTEMPTS; i += 1) {
    try {
      payload = await cdpEvaluate(EXTRACT_JS, v => v?.studies?.length > 0);
      if (payload && !payload.error) { readErr = null; break; }
    } catch (err) { readErr = err; }
    if (i < READ_ATTEMPTS - 1) await sleep(READ_BACKOFF_MS);
  }
  if (readErr) return recordFailure(`cannot reach TradingView: ${readErr.message}`);

  if (payload?.error) {
    return recordFailure(`chart page error: ${payload.error}`);
  }

  const regimes = parseRegimes(payload?.studies);
  if (!regimes) {
    // Study not on the chart, or not rendering. Never fire a misleading
    // "all clear" — this counts as blindness, not as quiet.
    return recordFailure('scanner table not found — study off the chart?');
  }

  if (args.has('--status')) {
    const sells = Object.entries(regimes).filter(([, v]) => v === 'SELL');
    const buys = Object.entries(regimes).filter(([, v]) => v === 'BUY');
    log(`${buys.length} BUY / ${sells.length} SELL`);
    for (const [sym, st] of Object.entries(regimes)) {
      process.stdout.write(`  ${st.padEnd(4)}  ${shortName(sym)}\n`);
    }
    return;
  }

  // A successful read clears any blind streak (and tells you it recovered).
  await recordRecovery();

  cycle += 1;
  // Inside a burst these run every second otherwise — throttle the extras.
  if (cycle % PROBE_EVERY === 0 || !inBurstWindow()) await probeCore();
  if (cycle % HEARTBEAT_EVERY === 0) {
    log(`heartbeat — ${Object.keys(regimes).length} symbols tracked, reads OK`);
  }
  await checkDrift(regimes);

  const prev = loadState();
  const n = Object.keys(regimes).length;
  const barKey = Math.floor(Date.now() / BAR_MS);

  if (!prev?.regimes) {
    saveState(regimes, { pending: regimes, barKey });
    if (stateWasCorrupt) {
      await notify('⚠️ Flip Watcher state was corrupt',
        'Baseline rebuilt — prior regimes lost, no flips will be reported for this cycle',
        { sound: 'Basso', speak: 'Warning. Flip watcher state was corrupt and has been rebuilt.' });
      log(`ALERTED: state.json unreadable — baseline rebuilt from ${n} live symbols`);
    } else {
      log(`baseline saved (${n} symbols, ${MODE} mode) — no notification on first run`);
    }
    return;
  }

  // Did we miss a stretch of time (machine asleep, app quit, laptop lid shut)?
  const gapS = (Date.now() - new Date(prev.updated).getTime()) / 1000;
  if (gapS > STALE_WAKE_S) {
    const changed = [];
    for (const [sym, st] of Object.entries(regimes)) {
      const was = prev.regimes[sym];
      if (was && was !== st) changed.push(`${shortName(sym)} ${was}->${st}`);
    }
    saveState(regimes, { pending: regimes, barKey, settleUntil: Date.now() + SETTLE_S * 1000 });
    const mins = Math.round(gapS / 60);
    const human = mins >= 120 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
    // Always alert on wake so the user sees the book state immediately
    const buys = [], sells = [];
    for (const [sym, st] of Object.entries(regimes)) {
      (st === 'BUY' ? buys : sells).push(shortName(sym));
    }
    const bookLine = `${buys.length} BUY / ${sells.length} SELL`;
    if (changed.length) {
      await notify(`⏰ Down ${human} · ${changed.length} changed · ${bookLine}`,
        `Changed: ${changed.join(', ')} — NOT live signals`,
        { sound: 'Basso',
          speak: `Watcher was down ${human}. ${changed.length} regimes changed while it was not running. Book is now ${buys.length} buy, ${sells.length} sell. These are not live signals.` });
      log(`STALE WAKE: down ${human}, ${changed.length} changed (re-baselined, not reported as flips) — ${changed.join(', ')}`);
    } else {
      await notify(`⏰ Back online · ${bookLine}`,
        `Down ${human}, no changes — ${bookLine}`,
        { sound: 'Blow',
          speak: `Watcher back online after ${human}. No changes. Book is ${buys.length} buy, ${sells.length} sell.` });
      log(`STALE WAKE: down ${human}, no regime changes — notified book state`);
    }
    return;
  }

  // Still settling after a wake: absorb whatever the data does as it catches up.
  if (prev.settleUntil && Date.now() < prev.settleUntil) {
    saveState(regimes, { pending: regimes, barKey, settleUntil: prev.settleUntil });
    const left = Math.ceil((prev.settleUntil - Date.now()) / 1000);
    log(`settling after wake (${left}s left) — re-baselining, not judging`);
    return;
  }
  if (prev.settleUntil && Date.now() >= prev.settleUntil) {
    saveState(regimes, { pending: regimes, barKey, settleUntil: null });
    log('settled — resuming normal flip detection');
    return;
  }

  // In confirmed mode we judge a bar only once it has closed. `regimes` is the
  // live forming-bar reading, which repaints; `prev.pending` is the last reading
  // taken BEFORE the boundary, i.e. that bar's closing regime to within one poll.
  let before, after;
  if (MODE === 'intrabar') {
    before = prev.regimes;
    after = regimes;
  } else {
    if (prev.barKey === barKey) {
      // Still inside the same 30-minute bar: record what we see, judge nothing.
      saveState(prev.regimes, { pending: regimes, barKey });
      log(`in-bar sample (${n} symbols)`);
      return;
    }
    before = prev.regimes;
    after = prev.pending || regimes;
  }

  const flips = [];
  for (const [sym, state] of Object.entries(after)) {
    const was = before[sym];
    if (was && was !== state) {
      flips.push({ ticker: shortName(sym), from: was, to: state });
    }
  }

  saveState(after, { pending: MODE === 'intrabar' ? after : regimes, barKey });

  if (!flips.length) {
    log(MODE === 'confirmed'
      ? `bar closed — no flips (${n} symbols)`
      : `no flips (${n} symbols checked)`);
    return;
  }

  // This Mac has "Show previews: Never" (ncprefs content_visibility = 2), so
  // notification BODIES never render — for any app. The title is the only text
  // that reaches the screen, so the flips go there and the body carries the
  // detail for anyone who turns previews back on.
  const title = buildTitle(flips);

  const body = flips
    .map(f => `${f.ticker} ${f.from} → ${f.to}`)
    .join(' · ');

  // Spoken form reads naturally: "S Q Q Q flipped to sell".
  const spoken = flips
    .map(f => `${f.ticker.replace(/[^A-Za-z0-9]/g, '')} flipped to ${f.to.toLowerCase()}`)
    .join(', ');

  await notify(title, body, { speak: spoken });
  log(`NOTIFIED: ${flips.map(f => `${f.ticker} ${f.from}->${f.to}`).join(', ')}`);
}

// Read-only inspections do not take the lock, so `--status` still works while the
// daemon is polling.
const READ_ONLY = args.has('--status') || args.has('--core');

if (!READ_ONLY && !acquireLock()) {
  log('another poll still running — skipping this tick');
  process.exit(0);
}

const ONE_SHOT = READ_ONLY || args.has('--test') || args.has('--reset')
              || args.has('--accept-symbols') || args.has('--core');

/**
 * launchd ticks once a minute. Inside the burst window we keep polling at 1s for
 * the rest of that tick, so a flip at a 30-minute close is seen in ~1s instead of
 * up to 60s. Outside the window we do the single poll and exit, costing nothing.
 * The lock is held across the whole burst, so ticks can never overlap.
 */
async function cycleRunner() {
  const started = Date.now();
  await main();
  if (ONE_SHOT) return;
  while (inBurstWindow() && Date.now() - started < BURST_BUDGET_MS) {
    await sleep(BURST_MS);
    if (shuttingDown) break;
    await main();
  }
  // Close the cached WebSocket — no point keeping it open between launchd ticks.
  if (_cachedWs) { try { _cachedWs.close(); } catch {} _cachedWs = null; }
}

cycleRunner()
  .catch(err => { log(`FATAL ${err.stack || err.message}`); process.exitCode = 1; })
  .finally(() => { if (!READ_ONLY) releaseLock(); });
