#!/usr/bin/env node
/**
 * Flip Notifier health check.
 *
 * Verifies the whole chain end to end — scheduler, TradingView, CDP, the Pine
 * study, the state file, the alert path — and prints a report.
 *
 * Exit 0 = healthy, 1 = degraded, 2 = broken.
 * Pass --notify to also raise a desktop alert when something is wrong.
 */

import { execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(join(homedir(), 'tradingview-mcp', 'package.json'));
const WebSocket = require('ws');

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, 'state.json');
const LOG_FILE = join(HERE, 'flip-notifier.log');
const PLIST = join(homedir(), 'Library/LaunchAgents/com.dhruv.flipnotifier.plist');
const EXPECTED_FILE = join(HERE, 'expected-symbols.json');
const AWAKE_PLIST = join(homedir(), 'Library/LaunchAgents/com.dhruv.flipnotifier.awake.plist');
const CDP_HOST = process.env.FLIP_CDP || '127.0.0.1:9222';
const STALE_AFTER_S = 300;   // state older than this means polling has stopped
const EXPECTED_TF = process.env.FLIP_EXPECTED_TF || '30';  // Scanner's in_2 timeframe input

const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });
const log = msg => process.stderr.write(`  ${msg}\n`);
const run = (cmd, a) => new Promise(r =>
  execFile(cmd, a, (e, out) => r({ err: e, out: (out || '').trim() })));

/** CDP JS to detect a zombie study — on the chart but stuck, never reaching status 1 (completed). */
const ZOMBIE_CHECK = `
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
        isZombie: !!status && status.type !== 1
      };
    }
    return { found: false };
  } catch(e) { return { error: e.message }; }
})()`;

/* -------------------------------------------------- 1. scheduler */

async function checkScheduler() {
  if (!existsSync(PLIST)) return add('Scheduler', 'FAIL', 'LaunchAgent plist missing');
  let { out } = await run('/bin/launchctl', ['list']);
  let line = out.split('\n').find(l => l.includes('com.dhruv.flipnotifier'));

  // --repair: an unloaded agent is the one failure nothing else can self-heal,
  // because the thing that would notice is the thing that stopped running.
  if (!line && process.argv.includes('--repair')) {
    await run('/bin/launchctl', ['load', PLIST]);
    ({ out } = await run('/bin/launchctl', ['list']));
    line = out.split('\n').find(l => l.includes('com.dhruv.flipnotifier'));
    if (line) return add('Scheduler', 'WARN', 'was unloaded — reloaded by --repair');
  }
  if (!line) {
    return add('Scheduler', 'FAIL',
      'LaunchAgent not loaded — rerun with --repair, or launchctl load the plist');
  }
  const lastExit = line.trim().split(/\s+/)[1];
  if (lastExit !== '0') {
    return add('Scheduler', 'WARN', `loaded, but last run exited ${lastExit}`);
  }
  add('Scheduler', 'OK', 'LaunchAgent loaded, last run clean');
}

/* -------------------------------------------------- 2. TradingView + CDP */

async function checkChart() {
  let targets;
  try {
    const res = await fetch(`http://${CDP_HOST}/json/list`, { signal: AbortSignal.timeout(5000) });
    targets = await res.json();
  } catch (e) {
    add('TradingView', 'FAIL', `CDP unreachable on ${CDP_HOST} — app closed?`);
    return null;
  }
  const page = targets.find(t => t.type === 'page' && (t.url || '').includes('/chart/'));
  if (!page) { add('TradingView', 'FAIL', 'running, but no chart tab open'); return null; }
  add('TradingView', 'OK', `chart tab live on ${CDP_HOST}`);
  return page;
}

/* -------------------------------------------------- 3. the study itself */

