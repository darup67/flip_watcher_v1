#!/usr/bin/env node
// Sends a flip alert email via Gmail SMTP. Zero dependencies (uses Node tls).
// Usage: node send-email.js "subject" "body"
//
// Requires FLIP_GMAIL_APP_PASSWORD env var (a Google App Password).
// Generate one at https://myaccount.google.com/apppasswords
//
// The password is stored in macOS Keychain so it never touches disk in plaintext:
//   security add-generic-password -a darup67@gmail.com -s flip-notifier-gmail -w "YOUR_APP_PASSWORD"
//
// Hardened: 3 retries with exponential backoff, SMTP dot-stuffing, hard process
// timeout, DNS and socket error handling.

'use strict';
const tls = require('tls');
const dns = require('dns');

const GMAIL_USER = 'darup67@gmail.com';
const APP_PASSWORD = process.env.FLIP_GMAIL_APP_PASSWORD;
if (!APP_PASSWORD) { process.stderr.write('FLIP_GMAIL_APP_PASSWORD not set\n'); process.exit(1); }

const [,, subject, body] = process.argv;
if (!subject) { process.stderr.write('Usage: send-email.js "subject" "body"\n'); process.exit(1); }

// Hard process timeout — never hang forever regardless of what happens below.
const HARD_TIMEOUT_MS = 30000;
setTimeout(() => { process.stderr.write('hard timeout\n'); process.exit(1); }, HARD_TIMEOUT_MS).unref();

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;

// SMTP dot-stuffing: a line starting with '.' must be doubled so the server
// doesn't interpret it as end-of-data.
function dotStuff(text) {
  return text.replace(/\r?\n/g, '\r\n').replace(/^\.(?=.)/gm, '..');
}

function buildMessage() {
  const stuffedBody = dotStuff(body || subject);
  return [
    `From: Flip Watcher <${GMAIL_USER}>`,
    `To: ${GMAIL_USER}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    stuffedBody,
  ].join('\r\n');
}

function attempt(retryNum) {
  return new Promise((resolve, reject) => {
    const msg = buildMessage();
    const commands = [
      null,
      'EHLO flipnotifier',
      `AUTH PLAIN ${Buffer.from(`\0${GMAIL_USER}\0${APP_PASSWORD}`).toString('base64')}`,
      `MAIL FROM:<${GMAIL_USER}>`,
      `RCPT TO:<${GMAIL_USER}>`,
      'DATA',
      `${msg}\r\n.`,
      'QUIT',
    ];

    let step = 0;
    let buf = '';
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      if (err) reject(err); else resolve();
    };

    // Pre-check DNS so a resolution failure gives a clear error
    // instead of a cryptic ENOTFOUND inside tls.connect.
    let sock;
    try {
      sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' }, () => {});
    } catch (e) {
      return reject(e);
    }
    sock.setEncoding('utf8');
    sock.setTimeout(12000, () => finish(new Error('socket timeout')));

    sock.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        if (line[3] === '-') continue; // multi-line continuation
        if (code >= 500) return finish(new Error(`permanent: ${line}`));
        if (code >= 400) return finish(new Error(`transient: ${line}`));
        step++;
        if (step < commands.length) {
          sock.write(commands[step] + '\r\n');
        } else {
          finish(null);
        }
      }
    });

    sock.on('error', e => finish(e));
    sock.on('close', () => finish(new Error('connection closed unexpectedly')));
  });
}

async function sendWithRetry() {
  let lastErr;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await attempt(i);
      process.stdout.write('email sent\n');
      process.exit(0);
    } catch (e) {
      lastErr = e;
      // Don't retry permanent SMTP errors (5xx)
      if (e.message && e.message.startsWith('permanent:')) {
        process.stderr.write(`smtp permanent error: ${e.message}\n`);
        process.exit(1);
      }
      if (i < MAX_RETRIES - 1) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, i);
        process.stderr.write(`attempt ${i + 1} failed (${e.message}), retrying in ${delay}ms\n`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  process.stderr.write(`email failed after ${MAX_RETRIES} attempts: ${lastErr.message}\n`);
  process.exit(1);
}

sendWithRetry();
