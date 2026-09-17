# Flip Watcher — the whole stack

How the pieces fit, what each one can fail at, and what catches that failure.

> **Sibling watcher:** [`KALSHI.md`](KALSHI.md) documents `kalshi-watcher.js`,
> which applies this same architecture to Kalshi prediction markets. Separate
> poller, state, and log; shared alert channels and `send-email.js`.

```
TradingView Desktop  (must be running, CDP port 9222)
        │
        │  Pine study "Watchlist Flip Scanner" v6.0 on an open chart
        │  Supertrend(10, 3.0), tf pinned 30m, 16 symbols
        │  renders a BUY/SELL table on the chart
        ▼
flip-notifier.js     ← LaunchAgent com.dhruv.flipnotifier, every 60s
        │  reads that table over CDP, diffs against state.json
        ▼
   alert:  banner title  +  chime  +  spoken summary
        │
        ▼
healthcheck.js       ← scheduled task flip-watcher-daily-health, weekdays 08:38
        verifies every link above and reports
```

## Failure modes and what catches each

| If this breaks | Symptom | Caught by |
|---|---|---|
| TradingView closed | no reads | notifier → "blind" alert after 5 polls; daily check |
| Study removed from chart | no table | notifier → "blind" alert; daily check |
| Study attached but dead (zombie) | table empty, study stuck in restart loop | notifier → auto-reload after 5 failures (~5 min, up to 3 attempts); daily check --repair also reloads |
| LaunchAgent unloaded | no polls at all | daily check (`polling has stopped`) — the notifier cannot catch this, it isn't running |
| Kalshi watcher breaks | no prediction-market signals | daily check — 5 `Kalshi *` rows; see [`KALSHI.md`](KALSHI.md) |
| Chart symbol changed | nothing — by design | n/a, `tf` is pinned to 30m and symbols are explicit |
| Notification previews off | body text hidden | handled: flip text lives in the title |
| Sound muted / wrong output | silent alerts | **nothing catches this** — see Known gaps |

## The blindness guard

A watcher that goes quiet looks exactly like a watcher with nothing to report. That
is the dangerous failure, so failures are counted rather than ignored:

- Failures 1–4: logged, silent.
- Failure 5 (~5 min): one **⚠️ Flip Watcher is blind** alert, Basso + speech.
- Failures 6+: silent. No spam.
- First success after that: one **✅ Flip Watcher recovered** alert, then normal.

Regimes are preserved across an outage, so recovery does not manufacture false flips.

Verified: alerts on #5, stays quiet on #6, recovers cleanly, no phantom flips.

## Zombie auto-recovery

A "zombie" study is attached to the chart but stuck in a runtime restart loop
(status type 2, `restarting: true`, `isStarted: false`). It produces no table
output, so the notifier logs "scanner table not found" every poll.

**Notifier** (automatic):
- After **5 consecutive** "scanner table not found" failures:
  1. Checks via CDP if the study is on the chart but not completed (zombie).
  2. If confirmed, reloads the TradingView page (`Page.reload` via CDP).
  3. TradingView auto-saves chart state, so all studies and inputs survive.
  4. Sets a 90s settle window, then normal polling resumes.
- Cooldown: 10 minutes between reload attempts.
- Max 3 reloads per incident. After 3, sends 🧟 alert for manual intervention.
- On recovery (first successful read), clears zombie counters and sends ✅ alert.

**Healthcheck** (`--repair`):
- When it detects "attached but rendering nothing", checks zombie status.
- If confirmed, reloads the page and reports "reloaded by --repair".

**Root cause**: zombie state was observed after removing and re-adding the study
programmatically — the study's internal state machine got stuck. A page reload
clears the runtime glitch because TradingView re-initializes from saved state.

## Known gaps

- **Audio output is unverified.** The alert commands succeed regardless of whether
  the sound is audible. Muted volume or a disconnected output device produces a
  successful-looking silent alert. Nothing in this stack can detect that.
- **The daily check needs the Claude app open.** If it is closed at 08:38 the run
  happens at next launch, so a scheduler failure could go unnoticed for a while.