const EXTRACT = `
(function () {
  try {
    var widget = window.TradingViewApi._activeChartWidgetWV.value();
    var chart = widget._chartWidget;
    var srcs = chart.model().model().dataSources();
    var found = null, all = [];
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i]; if (!s.metaInfo) continue;
      var m = s.metaInfo(); var n = m.description || m.shortDescription || '';
      if (!n) continue; all.push(n);
      if (n.indexOf('Flip') === -1) continue;
      var outer = s._graphics && s._graphics._primitivesCollection
                && s._graphics._primitivesCollection.dwgtablecells;
      if (!outer) { found = { name: n, cells: 0 }; continue; }
      var inner = outer.get('tableCells');
      var coll = inner && inner._primitivesDataById ? inner
               : (inner && typeof inner.get === 'function' ? inner.get(false) : null);
      var cells = [];
      if (coll && coll._primitivesDataById) {
        coll._primitivesDataById.forEach(function (v) {
          cells.push({ row: v.row, col: v.col, t: v.t || '' });
        });
      }
      var tf = null;
      try {
        var props = s.properties && s.properties();
        var inputs = props && props.inputs;
        var raw = inputs && inputs.in_2;
        if (raw && typeof raw.value === 'function') tf = raw.value();
        else if (raw && typeof raw === 'object' && 'value' in raw) tf = raw.value;
        else if (typeof raw === 'string') tf = raw;
      } catch (e) {}
      found = { name: n, cells: cells.length, data: cells, tf: tf };
    }
    var sym = null;
    try {
      sym = widget.symbol && widget.symbol();   // lives on the widget, not _chartWidget
      if (sym && typeof sym === 'object') sym = sym.symbol || sym.full_name || sym.ticker || null;
    } catch (e) {}
    return { studies: all, flip: found, symbol: typeof sym === 'string' ? sym : null };
  } catch (e) { return { error: String(e && e.message || e) }; }
})()`;

function cdpEval(page, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })));
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString()); if (m.id !== 1) return;
      clearTimeout(t); try { ws.close(); } catch {}
      resolve(m.result?.result?.value);
    });
    ws.on('error', e => { clearTimeout(t); reject(e); });
  });
}

async function checkStudy(page) {
  if (!page) { add('Flip Scanner', 'FAIL', 'skipped — no chart'); return null; }
  let v;
  try { v = await cdpEval(page, EXTRACT); }
  catch (e) { add('Flip Scanner', 'FAIL', `read failed: ${e.message}`); return null; }
  if (v?.error) { add('Flip Scanner', 'FAIL', `page error: ${v.error}`); return null; }
  if (!v?.flip) {
    add('Flip Scanner', 'FAIL',
      `study not on chart (present: ${(v?.studies || []).join(', ') || 'none'})`);
    return null;
  }
  if (!v.flip.cells) {
    // Study is on the chart but producing nothing — likely a zombie (stuck in a
    // restart loop). With --repair, reload the page to force a clean re-init.
    if (process.argv.includes('--repair')) {
      let reloaded = false;
      try {
        const zombieCheck = await cdpEval(page, ZOMBIE_CHECK);
        if (zombieCheck?.found) {
          log(`  zombie detected: status=${zombieCheck.statusType} ` +
              `started=${zombieCheck.isStarted} restarting=${zombieCheck.restarting}`);
          // Reload the page — TradingView auto-saves chart state, so everything
          // comes back, but the runtime glitch is cleared.
          await cdpEval(page, 'window.location.reload()');
          reloaded = true;
          add('Flip Scanner', 'WARN',
            'was zombie (attached, not rendering) — page reloaded by --repair; ' +
            're-run healthcheck in ~60s to verify');
        }
      } catch (e) {
        log(`  zombie recovery failed: ${e.message}`);
      }
      if (!reloaded) add('Flip Scanner', 'FAIL', 'attached but rendering nothing');
    } else {
      add('Flip Scanner', 'FAIL',
        'attached but rendering nothing — rerun with --repair to attempt auto-recovery');
    }
    return null;
  }

  const rows = new Map();
  for (const c of v.flip.data) {
    if (!rows.has(c.row)) rows.set(c.row, {});
    rows.get(c.row)[c.col] = c.t;
  }
  const regimes = {};
  for (const [n, cols] of rows) {
    if (n === 0) continue;
    const st = (cols[1] || '').toUpperCase();
    if (cols[0] && (st === 'BUY' || st === 'SELL')) regimes[cols[0]] = st;
  }
  const n = Object.keys(regimes).length;
  const delayed = Object.keys(regimes).filter(s => s.includes('_DL:')).length;
  const sells = Object.values(regimes).filter(v2 => v2 === 'SELL').length;
  add('Flip Scanner', n ? 'OK' : 'FAIL',
    `${n} symbols · ${n - sells} BUY / ${sells} SELL · host ${v.symbol || '?'}`);
  // Delayed futures feeds are a permanent data-subscription fact, not a fault.
  // Reporting them as a warning every day would train you to ignore this check.
  if (delayed) add('Data feeds', 'INFO', `${delayed} of ${n} delayed (_DL) — CME add-on not held`);
  else add('Data feeds', 'OK', 'all symbols real-time');

  // in_2 empty means "follow the chart" — the Scanner then computes on whatever
  // timeframe the chart happens to show, producing correct-looking output on the
  // wrong bars. Re-adding a study resets inputs, so this reverts silently and no
  // other check here can see it.
  const tf = v.flip.tf;
  if (tf === null || tf === undefined) {
    add('Timeframe', 'WARN', 'could not read in_2 — verify the Scanner is pinned manually');
  } else if (String(tf) === '') {
    add('Timeframe', 'FAIL',
      `in_2 empty — Scanner is following the chart, not pinned to ${EXPECTED_TF}m`);
  } else if (String(tf) !== String(EXPECTED_TF)) {
    add('Timeframe', 'FAIL', `pinned to ${tf} — expected ${EXPECTED_TF}`);
  } else {
    add('Timeframe', 'OK', `pinned to ${EXPECTED_TF}m (chart-independent)`);
  }
  return regimes;
}

