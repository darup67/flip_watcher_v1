# Kalshi Watcher

Sibling to the Flip Watcher. Same alert channels, same hardening, different
asset class: CFTC-regulated event contracts instead of equities.

```
Kalshi public market-data API   (no key, no account needed for reading)
        │
        │  8 watched series · open markets only · multivariate parlays excluded
        ▼
kalshi-watcher.js      ← LaunchAgent com.dhruv.kalshiwatcher, every 300s
        │  filters to liquid markets, diffs YES mid against kalshi-state.json
        ▼
   alert:  banner  +  chime  +  speech  +  email  +  kalshi-alerts.tsv
```

The watcher **never trades**. It only reads public market data — trading would
need API-key auth, which this deliberately does not hold.

## Signals

| Signal | Fires when | Meaning |
|---|---|---|
| 🔄 **FLIP** | YES mid crosses 50¢ | The market's majority belief inverted |
| 📈 **MOVE** | YES mid jumps ≥ `move_cents` since last poll | Sharp repricing |
| 📊 **VOLUME** | 24h volume multiplies by ≥ `vol_spike_x` | Unusual activity |
| ⬆️ **LADDER** | 2+ of the above land on one event ticker | A whole strike curve repriced — see below |

One signal per market per poll, in that priority order — a market that flips
does not also report the move that carried it across. Thresholds are
**per-series**; football suppresses FLIP and VOLUME entirely (see below).

## Strike-ladder collapse

A series like `KXBTCD` is a **ladder**: 50+ contracts on one underlying at $100
increments. Move BTC $200 and every strike near the money reprices at once — so
one fact ("BTC is chopping around $79.7K") arrived as a dozen alerts, and the
same strike re-fired each time price oscillated back across it.

Measured over one afternoon before the fix:

- **124 individual signals** across 38 alert events
- **74%** of them Bitcoin
- one alert carried **11 markets** at once
- the `$79,700` strike alone fired **15 times**

Signals are now grouped by Kalshi's own **event ticker** — one underlying at one
expiry, which is exactly the set of strikes that reprice together. Two or more
signals on one event collapse into a single `LADDER` signal:

```
⬆️ Bitcoin price on Sep 11, 2026 — 6 strikes $79,500–$82,000, up to 20¢  🔥 STRONG
  KXBTCD · Bitcoin daily
  · band moved up to 20¢
  · liquid (72,135 24h vol)
  · 6 strikes repriced together
  folded:
    $79,500 or above  34¢→54¢
    $80,000 or above  27¢→47¢
    …
```

**Nothing is lost.** The member count, strike band and largest move survive into
the summary, every folded strike is listed underneath, and the per-market rows
are still in `kalshi-alerts.tsv`. The log reports the reduction:
`· 7 signals folded to 2`.

A ladder is scored on the *group*: magnitude from the largest member move,
liquidity from the **summed** volume, and breadth (`n` strikes) as the
correlation factor — a whole curve repricing is a stronger statement than one
strike twitching. Mixed-direction groups render `↕️` and flag "strikes
diverged", which is itself worth seeing.

Single-signal events pass through untouched, so a lone macro move is never
disguised as a ladder.

Verified: 6 near-money BTC strikes + 1 isolated recession move → `7 signals
folded to 2` (one LADDER, one standalone); a 3-up/3-down group renders mixed.

## BTC 15-minute volatility index

`KXBTC15M` — *"BTC price up in next 15 mins?"* — is the deepest 15-minute crypto
market on Kalshi: **~8,000 trades per window** against 2,400–4,800 for ETH, XRP
and SOL, and 68k in 24h volume against 1.4k–5.6k. That depth is what makes it
measurable — the book reprices in small increments instead of jumping between
prints.

**The index** is the mean intra-window **price range** (max − min of executed
trades) over the last **4 settled windows** (1 hour). Range beats standard
deviation here because it answers the question a trader actually has: how far
did this thing travel while I held it.