- **Weekday schedule.** Deliberate: on weekends TradingView is often closed, and a
  daily BROKEN report you learn to ignore is worse than no report.
- **Delayed feeds.** MNQ, MES, MYM, MGC, MCL are `_DL` — flips on those are up to
  10 minutes late. A data subscription limit, not fixable in code.

## Commands

```bash
cd ~/flip-notifier

node healthcheck.js            # full stack report; exit 0/1/2
node healthcheck.js --notify   # ...and alert if not healthy
node flip-notifier.js --status # current regimes, no notification
node flip-notifier.js --test   # fire a sample alert
node flip-notifier.js --reset  # clear state, re-baseline silently

launchctl list | grep flipnotifier
tail -30 flip-notifier.log

FLIP_CDP=127.0.0.1:9999 node healthcheck.js   # simulate TradingView being down
FLIP_SPEAK=0 node flip-notifier.js            # mute speech
```

## Phantom Flow Core probe

Core sits on the chart anyway, so sampling it costs no indicator slot. Every poll
appends its four signal values to `core-probe.csv`.

**The question it answers:** the Alert Bridge can only fire if Core's Confluence /
Osc plots actually emit. If they are pinned at 0.00 by the vendor paywall, then
spending both free-tier indicator slots on Core + Bridge buys permanent silence —
and costs you the working 16-symbol scanner. Evidence before commitment.

```bash
node flip-notifier.js --core    # current values + how many samples were non-zero
```

Read it as:
- **any non-zero sample** → Core is emitting; the Bridge is viable.
- **flat 0.00 across a full session** → Core's signals are inert; the Bridge cannot
  work and Option A is dead.

First reading: the four signal plots are 0.00, but Core's *other* plots
(Phantom Shift Up, Phantom MA Base, PlotCandle) carry live, updating values at the
correct price scale. So Core is computing, not frozen — which favours "idle" over
"paywalled", but one sample proves nothing. The signal plots are impulse-style
(non-zero only on the bar they fire); at 60s polling against 30m bars we get ~30
samples per bar, so a fire cannot slip through unseen.

## Bar-close confirmation (default)

The study's table is drawn under `barstate.islast`, not `barstate.isconfirmed`, so
it repaints: a regime can flip and un-flip inside one 30-minute bar. Reading it
naively produced alerts that could reverse minutes later.

The notifier now judges a bar only once it has closed:

- Every poll records the live reading as `pending`.
- When the 30-minute boundary passes, the last **pre-boundary** `pending` is
  promoted to `confirmed` and diffed against the previous `confirmed`.
- Alerts fire only on that comparison.

**Current default is `intrabar`** — alerts fire the moment the table changes,
0-60 s detection. A flip that does not survive the bar still alerts, and when it
reverts you get a second alert. Treat an alert as "go look", not as a signal.

`FLIP_MODE=confirmed` switches to bar-close judging: worst-case detection becomes
~30 min, in exchange for never alerting on a flip that does not survive the bar.
Both code paths are live and tested; only the default changed.

Verified: a flip mid-bar logs `in-bar sample` and stays silent; the same flip with
the boundary passed fires `NOTIFIED: SQQQ BUY->SELL`.

## Setup quality scoring

Every flip alert is scored 0–5 on three factors, purely from data already in hand
(no extra CDP calls, no latency):

| Factor | Points | What it measures |
|---|---|---|
| Correlation | 0–2 | How many symbols flipped the same direction (1=isolated, 4+=wave) |
| Trend alignment | 0–2 | Does the flip go WITH the majority regime? |
| Stability | 0–1 | Has this ticker been choppy? (checks `alerts.tsv` last 24h) |

Labels: 🔥 **STRONG** (4–5) · ⚡ **MODERATE** (2–3) · 💤 **WEAK** (0–1)

### Conviction floor

**Flips scoring below MODERATE are recorded but not announced** (`MIN_SCORE`,
default 2; override with `FLIP_MIN_SCORE`).

