#!/usr/bin/env node
'use strict';
// Shared email layout for every automated email in the trading ecosystem (2026-09-30).
//
//   const ui = require('~/flip-notifier/email-ui.js');
//   const { html, text } = ui.render(spec);      // spec below
//   ui.send(subject, spec);                      // renders and sends multipart (HTML + plain-text alternative) through send-email.js
//
// Python products use ~/flip-notifier/email_ui.py, which calls this file (one template, one place to change it):
//   echo '<spec json>' | node email-ui.js render     -> {"html","text"}
//   echo '<spec json>' | node email-ui.js send "subject"
//
// spec = {
//   kind:     'SIGNAL ALERT' | 'BRIEF' | 'DIGEST' | 'REPORT' | 'SYSTEM ALERT' | ...   small label above the title
//   title:    what this email IS, exactly ("Trend Flip: NVDA turned BUY")
//   subtitle: when / scope ("Signal confirmed on the 15-minute bar closing 10:45 AM ET")
//   status:   { text, tone }                 optional chip beside the kind (tone: good | bad | warn | info | neutral)
//   sections: [{ title, note, blocks: [...] }]      title/note optional
//   footer:   'Sent by ...'                  optional extra line
// }
// blocks:
//   { type: 'kpis',  items: [{ label, value, tone, sub }] }
//   { type: 'table', noHeader: true|false, columns: [{ key, label, align }], rows: [{ key: value | { v, tone, bold, href } }], empty: 'text if no rows' }
//   { type: 'cards', items: [{ title, badge: { text, tone }, sub, fields: [[label, value]], lines: [text], links: [{ label, href }] }] }
//   { type: 'chips', items: [{ text, tone }] }                  compact colored tags
//   { type: 'chipRows', items: [{ label, sub, chips: [{ text, tone, note, ring }] }] }   labelled rows of tags (BUY/SELL grid by group)
//   { type: 'code', text }   monospace log excerpt
//   { type: 'list',  items: [text] }   { type: 'para', text }   { type: 'callout', tone, text }   { type: 'raw', html, text }
// All strings are HTML-escaped except inside 'raw'.

const path = require('path');
const fs = require('fs');
const os = require('os');

const TONE = {
  good: { fg: '#047857', bg: '#d1fae5', solid: '#059669' },
  bad: { fg: '#b91c1c', bg: '#fee2e2', solid: '#dc2626' },
  warn: { fg: '#92400e', bg: '#fef3c7', solid: '#d97706' },
  info: { fg: '#1d4ed8', bg: '#dbeafe', solid: '#2563eb' },
  neutral: { fg: '#374151', bg: '#e5e7eb', solid: '#6b7280' },
};
const tone = (t) => TONE[t] || TONE.neutral;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cellObj = (c) => (c && typeof c === 'object' && !Array.isArray(c) ? c : { v: c });

function pill(text, t, solid) {
  const c = tone(t);
  return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font:600 11px ${FONT};letter-spacing:.3px;background:${solid ? c.solid : c.bg};color:${solid ? '#ffffff' : c.fg};white-space:nowrap">${esc(text)}</span>`;
}

function linkList(links) {
  return (links || []).map((l) => `<a href="${esc(l.href)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">${esc(l.label)}</a>`).join('<span style="color:#9ca3af"> &nbsp;·&nbsp; </span>');
}