/* -------------------------------------------------- 4. state file */

function checkState() {
  if (!existsSync(STATE_FILE)) return add('State', 'FAIL', 'state.json missing');
  let s;
  try { s = JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return add('State', 'FAIL', `unreadable: ${e.message}`); }
  const age = (Date.now() - new Date(s.updated).getTime()) / 1000;
  if (s.failures > 0) {
    return add('State', 'WARN',
      `${s.failures} consecutive failed polls — ${s.lastFailure || 'unknown'}`);
  }
  if (age > STALE_AFTER_S) {
    return add('State', 'FAIL',
      `last good read ${Math.round(age / 60)} min ago — polling has stopped`);
  }
  add('State', 'OK', `fresh (${Math.round(age)}s old, ${Object.keys(s.regimes || {}).length} symbols)`);
}

/* -------------------------------------------------- 4b. symbol set */

/**
 * The curated list lives on the study INSTANCE. Removing and re-adding the study
 * resets it to the script's defaults (SPX, DXY, VIX, FX pairs) with no visible
 * error — the scanner keeps running, just on a book you do not trade. Running is
 * not the same as watching the right thing.
 */
function checkSymbols(regimes) {
  if (!regimes) return add('Symbol set', 'FAIL', 'skipped — scanner unreadable');
  if (!existsSync(EXPECTED_FILE)) return add('Symbol set', 'WARN', 'no expected list recorded yet');
  let expected;
  try { expected = JSON.parse(readFileSync(EXPECTED_FILE, 'utf8')).tickers || []; }
  catch { return add('Symbol set', 'WARN', 'expected-symbols.json unreadable'); }

  const short = s2 => (s2.includes(':') ? s2.split(':').pop() : s2);
  const live = Object.keys(regimes).map(short);
  const L = new Set(live), E = new Set(expected);
  const missing = expected.filter(t => !L.has(t));
  const extra = live.filter(t => !E.has(t));

  if (!missing.length && !extra.length) {
    return add('Symbol set', 'OK', `matches expected (${expected.length} tickers)`);
  }
  const bits = [];
  if (missing.length) bits.push(`missing ${missing.join(', ')}`);
  if (extra.length) bits.push(`unexpected ${extra.join(', ')}`);
  add('Symbol set', 'FAIL',
    `${bits.join(' · ')} — study likely re-added and reset to defaults; fix inputs or run --accept-symbols`);
}

/* -------------------------------------------------- 4c. stuck lock */