WEAK means the flip was isolated, counter-trend, *and* on a ticker that has been
oscillating — the three things that most often precede it reverting. Those are
the alerts you look at, do nothing about, and slowly learn to ignore, which is
what makes the ones worth acting on easy to miss.

Suppression is deliberately **not** silence:

- the regime **still updates**, so the next real flip diffs from a correct baseline
- the flip is logged with its score: `held back 1 below-threshold flip(s): XRPUSD BUY->SELL [MODERATE:2]`
- a partly-suppressed alert names the count: `NOTIFIED: … (+2 held back)`

Scoring happens against the **full** set before filtering — correlation is a
property of the whole poll, so a flip has to be measured against every sibling
before any are dropped.

Verified: a below-threshold flip is held back while state still advances to the
new regime; a mixed poll alerts 3 and holds 2.

### Conviction in the title

The banner title now leads with the tier: **🔥 STRONG**, **⚡ MODERATE**. WEAK
never appears — those are filtered out upstream and never reach a title.

```
⚡ ⬆️ LINKUSD → BUY
🔥 ⬇️3 TQQQ SOXL MU
🔥 ⬇️1 TQQQ  ⬆️1 SQQQ
```

This is not decoration. Previews are off on this Mac, so notification **bodies
never render** — the title is the entire visible payload. Before this, a
borderline MODERATE and a 5/5 STRONG produced identical banners, so the
conviction score existed but was invisible exactly where it would be acted on.

On a mixed poll the icon reports the **best** flip present, since that is the one
deciding whether the banner is worth interrupting for; the body still scores
every flip individually. The icon is charged against the fixed title budget, so
a long ticker list loses a name to `+N` rather than being truncated by macOS.

The score appears in:
- **Email body** — full breakdown with factors
- **Speech** — "…strong setup." / "…weak setup."
- **Log** — `NOTIFIED: TQQQ BUY->SELL [STRONG:5]`
- **alerts.tsv** — durable record

The banner title is unchanged (space-constrained, previews off). The score tells
you which flips are worth acting on versus noise — a 5-symbol SELL wave scores
STRONG, an isolated counter-trend flip in a choppy symbol scores WEAK.

## Sleep / lid close — the one gap the blind guard cannot cover

> Since 2026-09-17 the notifier, kalshi watcher and market-lab jobs use
> `StartCalendarInterval` (every minute / :00,:05… / :00,:10… / :00,:30) instead of
> `StartInterval`, after launchd stopped firing all interval jobs on 2026-09-15.
> Backups of the old plists: `~/Library/LaunchAgents.bak-20260917/`.
> Also on 2026-09-17: `sudo pmset -a disablesleep 1` was set so lid close no longer
> sleeps the machine (check with `pmset -g | grep SleepDisabled`; undo with `disablesleep 0`).

Closing the lid sleeps the machine. Scheduled launchd jobs do not fire during sleep,
so the notifier is not running and therefore **cannot detect its own absence** —
the 5-failure blind alert never triggers, because nothing is failing, nothing is
running. Sleep produces exactly the ambiguous silence the design exists to prevent.

`sleep 0` only disables the *idle* timer. It does not keep the machine awake when
the lid shuts.

**What happens on wake:** launchd fires the job once (it does not replay each
missed interval). The notifier then sees regimes that may have moved hours ago.
Reporting those as fresh flips would be worse than silence — you would act on a
stale signal.

**Stale-wake guard:** if more than `STALE_WAKE_S` (360 s = 6 missed polls) has
passed since the last successful poll, regime differences are re-baselined and
reported as a gap, never as live flips:

```
⏰ Watcher was down 7.0h — 1 changed while down — NOT live: SQQQ BUY->SELL
```

Distinct sound (Basso) and distinct wording, so it cannot be mistaken for a signal.
Verified: a 7 h gap reports STALE WAKE; a normal gap with the same change still
reports NOTIFIED.