function block(b) {
  switch (b.type) {
    case 'kpis': {
      const n = b.items.length;
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:6px 0;margin:0 -6px"><tr>` + b.items.map((k) => {
        const c = k.tone ? tone(k.tone) : null;
        return `<td width="${Math.floor(100 / n)}%" valign="top" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px">` +
          `<div style="font:600 10px ${FONT};letter-spacing:.8px;text-transform:uppercase;color:#6b7280">${esc(k.label)}</div>` +
          `<div style="font:700 20px ${FONT};color:${c ? c.solid : '#111827'};margin-top:2px">${esc(k.value)}</div>` +
          (k.sub ? `<div style="font:12px ${FONT};color:#6b7280;margin-top:1px">${esc(k.sub)}</div>` : '') + `</td>`;
      }).join('') + `</tr></table>`;
    }
    case 'table': {
      if (!b.rows || !b.rows.length) return `<div style="font:13px ${FONT};color:#6b7280;padding:6px 0">${esc(b.empty || 'None.')}</div>`;
      const head = b.noHeader ? '' : b.columns.map((c) => `<th align="${c.align || 'left'}" style="padding:7px 10px;font:600 10px ${FONT};letter-spacing:.7px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;white-space:nowrap">${esc(c.label)}</th>`).join('');
      const body = b.rows.map((r) => `<tr>` + b.columns.map((c) => {
        const o = cellObj(r[c.key]);
        const col = o.tone ? tone(o.tone).fg : '#111827';
        const inner = o.href ? `<a href="${esc(o.href)}" style="color:#1d4ed8;text-decoration:none">${esc(o.v)}</a>` : esc(o.v);
        return `<td align="${c.align || 'left'}" valign="top" style="padding:8px 10px;font:${o.bold ? 700 : 400} 13px ${FONT};color:${col};border-bottom:1px solid #f0f1f3">${inner}</td>`;
      }).join('') + `</tr>`).join('');
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${head ? `<tr>${head}</tr>` : ''}${body}</table>`;
    }
    case 'cards':
      return b.items.map((c) => {
        const t = c.badge ? tone(c.badge.tone) : tone('neutral');
        const fields = (c.fields || []).length ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:8px"><tr>` + c.fields.map(([l, v]) =>
          `<td style="padding:0 18px 4px 0" valign="top"><div style="font:600 10px ${FONT};letter-spacing:.7px;text-transform:uppercase;color:#6b7280">${esc(l)}</div><div style="font:600 14px ${MONO};color:#111827">${esc(v)}</div></td>`).join('') + `</tr></table>` : '';
        return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:10px;margin:0 0 10px;border-collapse:separate"><tr><td style="padding:12px 14px">` +
          `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="font:700 17px ${FONT};color:#111827">${esc(c.title)}</td>` +
          (c.badge ? `<td align="right">${pill(c.badge.text, c.badge.tone, true)}</td>` : '') + `</tr></table>` +
          (c.sub ? `<div style="font:13px ${FONT};color:#4b5563;margin-top:2px">${esc(c.sub)}</div>` : '') + fields +
          (c.lines || []).map((l) => `<div style="font:13px/1.45 ${FONT};color:#374151;margin-top:6px">${esc(l)}</div>`).join('') +
          ((c.links || []).length ? `<div style="font:13px ${FONT};margin-top:8px">${linkList(c.links)}</div>` : '') + `</td></tr></table>`;
      }).join('');
    case 'chipRows':
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">` + b.items.map((r) =>
        `<tr><td valign="top" width="118" style="padding:6px 10px 6px 0;border-bottom:1px solid #f0f1f3"><div style="font:600 13px ${FONT};color:#111827">${esc(r.label)}</div>` +
        (r.sub ? `<div style="font:12px ${FONT};color:#6b7280">${esc(r.sub)}</div>` : '') + `</td><td valign="top" style="padding:6px 0;border-bottom:1px solid #f0f1f3;line-height:27px">` +
        r.chips.map((i) => `<span style="display:inline-block;margin:0 4px 3px 0;padding:1px 8px;border-radius:5px;font:600 12px ${FONT};background:${tone(i.tone).solid};color:#fff;white-space:nowrap${i.ring ? ';outline:2px solid #f59e0b' : ''}">${esc(i.text)}${i.note ? ` <span style="font-weight:400;opacity:.8">${esc(i.note)}</span>` : ''}</span>`).join('') + `</td></tr>`).join('') + `</table>`;
    case 'chips':
      return `<div style="line-height:26px">` + b.items.map((i) => `<span style="display:inline-block;margin:0 4px 4px 0;padding:2px 9px;border-radius:5px;font:600 12px ${FONT};background:${tone(i.tone).solid};color:#fff;white-space:nowrap">${esc(i.text)}</span>`).join('') + `</div>`;
    case 'list':
      return `<ul style="margin:4px 0 0;padding-left:20px">` + b.items.map((i) => `<li style="font:13px/1.5 ${FONT};color:#374151;margin:0 0 4px">${esc(i)}</li>`).join('') + `</ul>`;
    case 'code':
      return `<pre style="margin:0;padding:10px 12px;background:#f3f4f6;border-radius:8px;font:12px/1.5 ${MONO};color:#374151;white-space:pre-wrap;word-break:break-word">${esc(b.text)}</pre>`;
    case 'para':
      return `<p style="margin:0 0 8px;font:14px/1.55 ${FONT};color:#374151">${esc(b.text)}</p>`;
    case 'callout': {
      const c = tone(b.tone || 'info');
      return `<div style="background:${c.bg};color:${c.fg};border-radius:8px;padding:10px 14px;font:13px/1.5 ${FONT}">${esc(b.text)}</div>`;
    }
    case 'raw':
      return b.html;
    default:
      return '';
  }
}