function checkLock() {
  const lock = join(HERE, '.lock');
  if (!existsSync(lock)) return add('Lock', 'OK', 'no poll in flight');
  const ageS = (Date.now() - statSync(lock).mtimeMs) / 1000;
  if (ageS > 300) {
    return add('Lock', 'FAIL',
      `lock held ${Math.round(ageS / 60)} min — a poll is wedged; delete .lock`);
  }
  add('Lock', 'OK', `held ${Math.round(ageS)}s (poll in flight)`);
}

/* -------------------------------------------------- 4d. sleep protection */

/**
 * The watcher cannot poll while the Mac is asleep, and it cannot report that
 * either — nothing is running to notice. Sleep protection is therefore load-
 * bearing for overnight coverage, and its failure is silent.
 *
 * A missing plist is treated as a deliberate opt-out (INFO). A plist that exists
 * but is not actually holding an assertion is a fault.
 */
async function checkSleepGuard() {
  if (!existsSync(AWAKE_PLIST)) {
    return add('Sleep guard', 'INFO', 'not installed — Mac sleeps normally, lid close stops polling');
  }

  const { out: listed } = await run('/bin/launchctl', ['list']);
  let loaded = listed.split('\n').some(l => l.includes('com.dhruv.flipnotifier.awake'));

  let repaired = false;
  if (!loaded && process.argv.includes('--repair')) {
    await run('/bin/launchctl', ['load', AWAKE_PLIST]);
    // caffeinate needs a moment to start and register its assertion; checking
    // immediately reports a false "loaded but no assertion".
    await new Promise(r => setTimeout(r, 2000));
    const { out: again } = await run('/bin/launchctl', ['list']);
    loaded = again.split('\n').some(l => l.includes('com.dhruv.flipnotifier.awake'));
    repaired = loaded;
  }

  // The assertion is what actually matters — the agent can be "loaded" while its
  // caffeinate has died.
  const { out: assertions } = await run('/usr/bin/pmset', ['-g', 'assertions']);
  const caffeinateHeld = /caffeinate[^\n]*PreventSystemSleep/i.test(assertions);
  const amphetamineHeld = /Amphetamine[^\n]*Prevent/i.test(assertions);
  const held = caffeinateHeld || amphetamineHeld;
  const source = [caffeinateHeld && 'caffeinate', amphetamineHeld && 'Amphetamine'].filter(Boolean).join(' + ');

  if (loaded && held) {
    return add('Sleep guard', repaired ? 'WARN' : 'OK',
      repaired ? 'was unloaded — reloaded by --repair, assertion restored'
               : `sleep prevention held by ${source} — lid close keeps polling`);
  }
  if (loaded && !held) {
    return add('Sleep guard', 'FAIL',
      'agent loaded but NO sleep assertion — lid close will stop the watcher');
  }
  add('Sleep guard', 'FAIL',
    'agent not loaded — lid close will stop the watcher; rerun with --repair');
}

/* -------------------------------------------------- 5. alert path */

async function checkAlerts() {
  const sound = '/System/Library/Sounds/Submarine.aiff';
  const problems = [];
  if (!existsSync(sound)) problems.push('sound file missing');
  const { err } = await run('/usr/bin/osascript', ['-e', 'return 1']);
  if (err) problems.push('osascript unavailable');

  // Notification previews hidden => body text never renders; we put the flip in
  // the title precisely because of this, so it is informational, not a failure.
  const { out } = await run('/usr/bin/defaults', ['read', 'com.apple.ncprefs', 'content_visibility']);
  const previewsOff = out === '2' || out === '3';

  // Email channel: verify Keychain has the app password and send-email.js exists
  const emailScript = join(HERE, 'send-email.js');
  let emailStatus = '';
  if (!existsSync(emailScript)) {
    problems.push('send-email.js missing');
  } else {
    try {
      const { out: pw } = await run('/usr/bin/security',
        ['find-generic-password', '-a', 'darup67@gmail.com', '-s', 'flip-notifier-gmail', '-w']);
      if (pw && pw.length >= 10) {
        emailStatus = ' · email ready';
      } else {
        problems.push('Gmail app password not in Keychain');
      }
    } catch {
      problems.push('Gmail app password not in Keychain');
    }
  }

  if (problems.length) add('Alert path', 'FAIL', problems.join('; '));
  else add('Alert path', 'OK',
    `sound + speech ready${previewsOff ? ' · previews off, flip text in title' : ''}${emailStatus}`);
}