**To actually keep watching with the lid shut** you need clamshell mode — external
display, power, and an external keyboard/mouse. Alternatively, **Amphetamine**
(free, Mac App Store) can keep the machine awake with just power connected, no
external display needed — its "closed-display mode" overrides lid-close sleep.
Otherwise accept the outage; the guard makes it honest rather than dangerous.

### Post-wake: catch-up alert + settle window

On wake the notifier immediately fires a **catch-up alert** so you know the book
state the moment you sit down:

- **Changes while down:** `⏰ Down 7.0h · 3 changed · 9 BUY / 7 SELL` (Basso)
- **No changes:** `⏰ Back online · 9 BUY / 7 SELL` (Blow)

Both include a spoken summary. Changed regimes are listed but labelled "NOT live"
so they cannot be mistaken for actionable signals.

After the catch-up alert, a `SETTLE_S` (60 s) window absorbs data churn as
TradingView reconnects and backfills (~15-30s). During it every poll re-baselines
without judging:

```
STALE WAKE: down 7.0h, no regime changes — notified book state
settling after wake (55s left) — re-baselining, not judging
settled — resuming normal flip detection
NOTIFIED: SOXL BUY->SELL          <- real flips work again
```

Cost: a genuine flip in the first ~60s after wake is absorbed rather than alerted.
That is the right trade — the alternative is a burst of stale signals at exactly
the moment you sit down and are most likely to act on one.

## Hardening

| Failure | Before | Now |
|---|---|---|
| Killed mid-write | truncated JSON → silent re-baseline | temp-file + `rename()` (atomic); a corrupt file still found is **alerted**, not swallowed |
| Overlapping polls | two processes racing state.json | PID lockfile; second poll skips. Stale locks self-clear by PID liveness + age |
| Hung `say` / `afplay` / CDP | poll hangs forever | 15 s timeout, SIGKILL |
| Second chart tab without the study | permanently blind on the wrong tab | evaluates **every** chart tab, keeps the first that answers |
| Corrupt `expected-symbols.json` | silently adopted current symbols, drift detection off | refuses, warns, leaves the file alone |
| Disk full / write error | unhandled throw → crash loop | caught and logged, poll still completes |
| LaunchAgent unloaded | nothing self-healed it | `healthcheck.js --repair` reloads it; the daily routine passes `--repair` |
| Wedged lock | — | health check FAILs if a lock is held > 5 min |
| Sleep protection stops | silent — lid close would stop overnight coverage with no warning | health check verifies the agent is loaded **and** actually holding `PreventSystemSleep`; `--repair` reloads it |
| SIGTERM from launchd | lock file orphaned until stale detection | SIGTERM/SIGINT handler releases lock and closes CDP socket immediately |
| Burst CDP overhead | 50+ WebSocket handshakes per burst (one per poll) | connection cached and reused across burst polls; closed at burst end |
| Burst target discovery | 50+ HTTP requests to `/json/list` per burst | target list cached for 5s (covers a full burst, short enough to catch tab changes) |
| TradingView drops mid-request | promise hangs until 10s timeout | WebSocket `close` event rejects immediately; cache invalidated so next poll reconnects |

Read-only commands (`--status`, `--core`) skip the lock, so they work while the
daemon polls.

All verified by fault injection: truncated state, simultaneous launches, dead-PID
lock, invalid expected-symbols, and an unloaded LaunchAgent.

## Reconciliation with the earlier pine-alerts watcher

A second flip watcher already existed and had been running ~13 h:
`~/pine-alerts/watch16.mjs`, supervised by two LaunchAgents
(`com.dhruvpatel.flipwatcher` + `com.dhruvpatel.flipwatchdog`), reading the same
Scanner table via the MCP CLI and alerting with the same Submarine sound. Both
were firing, so every flip would have chimed twice.

**Ported from it (it was better at these):**

- **Adaptive burst polling.** A flip can only appear at a 30-minute close, so
  poll at 1 s from 10 s before a boundary until 120 s after, and once per launchd
  tick otherwise. Detection at a bar close drops from up to 60 s to ~1 s.
  The burst runs inside one launchd tick (50 s budget) and holds the lock, so
  ticks still cannot overlap.