function render(spec) {
  const st = spec.status ? pill(spec.status.text, spec.status.tone, true) : '';
  const sections = (spec.sections || []).map((s) => `<tr><td style="padding:20px 24px 4px">` +
    (s.title ? `<div style="font:700 12px ${FONT};letter-spacing:1px;text-transform:uppercase;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:6px;margin-bottom:10px">${esc(s.title)}</div>` : '') +
    (s.note ? `<div style="font:12px/1.5 ${FONT};color:#6b7280;margin:-4px 0 10px">${esc(s.note)}</div>` : '') +
    (s.blocks || []).map((b) => `<div style="margin-bottom:10px">${block(b)}</div>`).join('') + `</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(spec.title)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f3f4f6"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6"><tr><td align="center" style="padding:20px 10px">` +
    `<table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;border-collapse:separate;overflow:hidden">` +
    `<tr><td style="background:#111827;padding:20px 24px 18px">` +
    `<div style="font:700 11px ${FONT};letter-spacing:1.6px;text-transform:uppercase;color:#9ca3af">${esc(spec.kind || 'Notification')}${st ? `&nbsp;&nbsp;${st}` : ''}</div>` +
    `<div style="font:700 22px/1.25 ${FONT};color:#ffffff;margin-top:8px">${esc(spec.title)}</div>` +
    (spec.subtitle ? `<div style="font:13px/1.45 ${FONT};color:#d1d5db;margin-top:6px">${esc(spec.subtitle)}</div>` : '') + `</td></tr>` +
    sections +
    `<tr><td style="padding:18px 24px 22px"><div style="border-top:1px solid #e5e7eb;padding-top:12px;font:11px/1.55 ${FONT};color:#9ca3af">` +
    (spec.footer ? esc(spec.footer) + '<br>' : '') + `Automated email from your trading ecosystem on this Mac. Market data can be delayed or wrong. Not investment advice.</div></td></tr>` +
    `</table></td></tr></table></body></html>`;
  return { html, text: renderText(spec) };
}

function renderText(spec) {
  const out = [`${(spec.kind || '').toUpperCase()}${spec.status ? `  [${spec.status.text}]` : ''}`, spec.title, spec.subtitle || '', ''];
  for (const s of spec.sections || []) {
    if (s.title) out.push(`== ${s.title.toUpperCase()} ==`);
    if (s.note) out.push(s.note);
    for (const b of s.blocks || []) {
      if (b.type === 'kpis') out.push(b.items.map((k) => `${k.label}: ${k.value}${k.sub ? ` (${k.sub})` : ''}`).join('  |  '));
      else if (b.type === 'table') {
        if (!b.rows || !b.rows.length) out.push(b.empty || 'None.');
        else {
          out.push(b.columns.map((c) => c.label).join(' | '));
          for (const r of b.rows) out.push(b.columns.map((c) => cellObj(r[c.key]).v).join(' | '));
        }
      } else if (b.type === 'cards') {
        for (const c of b.items) {
          out.push(`- ${c.title}${c.badge ? ` [${c.badge.text}]` : ''}${c.sub ? ` - ${c.sub}` : ''}`);
          if ((c.fields || []).length) out.push('  ' + c.fields.map(([l, v]) => `${l} ${v}`).join('  '));
          for (const l of c.lines || []) out.push(`  ${l}`);
          for (const l of c.links || []) out.push(`  ${l.label}: ${l.href}`);
        }
      } else if (b.type === 'chips') out.push(b.items.map((i) => i.text).join(', '));
      else if (b.type === 'chipRows') out.push(...b.items.map((r) => `${r.label}${r.sub ? ` (${r.sub})` : ''}: ${r.chips.map((i) => i.text).join(', ')}`));
      else if (b.type === 'list') out.push(...b.items.map((i) => `- ${i}`));
      else if (b.type === 'para' || b.type === 'callout' || b.type === 'code') out.push(b.text);
      else if (b.type === 'raw') out.push(b.text || '');
    }
    out.push('');
  }
  out.push(spec.footer || '', 'Automated email from your trading ecosystem. Not investment advice.');
  return out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

function send(subject, spec, opts = {}) {
  const { execFileSync } = require('child_process');
  subject = (process.env.EMAIL_SUBJECT_PREFIX || '') + subject;   // e.g. "[TEST] " for sample sends
  const { html, text } = render(spec);
  const tmp = path.join(os.tmpdir(), `email-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, text);
  const env = { ...process.env, ...(opts.to ? { SEND_EMAIL_TO: String(opts.to) } : {}), SEND_EMAIL_HTML: '1', SEND_EMAIL_TEXT_FILE: tmp, SEND_EMAIL_TIMEOUT_MS: String(opts.timeoutMs || 35000) };
  if (!env.FLIP_GMAIL_APP_PASSWORD) env.FLIP_GMAIL_APP_PASSWORD = execFileSync('/usr/bin/security', ['find-generic-password', '-a', 'darup67@gmail.com', '-s', 'flip-notifier-gmail', '-w']).toString().trim();
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'send-email.js'), subject, html], { env, timeout: (opts.timeoutMs || 35000) + 5000, stdio: 'ignore' });
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

module.exports = { render, send, TONE };

if (require.main === module) {
  const [, , cmd, subject] = process.argv;
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    const spec = JSON.parse(input);
    if (cmd === 'render') process.stdout.write(JSON.stringify(render(spec)));
    else if (cmd === 'send') { send(subject, spec); process.stdout.write('sent'); }
    else { process.stderr.write('usage: email-ui.js render|send [subject] < spec.json\n'); process.exit(1); }
  });
}
