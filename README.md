# Flip Watcher App (Kalshi + TradingView) 📈📉🤑

Flip Watcher App — v1 — Buy/Sell Signals

Local macOS desktop notifications for the TradingView **Watchlist Flip Scanner**.

Independent of TradingView's alert system. It reads the study's on-chart table
directly out of the running TradingView Desktop app over CDP (port 9222), diffs
each symbol's BUY/SELL regime against the previous poll, and fires a macOS
notification when any symbol flips.

No TradingView alert slot is consumed, and no plan tier is required.

## Commands

```bash
cd ~/flip-notifier

node flip-notifier.js            # poll once, notify on change
node flip-notifier.js --status   # print current regimes, notify nothing
node flip-notifier.js --test     # fire a sample notification
node flip-notifier.js --reset    # clear state; next run re-baselines silently
```

## Scheduling

A LaunchAgent polls every 60 seconds:

```
~/Library/LaunchAgents/com.dhruv.flipnotifier.plist
```

```bash
launchctl list | grep flipnotifier                                  # is it running
launchctl unload ~/Library/LaunchAgents/com.dhruv.flipnotifier.plist  # stop
launchctl load   ~/Library/LaunchAgents/com.dhruv.flipnotifier.plist  # start
```

To remove it entirely: unload, then delete the plist and this directory.

## Files

| File | Purpose |
|---|---|
| `flip-notifier.js` | The notifier |
| `state.json` | Last-seen regime per symbol — the flip baseline |
| `flip-notifier.log` | Run log, self-truncating at 512 KB |
| `launchd.out.log` / `launchd.err.log` | LaunchAgent stdout/stderr |

## Alert format

The flip text lives in the notification **title**, not the body — see below.

```
⬇️ SQQQ → SELL · ⬆️ TQQQ → BUY
```

⬆️ = flipped to BUY, ⬇️ = flipped to SELL. Beyond two flips the title shows the
first two plus `+N`. The body repeats the detail with the prior regime
(`SQQQ BUY → SELL`) for anyone who has previews enabled. Spoken form reads
"SQQQ flipped to sell, TQQQ flipped to buy". The log keeps plain ASCII
(`SQQQ BUY->SELL`) so it stays greppable.

## Why the text is in the title

This Mac has notification previews turned off system-wide:

```
com.apple.ncprefs  content_visibility = 2   →  "Show previews: Never"
```

With that set, macOS renders the notification **title only** and hides the body
for *every* app — TradingView's own alert toasts included. It is not a per-app
permission, not an escaping bug, and not something the notifier can override, so
the alert content goes in the title where it will actually be seen.

To get bodies back: System Settings → Notifications → **Show previews: Always**.
If you turn that on, the body becomes visible and the format still reads correctly.

Alert channels:

| Channel | Status |
|---|---|
| Banner title | ✓ working |
| Banner body | ✗ hidden by `content_visibility = 2` |
| Sound (`afplay`) | ✓ working, needs no permission |
| Speech (`say`) | ✓ working, needs no permission |

Speech is off by default since 2026-09-28 (banners only); `FLIP_SPEAK=1` turns it back on.

## Behaviour notes

- **First run is silent.** It saves a baseline rather than firing 16 notifications.
  Same intent as the Pine script's `alertFirst = false`.
- **Silent on failure, not falsely reassuring.** If TradingView is closed, the
  chart tab is gone, or the study is removed, it logs a warning and exits
  non-zero without notifying. No notification means "no flip *or* not running" —
  check the log to tell them apart.
- **Polling is not bar-close aligned.** The Pine study only updates its table on
  the 30-minute close, so a flip surfaces within ~60s of that close. Polling
  faster gains nothing.
- **Five symbols are on delayed feeds.** MNQ, MES, MYM, MGC and MCL resolve to
  `_DL` (CME Group, 10-minute delay), so flips on those are inherently late —
  a data-subscription limit, not a notifier limit.
- **Depends on the study staying on a chart.** It reads whatever chart tab the
  desktop app has open at `/chart/`. If the study is removed from that chart,
  the notifier goes quiet.

## Dependencies

- Node (uses `/Users/dhruvpatel/.local/bin/node`)
- `ws`, borrowed from the existing `~/tradingview-mcp/node_modules`
- TradingView Desktop running with `--remote-debugging-port=9222` (its default)
