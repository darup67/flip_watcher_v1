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
| 📈 **MOVE** | YES mid jumps ≥ `move_cents` (10¢) since last poll | Sharp repricing |
| 📊 **VOLUME** | 24h volume multiplies by ≥ `vol_spike_x` (3.0×) | Unusual activity |

One signal per market per poll, in that priority order — a market that flips
does not also report the move that carried it across.

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
  "series": [{ "ticker": "KXFED", "label": "Fed funds rate" }],
  "pinned": ["KXBTCD-26SEP0612-T88799.99"],
  "thresholds": {
    "min_volume_24h": 500,     // ignore thinner markets unless pinned
    "move_cents": 10,          // MOVE threshold
    "vol_spike_x": 3.0,        // VOLUME multiple
    "vol_spike_floor": 1000    // ...but only above this absolute volume
  }
}
```

Currently watched: `KXFED` `KXCPI` `KXBTCD` `KXETHD` `KXNASDAQ100` `KXINX`
`KXRECSSNBER` `KXU3EOY` — ~86 markets survive the liquidity filter.

`KXBTCD` alone is the exchange's #3 series by volume (~1.4M/24h).

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
