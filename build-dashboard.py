#!/usr/bin/env python3
"""
Build the Asset Agents dashboard — a point-in-time snapshot of the four pinned
Claude Code sessions, published as an Artifact so it is readable from a phone.

Local watcher state (flip, Kalshi, Zillow) is read live from disk. Robinhood
figures arrive via RH_DATA because they come from an MCP connector a script
cannot call; refresh those by re-running with a new blob.
"""
import json, os, datetime, html, subprocess

HOME = os.path.expanduser("~")
FN   = os.path.join(HOME, "flip-notifier")
ZA   = os.path.join(HOME, "zillow-agent")
OUT  = "/tmp/claude-501/-Users-dhruvpatel/055dec91-ccbf-4692-a13d-b5fbbfb021ef/scratchpad/asset-agents.html"

now = datetime.datetime.now().astimezone()

def jload(p, d=None):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return d if d is not None else {}

def age(iso):
    if not iso: return "unknown"
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except Exception: return "unknown"
    s = (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()
    if s < 90:   return f"{int(s)}s ago"
    if s < 5400: return f"{int(s//60)}m ago"
    if s < 172800: return f"{s/3600:.1f}h ago"
    return f"{int(s//86400)}d ago"

def count(path, needle):
    try:
        with open(path, errors="ignore") as f:
            return sum(1 for l in f if needle in l)
    except Exception: return 0

# ---------- 1. Flip watcher ----------
fs   = jload(os.path.join(FN, "state.json"))
reg  = fs.get("regimes", {})
buys  = sorted(k.split(":")[-1] for k, v in reg.items() if v == "BUY")
sells = sorted(k.split(":")[-1] for k, v in reg.items() if v != "BUY")

# ---------- 2. Kalshi ----------
ks  = jload(os.path.join(FN, "kalshi-state.json"))
kw  = jload(os.path.join(FN, "kalshi-watchlist.json"))
kal = kw.get("alerts", {})
muted = [k for k, v in kal.items() if not v]
kseries = kw.get("series", [])

# ---------- 3. Zillow ----------
zs  = jload(os.path.join(ZA, "state.json"))
zc  = jload(os.path.join(ZA, "config.json"))
# config.markets is a list of {name, zips}
zmk = zc.get("markets", [])
if isinstance(zmk, dict):
    zmk = [{"name": k, "zips": (v.get("zips", []) if isinstance(v, dict) else v)}
           for k, v in zmk.items()]
zmk = [m for m in zmk if isinstance(m, dict)]
zzips = sum(len(m.get("zips", [])) for m in zmk)

# ---------- 4. launchd ----------
try:
    ll = subprocess.run(["/bin/launchctl", "list"], capture_output=True, text=True, timeout=10).stdout
except Exception:
    ll = ""
def agent(name):
    for line in ll.splitlines():
        if name in line:
            p = line.split()
            return {"loaded": True, "running": p[0] != "-", "exit": p[1]}
    return {"loaded": False, "running": False, "exit": "-"}

ag_flip   = agent("com.dhruv.flipnotifier")
ag_awake  = agent("com.dhruv.flipnotifier.awake")
ag_kalshi = agent("com.dhruv.kalshiwatcher")
ag_zillow = agent("com.dhruv.zillowagent")

# ---------- 5. Robinhood (from connector) ----------
RH = json.loads(os.environ["RH_DATA"])
pos = []
for p in RH["positions"]:
    q, av, last = p["q"], p["avg"], p["last"]
    val, cost = q * last, q * av
    pos.append({**p, "val": val, "cost": cost, "pl": val - cost,
                "plpct": (val - cost) / cost * 100 if cost else 0,
                "day": (last - p["prev"]) / p["prev"] * 100 if p["prev"] else 0})
pos.sort(key=lambda x: -x["pl"])
tot_val  = sum(p["val"] for p in pos)
tot_cost = sum(p["cost"] for p in pos)
tot_pl   = tot_val - tot_cost

def money(v, dec=0):
    return f"${v:,.{dec}f}"
def signed(v, dec=0):
    return f"{'+' if v >= 0 else '−'}${abs(v):,.{dec}f}"
def pct(v):
    return f"{'+' if v >= 0 else '−'}{abs(v):.1f}%"
e = html.escape

# ---------- cards ----------
def chip(txt, kind):
    return f'<span class="chip {kind}">{e(txt)}</span>'

flip_ok   = ag_flip["loaded"] and fs.get("failures", 0) == 0
kalshi_ok = ag_kalshi["loaded"] and ks.get("failures", 0) == 0
zill_ok   = ag_zillow["loaded"]

rows_buy  = "".join(f'<li class="tk pos">{e(s)}</li>' for s in buys)
rows_sell = "".join(f'<li class="tk neg">{e(s)}</li>' for s in sells)

kser = "".join(f'<li class="tk">{e(s["ticker"])}</li>' for s in kseries)

posrows = "".join(
    f'<tr><td class="sym">{e(p["sym"])}</td>'
    f'<td class="num">{p["q"]:,.2f}</td>'
    f'<td class="num">{money(p["val"])}</td>'
    f'<td class="num {"pos" if p["pl"]>=0 else "neg"}">{signed(p["pl"])}</td>'
    f'<td class="num {"pos" if p["pl"]>=0 else "neg"}">{pct(p["plpct"])}</td></tr>'
    for p in pos)

STAMP = now.strftime("%a %-d %b %Y · %-I:%M %p %Z")

HTML = f"""<title>Asset Agents Console</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Source+Sans+3:wght@400;600&family=JetBrains+Mono:wght@400;500;700&display=swap">
<style>
:root {{
  --ink:#0f1419; --paper:#f6f7f9; --surface:#ffffff; --sunk:#eceef2;
  --line:#d9dde4; --line-soft:#e6e9ee;
  --text:#161b22; --muted:#5b6673; --faint:#8b95a3;
  --accent:#2f6f80; --accent-soft:#e2eef1;
  --pos:#1f7a4d; --pos-soft:#e2f2e9;
  --neg:#b23c33; --neg-soft:#fae8e6;
  --warn:#9a6b1a; --warn-soft:#f9eeda;
  --radius:10px;
  --shadow:0 1px 2px rgba(15,20,25,.06), 0 4px 14px rgba(15,20,25,.05);
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --paper:#0f1419; --surface:#161c24; --sunk:#1b222c;
    --line:#2a323d; --line-soft:#222a34;
    --text:#e6eaef; --muted:#9aa5b3; --faint:#6c7684;
    --accent:#63b3c7; --accent-soft:#17313a;
    --pos:#5ec98d; --pos-soft:#14301f;
    --neg:#e8827a; --neg-soft:#331917;
    --warn:#d8a851; --warn-soft:#2e2312;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 4px 16px rgba(0,0,0,.3);
  }}
}}
:root[data-theme="dark"] {{
  --paper:#0f1419; --surface:#161c24; --sunk:#1b222c;
  --line:#2a323d; --line-soft:#222a34;
  --text:#e6eaef; --muted:#9aa5b3; --faint:#6c7684;
  --accent:#63b3c7; --accent-soft:#17313a;
  --pos:#5ec98d; --pos-soft:#14301f;
  --neg:#e8827a; --neg-soft:#331917;
  --warn:#d8a851; --warn-soft:#2e2312;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 4px 16px rgba(0,0,0,.3);
}}
* {{ box-sizing:border-box; }}
body {{
  margin:0; background:var(--paper); color:var(--text);
  font-family:"Source Sans 3",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased;
}}
.wrap {{ max-width:960px; margin:0 auto; padding:22px 18px 56px; }}

/* masthead */
.mast {{ display:flex; flex-wrap:wrap; align-items:baseline; gap:10px 14px; margin-bottom:6px; }}
h1 {{ font-family:Archivo,sans-serif; font-weight:700; font-size:clamp(22px,4.6vw,30px);
     letter-spacing:-.02em; margin:0; text-wrap:balance; }}
.stamp {{ font-family:"JetBrains Mono",monospace; font-size:11.5px; color:var(--faint);
         letter-spacing:.01em; }}
.lede {{ color:var(--muted); margin:0 0 18px; max-width:62ch; font-size:14.5px; }}

/* status strip */
.strip {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr)); gap:8px;
         margin-bottom:22px; }}
.st {{ background:var(--surface); border:1px solid var(--line); border-radius:var(--radius);
      padding:11px 12px; display:flex; flex-direction:column; gap:3px; }}
.st .k {{ font-size:10.5px; text-transform:uppercase; letter-spacing:.09em; color:var(--faint);
         font-weight:600; }}
.st .v {{ font-family:"JetBrains Mono",monospace; font-weight:700; font-size:17px;
         font-variant-numeric:tabular-nums; letter-spacing:-.01em; }}
.st .sub {{ font-size:11.5px; color:var(--muted); }}

/* cards */
.card {{ background:var(--surface); border:1px solid var(--line); border-radius:var(--radius);
        box-shadow:var(--shadow); margin-bottom:16px; overflow:hidden; }}
.card > .stripe {{ height:3px; background:var(--accent); }}
.stripe.ok {{ background:var(--pos); }}
.stripe.warn {{ background:var(--warn); }}
.stripe.bad {{ background:var(--neg); }}
.head {{ display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px;
        padding:14px 16px 12px; border-bottom:1px solid var(--line-soft); }}
.head h2 {{ font-family:Archivo,sans-serif; font-size:16.5px; font-weight:600; margin:0;
           letter-spacing:-.01em; }}
.head .sid {{ font-family:"JetBrains Mono",monospace; font-size:11px; color:var(--faint);
             margin-left:auto; }}
.body {{ padding:14px 16px 16px; display:flex; flex-direction:column; gap:14px; }}

.chip {{ display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:600;
        padding:2.5px 8px; border-radius:999px; letter-spacing:.02em;
        background:var(--sunk); color:var(--muted); white-space:nowrap; }}
.chip.ok   {{ background:var(--pos-soft);  color:var(--pos); }}
.chip.warn {{ background:var(--warn-soft); color:var(--warn); }}
.chip.bad  {{ background:var(--neg-soft);  color:var(--neg); }}
.chip.acc  {{ background:var(--accent-soft); color:var(--accent); }}

.kv {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(122px,1fr)); gap:10px; }}
.kv > div {{ display:flex; flex-direction:column; gap:1px; }}
.kv .k {{ font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint);
         font-weight:600; }}
.kv .v {{ font-family:"JetBrains Mono",monospace; font-weight:500; font-size:14.5px;
         font-variant-numeric:tabular-nums; }}

.split {{ display:flex; height:7px; border-radius:4px; overflow:hidden; background:var(--sunk); }}
.split i {{ display:block; flex:none; }}
.split .b {{ background:var(--pos); }}
.split .s {{ background:var(--neg); }}

ul.tks {{ list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:4px; }}
.tk {{ font-family:"JetBrains Mono",monospace; font-size:11.5px; padding:2px 6px;
      border-radius:4px; background:var(--sunk); color:var(--muted); }}
.tk.pos {{ background:var(--pos-soft); color:var(--pos); }}
.tk.neg {{ background:var(--neg-soft); color:var(--neg); }}

.lbl {{ font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint);
       font-weight:600; margin-bottom:5px; }}

.note {{ display:flex; gap:9px; padding:10px 12px; border-radius:8px; font-size:13.5px;
        background:var(--warn-soft); color:var(--text); border-left:3px solid var(--warn); }}
.note.bad {{ background:var(--neg-soft); border-left-color:var(--neg); }}
.note b {{ font-weight:600; }}

.tblwrap {{ overflow-x:auto; margin:0 -2px; }}
table {{ width:100%; border-collapse:collapse; font-size:13px; }}
th {{ text-align:right; font-size:10px; text-transform:uppercase; letter-spacing:.08em;
     color:var(--faint); font-weight:600; padding:0 0 6px; border-bottom:1px solid var(--line-soft); }}
th:first-child {{ text-align:left; }}
td {{ padding:5px 0; border-bottom:1px solid var(--line-soft); }}
td.sym {{ font-family:"JetBrains Mono",monospace; font-weight:700; font-size:12.5px; }}
td.num {{ text-align:right; font-family:"JetBrains Mono",monospace;
         font-variant-numeric:tabular-nums; padding-left:14px; }}
tr:last-child td {{ border-bottom:0; }}
tfoot td {{ border-top:2px solid var(--line); border-bottom:0; padding-top:8px; font-weight:700; }}
.pos {{ color:var(--pos); }} .neg {{ color:var(--neg); }}

footer {{ margin-top:26px; padding-top:14px; border-top:1px solid var(--line);
         color:var(--faint); font-size:12.5px; }}
footer code {{ font-family:"JetBrains Mono",monospace; font-size:11.5px;
              background:var(--sunk); padding:1px 5px; border-radius:4px; color:var(--muted); }}
@media (prefers-reduced-motion:reduce) {{ * {{ animation:none!important; transition:none!important; }} }}
</style>

<div class="wrap">

  <div class="mast">
    <h1>Asset Agents</h1>
    <span class="stamp">SNAPSHOT · {e(STAMP)}</span>
  </div>
  <p class="lede">The four pinned Claude Code sessions on this Mac. Figures are read
  from local state at build time — this page does not poll, so treat the stamp above
  as the age of everything below.</p>

  <div class="strip">
    <div class="st"><span class="k">Flip Watcher</span>
      <span class="v">{len(reg)}</span>
      <span class="sub">{len(buys)} buy · {len(sells)} sell</span></div>
    <div class="st"><span class="k">Kalshi</span>
      <span class="v">{len(ks.get("markets",{}))}</span>
      <span class="sub">{len(kseries)} series tracked</span></div>
    <div class="st"><span class="k">Zillow</span>
      <span class="v">{len(zs.get("listings",{})):,}</span>
      <span class="sub">{zzips} zips · {len(zmk)} markets</span></div>
    <div class="st"><span class="k">Portfolio</span>
      <span class="v">{money(RH["total"])}</span>
      <span class="sub">main account</span></div>
  </div>

  <!-- 1 ─ Flip Watcher v1 -->
  <div class="card">
    <div class="stripe {'ok' if flip_ok and kalshi_ok else 'warn'}"></div>
    <div class="head">
      <h2>Flip Watcher v1</h2>
      {chip('healthy' if flip_ok else 'check', 'ok' if flip_ok else 'bad')}
      {chip('kalshi silent', 'warn') if len(muted) == 4 else chip('kalshi alerting', 'ok')}
      <span class="sid">this session</span>
    </div>
    <div class="body">
      <div class="kv">
        <div><span class="k">Symbols</span><span class="v">{len(reg)}</span></div>
        <div><span class="k">Last poll</span><span class="v">{e(age(fs.get("updated")))}</span></div>
        <div><span class="k">Flips 24h</span><span class="v">{count(os.path.join(FN,'flip-notifier.log'),'NOTIFIED')}</span></div>
        <div><span class="k">Kalshi 24h</span><span class="v">{count(os.path.join(FN,'kalshi-watcher.log'),'ALERTED')}</span></div>
      </div>

      <div>
        <div class="lbl">Regime · {len(buys)} buy / {len(sells)} sell</div>
        <div class="split">
          <i class="b" style="width:{len(buys)/max(len(reg),1)*100:.1f}%"></i>
          <i class="s" style="width:{len(sells)/max(len(reg),1)*100:.1f}%"></i>
        </div>
      </div>
      <div><div class="lbl">Buy</div><ul class="tks">{rows_buy}</ul></div>
      <div><div class="lbl">Sell</div><ul class="tks">{rows_sell}</ul></div>

      <div class="note">
        <span>⚠</span><span><b>Every Kalshi alert channel is muted</b> — banner, sound,
        speech and email. Signals still accumulate in <code>kalshi-alerts.tsv</code>
        ({count(os.path.join(FN,'kalshi-watcher.log'),'ALERTED')} in 24h) but nothing announces them.
        The health check reports DEGRADED for this by design.</span>
      </div>

      <div><div class="lbl">Kalshi series</div><ul class="tks">{kser}</ul></div>
    </div>
  </div>

  <!-- 2 ─ RH -->
  <div class="card">
    <div class="stripe {'ok' if tot_pl >= 0 else 'bad'}"></div>
    <div class="head">
      <h2>RH</h2>
      {chip('market closed', 'warn')}
      {chip('confirm-first', 'acc')}
      <span class="sid">robinhood</span>
    </div>
    <div class="body">
      <div class="kv">
        <div><span class="k">Account value</span><span class="v">{money(RH["total"])}</span></div>
        <div><span class="k">Equities</span><span class="v">{money(RH["equity"])}</span></div>
        <div><span class="k">Crypto</span><span class="v">{money(RH["crypto"])}</span></div>
        <div><span class="k">Cash</span><span class="v">{money(RH["cash"])}</span></div>
        <div><span class="k">Open P&amp;L</span>
          <span class="v {'pos' if tot_pl>=0 else 'neg'}">{signed(tot_pl)}</span></div>
        <div><span class="k">Futures</span>
          <span class="v {'pos' if RH['futures']>=0 else 'neg'}">{signed(RH['futures'])}</span></div>
      </div>

      <div class="note bad">
        <span>●</span><span>The <b>Agentic account (••4526)</b> — the only one this
        connector can trade — is at <b>$0</b>. Notes still describe it as ~$7k, so the
        <code>3x-etf-daily-directional</code> strategy has no capital to deploy.</span>
      </div>

      <div>
        <div class="lbl">Positions · {len(pos)} held, Friday close</div>
        <div class="tblwrap">
          <table>
            <thead><tr><th>Symbol</th><th>Qty</th><th>Value</th><th>P&amp;L</th><th>%</th></tr></thead>
            <tbody>{posrows}</tbody>
            <tfoot><tr>
              <td class="sym">TOTAL</td><td class="num"></td>
              <td class="num">{money(tot_val)}</td>
              <td class="num {'pos' if tot_pl>=0 else 'neg'}">{signed(tot_pl)}</td>
              <td class="num {'pos' if tot_pl>=0 else 'neg'}">{pct(tot_pl/tot_cost*100 if tot_cost else 0)}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- 3 ─ Zillow -->
  <div class="card">
    <div class="stripe {'ok' if zill_ok else 'bad'}"></div>
    <div class="head">
      <h2>Zillow market scanner</h2>
      {chip('loaded' if zill_ok else 'not loaded', 'ok' if zill_ok else 'bad')}
      {chip('daily 7:30 am', 'acc')}
      <span class="sid">~/zillow-agent</span>
    </div>
    <div class="body">
      <div class="kv">
        <div><span class="k">Listings</span><span class="v">{len(zs.get("listings",{})):,}</span></div>
        <div><span class="k">ZIPs</span><span class="v">{zzips}</span></div>
        <div><span class="k">Markets</span><span class="v">{len(zmk)}</span></div>
        <div><span class="k">Last digest</span><span class="v">{e(age(zs.get("lastRun")))}</span></div>
      </div>
      <div><div class="lbl">Markets</div>
        <ul class="tks">{''.join(f'<li class="tk">{e(m.get("name","?"))}</li>' for m in zmk)}</ul></div>
      <div class="note">
        <span>ℹ</span><span>Zillow's own endpoint returns a <b>PerimeterX captcha</b> and is
        not usable from this machine. Listings come from Redfin's <code>gis-csv</code> via
        bounding-box polygons, filtered to ZIP client-side — that path caps at 350 rows,
        so an adaptive quadtree splits dense boxes to recover the oldest listings.</span>
      </div>
    </div>
  </div>

  <!-- 4 ─ TradingView -->
  <div class="card">
    <div class="stripe ok"></div>
    <div class="head">
      <h2>TradingView</h2>
      {chip('cdp 9222', 'acc')}
      {chip('84 tools', 'acc')}
      <span class="sid">tradesdontlie/tradingview-mcp</span>
    </div>
    <div class="body">
      <div class="kv">
        <div><span class="k">Scanner study</span><span class="v">ejkCnS</span></div>
        <div><span class="k">Timeframe</span><span class="v">30m pinned</span></div>
        <div><span class="k">MCP commit</span><span class="v">c05b8f5</span></div>
        <div><span class="k">Sleep guard</span>
          <span class="v">{'held' if ag_awake['running'] else 'OFF'}</span></div>
      </div>
      <div class="note">
        <span>ℹ</span><span>The notifier reads the chart over CDP directly — it does not use
        the MCP server, but it <b>does</b> borrow that install's <code>ws</code> package.
        Moving or clearing <code>~/tradingview-mcp/node_modules</code> stops the watcher.</span>
      </div>
      <div>
        <div class="lbl">Delayed feeds · CME add-on not held</div>
        <ul class="tks">{''.join(f'<li class="tk warn">{e(s)}</li>' for s in ["MNQ1!","MES1!","MYM1!","MGC1!","MCL1!"])}</ul>
      </div>
    </div>
  </div>

  <footer>
    Built from local state by <code>build-dashboard.py</code>. Robinhood figures come from
    the connector and are Friday's close — the market is shut. Re-run the script to refresh
    the watcher panels; the RH panel needs a new connector pull.
  </footer>
</div>
"""

SAFE = HTML.encode("ascii", "xmlcharrefreplace").decode("ascii")
with open(OUT, "w", encoding="utf-8") as f:
    f.write(SAFE)
print(f"wrote {OUT} ({len(SAFE):,} bytes)")
print(f"  flip {len(reg)} symbols | kalshi {len(ks.get('markets',{}))} | zillow {len(zs.get('listings',{})):,}")
print(f"  RH {money(tot_val)} value, {signed(tot_pl)} open P&L across {len(pos)} positions")