### The bands are measured, not guessed

Over 48 consecutive settled windows (12 h, 2026-09-06/07):

| | single window | smoothed over 4 |
|---|---|---|
| min | 2.4¢ | 7.2¢ |
| p25 | 17.1¢ | 29.1¢ |
| median | 34.4¢ | 39.7¢ |
| p75 | 49.4¢ | 50.2¢ |
| max | 98.3¢ | 65.5¢ |

Single windows are far too noisy to band (2.4¢ → 98.3¢ inside one hour), which
is why the index smooths. The cuts put roughly a fifth of observed hours in each
tail:

| Band | Range | Frequency |
|---|---|---|
| 🟢 **LOW** | < 28¢ | ~22% |
| **NORMAL** | 28–52¢ | ~62% |
| 🔴 **HIGH** | > 52¢ | ~16% |

### Alerting — every 30 minutes, not on change

The regime is reported **every 30 minutes**, whatever it is. Polls run every 5
minutes, so a report lands on the first poll past each half hour.

Cadence and measurement window are **separate knobs**: the index still averages a
full hour (4 x 15-min windows), it is just read out twice as often. That halves
worst-case latency to ~30 min without making the index itself twitchier — a
shorter measurement window would have done the opposite.

```
🟢 BTC 15m vol LOW — 21c  (was NORMAL)
⚪ BTC 15m vol NORMAL — 36c
🔴 BTC 15m vol HIGH — 58c  (was NORMAL)
```

The body carries the four window ranges it averaged, so a single wild window
skewing the mean is visible rather than hidden:

```
KXBTC15M index 36.3c over 4 windows: 7c 84c 7c 47c
bands: LOW <28c · NORMAL 28-52c · HIGH >52c
```

A band change since the last report is noted inline as `(was NORMAL)`, but it is
**not** what triggers the alert — a band that holds LOW all morning is still
worth being told about at 9, 10 and 11.

Residual latency: a LOW regime starting at 9:05 surfaces at 9:30 rather than
10:00. Going lower means edge-triggering, which is a different trade — see the
git history for that version.

**It has its own channels.** `volAlerts` in the watchlist is deliberately separate
from `alerts`, so the muted signal channels do not silence it:

```json
"alerts":    { "banner": false, "sound": false, "speak": false, "email": false },
"volAlerts": { "banner": true,  "sound": true,  "speak": true,  "email": true  }
```

## BTC-only mode

`"signals_paused": true` in the watchlist skips FLIP/MOVE/VOLUME detection
entirely — **only the Bitcoin volatility notifier fires**.

```json
"signals_paused": true,
"volAlerts": { "banner": true, "sound": true, "speak": true, "email": true }
```

The 13 series stay in the list and **state keeps updating**, so flipping this
back to `false` resumes from a current baseline instead of replaying a backlog
of stale moves as if they were live. Log line each poll:

```
BTC-only mode — 0 signal(s) suppressed, 159 markets tracked · BTC vol 36.25c NORMAL
```

This is deliberately a named flag rather than "mute every channel". Both silence
signals, but only one of them answers the question "why is Kalshi quiet?" three
weeks from now. The health check reads it directly:

```
✓ Kalshi watchlist  13 series · BTC-ONLY (signals paused, vol alerts live) · KXFED …
```

and only WARNs when *nothing* can fire — signals paused **and** vol alerts off.

### Cost

Per-window ranges are **cached by ticker** in `kalshi-state.json`. A poll only
fetches windows it has never seen, so steady state is one new window per 15
minutes — not a full recompute every 5. Trade paging goes through `apiGet`, so it
inherits the pacing, 429 backoff and retries; paging trades is exactly the
pattern that trips Kalshi's rate limiter.

The index runs **before** the no-signals early return, deliberately: a calm book
produces no signals, which is precisely the state the LOW alert exists to catch.
A failure here is logged and swallowed — it never breaks a poll.