/* -------------------------------------------------- 6. recent errors */

function checkLog() {
  if (!existsSync(LOG_FILE)) return add('Log', 'WARN', 'no log yet');
  const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n');
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = lines.filter(l => {
    const ts = Date.parse(l.slice(0, 24));
    return !Number.isNaN(ts) && ts > cutoff;
  });
  const fails = recent.filter(l => /FAIL|ERROR|FATAL/.test(l)).length;
  const flips = recent.filter(l => l.includes('NOTIFIED:')).length;
  const size = (statSync(LOG_FILE).size / 1024).toFixed(0);

  // Judge on failures SINCE THE LAST SUCCESS, not failures inside a time window.
  // A burst that already recovered sits inside "the last hour" for a full hour
  // afterwards, so a window makes a closed incident read exactly like a live
  // outage — and a check that cries wolf is one you stop reading. Consecutive
  // failures with no success after them is the only shape that means "broken now".
  let sinceSuccess = 0;
  let lastOkAt = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (/no flips|NOTIFIED:|baseline saved/.test(l)) { lastOkAt = Date.parse(l.slice(0, 24)); break; }
    if (/FAIL|ERROR|FATAL/.test(l)) sinceSuccess += 1;
  }

  const detail = `${recent.length} polls / ${fails} failures / ${flips} flips in 24h · ${size} KB`;

  if (sinceSuccess >= 3) {
    add('Log', 'FAIL', `${sinceSuccess} consecutive failures, no success since — polling is broken · ${detail}`);
  } else if (sinceSuccess > 0) {
    add('Log', 'WARN', `${sinceSuccess} failure(s) since last success · ${detail}`);
  } else {
    // Healthy now. Mention a recovered burst as context so it is visible without
    // being alarming — history, explicitly labelled as history.
    const hourAgo = Date.now() - 3600 * 1000;
    const lastHourFails = recent.filter(l =>
      /FAIL|ERROR|FATAL/.test(l) && Date.parse(l.slice(0, 24)) > hourAgo).length;
    const mins = lastOkAt ? Math.round((Date.now() - lastOkAt) / 60000) : null;
    const age = mins === null ? '' : ` · last success ${mins}m ago`;
    if (lastHourFails > 5) {
      add('Log', 'OK', `recovered — ${lastHourFails} failures earlier this hour, none since${age} · ${detail}`);
    } else {
      add('Log', 'OK', `${detail}${age}`);
    }
  }
}

/* -------------------------------------------------- report */

async function main() {
  await checkScheduler();
  const page = await checkChart();
  const regimes = await checkStudy(page);
  checkSymbols(regimes);
  checkState();
  checkLock();
  await checkSleepGuard();
  await checkAlerts();
  checkLog();

  const fails = checks.filter(c => c.status === 'FAIL');
  const warns = checks.filter(c => c.status === 'WARN');
  const verdict = fails.length ? 'BROKEN' : warns.length ? 'DEGRADED' : 'HEALTHY';

  const icon = { OK: '✓', WARN: '!', FAIL: '✗', INFO: '·' };
  const w = Math.max(...checks.map(c => c.name.length));
  process.stdout.write(`\nFlip Notifier — ${verdict}   ${new Date().toLocaleString()}\n\n`);
  for (const c of checks) {
    process.stdout.write(`  ${icon[c.status]} ${c.name.padEnd(w)}  ${c.detail}\n`);
  }
  process.stdout.write('\n');

  if (process.argv.includes('--notify') && verdict !== 'HEALTHY') {
    const summary = (fails[0] || warns[0]).detail;
    const title = fails.length ? '✗ Flip Watcher BROKEN' : '! Flip Watcher degraded';
    await run('/usr/bin/osascript',
      ['-e', `display notification "${summary.replace(/"/g, "'")}" with title "${title}"`]);
    await run('/usr/bin/afplay', ['/System/Library/Sounds/Basso.aiff']);
  }

  process.exitCode = fails.length ? 2 : warns.length ? 1 : 0;
}

main().catch(e => {
  process.stdout.write(`healthcheck crashed: ${e.stack || e.message}\n`);
  process.exitCode = 2;
});