- **Retry before declaring blindness** — 4 attempts, 2.5 s apart. Failing on the
  first miss produced false blind alerts.
- **Non-blocking speech** — `say` is fire-and-forget; it was adding ~2 s per alert.
- **Heartbeat** proof-of-life line in the log.

**Not ported:** its "27 symbols tracked" was a defect, not coverage. Its in-memory
Map never pruned, so it still held the 11 default symbols from when the study reset
its inputs, plus the 16 curated ones. It could never notice a symbol leaving the
book. The `expected-symbols.json` drift check is the correct treatment.

**Sleep protection preserved.** The old watcher ran under `caffeinate -is`, so it
held `PreventSystemSleep` as a side effect — which is why closing the lid did not
stop anything. Retiring it would have silently removed that. Replaced with a
dedicated agent, `com.dhruv.flipnotifier.awake`, installed and verified holding the
assertion BEFORE the old pair was unloaded. Unload it if you want normal sleep.

Old files are left in place, untouched, in `~/pine-alerts/`.

## Phantom Flow Core alerts

The Core probe originally only logged to `core-probe.csv` — it was built to answer
"does Core emit at all", not to notify. So the 14 `Osc Buy` fires on 2026-09-04
(01:30:09–01:34:30Z, on BTCUSD) produced no banner. That was by design, and the
design was wrong for how it is actually used.

Core now alerts, with two differences from the flip alerts:

- **Edge-triggered.** A Core impulse stays non-zero across consecutive polls — the
  one observed burst held for 14 samples over 4 minutes. Alerting per live poll
  would have meant 14 chimes for one signal. It fires on the 0 → non-zero
  transition only, then goes quiet until Core returns to idle.
- **Names the chart symbol.** Unlike the Scanner, which evaluates 16 explicit
  symbols and is chart-independent, **Core computes on whatever the chart is
  showing**. A Core alert is meaningless without knowing what it fired on, so the
  symbol is in the title: `◆ Core Osc Buy · BTCUSD`. Distinct sound (Glass).

- **Pinned to the watchlist.** Core alerts only when the chart symbol is one of the
  16 in `expected-symbols.json`. Chart-hopping otherwise produces Core signals for
  instruments you have no interest in. Off-list fires are still logged and still
  recorded to CSV — only the alert is suppressed:
  `CORE fired on BATS:GOOGL — not in watchlist, alert suppressed`.
  If the watchlist is unreadable this **fails open** (alerts anyway) rather than
  going silently deaf.

`core-probe.csv` gained a `symbol` column; the pre-change data is preserved as
`core-probe.v1.csv`.

Test hook: `FLIP_FAKE_CORE=1` forces a live reading. Verified rising edge alerts,
repeat stays quiet, idle clears the flag, re-fire alerts again.

## Banner reliability

Two separate issues, found after a 7-symbol flip produced no visible banner.

**1. Banner failures were swallowed.** `notify()` discarded `osascript`'s return
value, so the log wrote `NOTIFIED:` regardless of whether the call succeeded. A
genuine failure (bad string, SIGKILL on timeout) does return an error even though a
*suppressed* banner does not. Now logged as `WARN banner call failed: …`.

**2. `dndDisplaySleep = True` on this Mac.** Do Not Disturb turns on automatically
whenever the display sleeps — which includes every lid close. Any alert fired while
the lid is shut has its banner suppressed by macOS and is **not** replayed on wake.
Given how often this machine runs lid-closed, banners cannot be the primary channel;
sound and speech are, and those only help if someone is in earshot.

**Durable record.** Every alert is now appended to `alerts.tsv`, so a missed or
suppressed banner never means a lost signal:

```bash
node flip-notifier.js --alerts     # replay the last 25 alerts
```

Note this does not explain the 12:59:10Z case — the lid had opened at 12:57:16Z,
114 s earlier, so the display was awake and DND-on-display-sleep did not apply.
That specific banner's fate is unresolved; `alerts.tsv` and the WARN line exist so
the next occurrence is diagnosable rather than a guess.