Verified: the first poll reports and stamps the time; an immediate second poll
stays silent; backdating the stamp 61 minutes fires it again.

## Setup quality scoring

Same 0–5 scale as the Flip Watcher, so STRONG means the same thing in both:

| Factor | Points | What it measures |
|---|---|---|
| Magnitude | 0–2 | How far past the threshold — a 22¢ move beats an 11¢ one |
| Liquidity | 0–2 | 24h volume; a 20¢ move on a market nobody trades is noise |
| Correlation | 0–1 | Did sibling strikes in the same series move too |

🔥 **STRONG** (4–5) · ⚡ **MODERATE** (2–3) · 💤 **WEAK** (0–1)

The score appears in the email body, speech, log, and `kalshi-alerts.tsv`.

## Why the YES *mid*, not last price

`last_price` can be hours stale on a thin market, and a stale price
masquerading as a live one is exactly the false signal this watcher exists to
avoid. The mid of bid/ask is the honest read. Markets with an empty, one-sided,
or crossed book return no price at all and are skipped rather than guessed at.

## Watchlist

`kalshi-watchlist.json` — series tickers, pins, thresholds.

```json
{
  "series": [
    { "ticker": "KXFED", "label": "Fed funds rate" },
    { "ticker": "KXNFLGAME", "label": "NFL winner",
      "thresholds": { "min_volume_24h": 5000, "move_cents": 25,
                      "no_flip": true, "no_volume": true } }
  ],
  "pinned": ["KXBTCD-26SEP0612-T88799.99"],
  "thresholds": {
    "min_volume_24h": 500,     // ignore thinner markets unless pinned
    "move_cents": 10,          // MOVE threshold
    "vol_spike_x": 3.0,        // VOLUME multiple
    "vol_spike_floor": 1000,   // ...but only above this absolute volume
    "no_flip": false,          // suppress FLIP signals
    "no_volume": false         // suppress VOLUME signals
  }
}
```

### Alert channels

```json
"alerts": { "banner": true, "sound": true, "speak": true, "email": false }
```

Any channel can be muted independently. **`kalshi-alerts.tsv` is always
written** — muting changes where a signal goes, never whether it is recorded,
or a quiet period becomes a hole in the history you cannot reconstruct.

**Currently muted: `email`.** Kalshi signals reach banner, sound, speech, and
the TSV, but send no mail. Set `"email": true` to resume.

This is Kalshi-only. The TradingView flip notifier has its own independent
email path and is unaffected — worth knowing, because email is the one channel
that survives a closed lid, so a muted Kalshi watcher is effectively silent
when the lid is shut.

Muting is surfaced in three places so a silenced watcher is never mistaken for
a broken one: `--status`, every `ALERTED (email muted): …` log line, and the
health check's `Kalshi watchlist` row. Muting *every* channel is a WARN.

### Per-series thresholds

Top-level `thresholds` are defaults; **any series can override any of them**.

This is not a convenience — sports and macro genuinely cannot share one setting.
A 10¢ move is real news on a Fed contract that trades all day. On an NFL
moneyline during a live game it is just the third quarter happening. Likewise
crossing 50¢ means the market *inverted* on a macro contract, but a football
favourite crosses it routinely, so football sets `no_flip`.

| Group | Series | min vol | move | FLIP | VOLUME |
|---|---|---|---|---|---|
| Macro / crypto | `KXFED` `KXCPI` `KXBTCD` `KXETHD` `KXNASDAQ100` `KXINX` `KXRECSSNBER` `KXU3EOY` | 500 | 10¢ | ✅ | ✅ |
| Football | `KXNFLGAME` `KXNFLSPREAD` `KXNCAAFGAME` `KXNCAAFSPREAD` `KXNCAAFTOTAL` | 5,000 | 25¢ | ❌ | ❌ |

