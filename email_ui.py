"""Python side of the shared email layout (see email-ui.js for the spec). One template, one place to change it.

    import sys; sys.path.insert(0, "/Users/dhruvpatel/flip-notifier"); import email_ui
    email_ui.send("[Product] Exact title", spec)          # True on success
    html, text = email_ui.render(spec)
"""
import json, os, subprocess

NODE = os.path.expanduser("~/.local/bin/node")
JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "email-ui.js")


def render(spec):
    r = subprocess.run([NODE, JS, "render"], input=json.dumps(spec), capture_output=True, text=True, timeout=30)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[-300:])
    d = json.loads(r.stdout)
    return d["html"], d["text"]


def send(subject, spec, timeout=60):
    r = subprocess.run([NODE, JS, "send", subject], input=json.dumps(spec), capture_output=True, text=True, timeout=timeout)
    return r.returncode == 0


def from_text(kind, title, subtitle, lines, status=None, footer=None):
    """Spec from a plain-text report, for products that build their text line by line. Rules:
    an ALL-CAPS line (optionally followed by "(note)") starts a section; indented lines with two or more spaces between a label
    and its value become a two-column table; other indented lines become a list; loose lines before the first section become
    a callout (green when they start with OK/Recorder OK, red when they start with NEEDS ATTENTION)."""
    import re
    heading = re.compile(r"^([A-Z][A-Z0-9 /&\-]{2,})(\s+\((.*)\))?\s*$")
    secs, cur, intro, foot = [], None, [], []

    def flush_rows():
        nonlocal cur
        if cur and cur.get("_rows"):
            cur["blocks"].append({"type": "table", "noHeader": True, "columns": [{"key": "k", "label": ""}, {"key": "v", "label": ""}],
                                  "rows": [{"k": {"v": k, "bold": True}, "v": v} for k, v in cur.pop("_rows")]})
        if cur:
            cur.pop("_rows", None)

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue
        m = heading.match(line.strip())
        if m and not line.startswith(" "):
            flush_rows()
            cur = {"title": m.group(1).title() + (f" ({m.group(3)})" if m.group(3) else ""), "blocks": [], "_rows": []}
            secs.append(cur)
            continue
        indented = line.startswith("  ")
        if cur is None:
            intro.append(line.strip()); continue
        if indented:
            parts = re.split(r"\s{2,}", line.strip(), maxsplit=1)
            if len(parts) == 2:
                cur["_rows"].append((parts[0], parts[1]))
            else:
                flush_rows(); cur["_rows"] = []
                cur["blocks"].append({"type": "list", "items": [line.strip()]})
        else:
            flush_rows(); cur["_rows"] = []
            cur["blocks"].append({"type": "para", "text": line.strip()})
    flush_rows()
    for s in secs:
        s.pop("_rows", None)
        # merge consecutive one-item lists
        merged = []
        for b in s["blocks"]:
            if merged and b["type"] == "list" and merged[-1]["type"] == "list":
                merged[-1]["items"] += b["items"]
            else:
                merged.append(b)
        s["blocks"] = merged
    top = []
    if intro:
        text = " ".join(intro)
        tone = "bad" if text.startswith("NEEDS ATTENTION") else "good" if text.startswith(("Recorder OK", "OK")) else "info"
        top.append({"blocks": [{"type": "callout", "tone": tone, "text": text}]})
    return {"kind": kind, "title": title, "subtitle": subtitle, "status": status, "sections": top + secs, "footer": footer}