~200 markets survive the filters out of ~4,200 open. `KXBTCD` is the exchange's
#3 series by volume (~1.5M/24h); MLB and tennis are larger still but are
deliberately not watched.

Verified by fault injection: a 20¢ NFL move stays silent while a 12¢ macro move
alerts; an NFL market crossing 50¢ stays silent while a macro market crossing
50¢ fires a FLIP.

## Commands

```bash
cd ~/flip-notifier

node kalshi-watcher.js                  # poll once, alert on change
node kalshi-watcher.js --status         # what is tracked right now, no alerts
node kalshi-watcher.js --alerts         # replay the last 25 alerts
node kalshi-watcher.js --test           # fire a sample alert
node kalshi-watcher.js --reset          # clear state, re-baseline silently
node kalshi-watcher.js --discover FED   # find series tickers by keyword

node healthcheck.js                     # covers BOTH watchers
node healthcheck.js --repair            # ...and reloads either unloaded agent

launchctl list | grep kalshiwatcher
tail -30 kalshi-watcher.log
```

`--discover` paginates: on any game day the first thousand open markets are all
sports props, so a single page would never surface a macro series.

## Rate limiting

Kalshi rate-limits the public API, and pagination is exactly the pattern that
trips it. Requests are paced 120 ms apart, and a 429 or 5xx backs off
exponentially (1s → 8s, honouring `Retry-After` when sent) for up to 4 retries.
A single failing series is logged as a partial read; the poll still completes on
the rest.

## Health check

`healthcheck.js` covers both watchers. The Kalshi group is **optional** — if
`com.dhruv.kalshiwatcher.plist` is absent the whole group reports one INFO line
and is skipped, so a machine that only runs the flip watcher never sees a red
line for something it deliberately does not have.

| Check | FAILs when |
|---|---|
| Kalshi agent | LaunchAgent not loaded (`--repair` reloads it) |
| Kalshi API | public market data unreachable (429 is a WARN — the watcher retries) |
| Kalshi watchlist | file missing, unreadable, or no series configured |
| Kalshi state | lock wedged >5 min, state unreadable, or last good read >15 min ago |
| Kalshi log | 3+ consecutive failures with no success since |

When `--notify` fires, the banner names the watcher that actually broke —
"✗ Kalshi Watcher BROKEN" vs "✗ Flip Watcher BROKEN", or "Asset Watchers" when
both are unhappy. A generic title sends you to the wrong stack.

All five paths verified by fault injection: unreachable API, wedged lock,
unloaded agent (and its `--repair`), empty watchlist, and absent plist.

## Failure modes

| If this breaks | Symptom | Caught by |
|---|---|---|
| Kalshi API down | no markets read | blind alert after 3 polls (~15 min); daily check |
| One series 404s | that series missing | `WARN partial read`, poll continues on the rest |
| Rate limited | 429 | paced + exponential backoff, 4 retries |
| Watchlist corrupt | no series to poll | refuses, alerts, leaves the file alone |
| `kalshi-state.json` corrupt | baseline lost | **alerted**, then rebuilt — never silent |
| Machine asleep >30 min | prices moved unseen | stale-wake: re-baselines, reports as a gap, **not** as live signals |
| Overlapping polls | racing state writes | PID lockfile (`.kalshi.lock`), second poll skips |
| Killed mid-write | truncated JSON | temp-file + `rename()` (atomic) |
| SIGTERM from launchd | orphaned lock | handler releases it immediately |

## Known gaps

- **Weekend quiet.** Macro series (Fed, CPI, unemployment) barely trade on
  weekends. Volume-based scoring will read low until Monday; that is accurate,
  not broken.
- **Duplicate-looking strikes.** Two `KXBTCD` markets can both display
  "$79,500 or above" at different expiry times. The ticker disambiguates them
  in state, but the alert text can look repetitive.
- **Same audio gap as the Flip Watcher.** A muted Mac produces a
  successful-looking silent alert. Email is the channel that survives.
