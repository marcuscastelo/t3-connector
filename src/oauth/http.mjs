import { createHash, randomBytes } from 'node:crypto';

// Small HTTP helpers shared by the public (AS + RS) and local (control-plane) listeners.
export const MAX_BODY = 64 * 1024;
export const redact = v => (v ? createHash('sha256').update(String(v)).digest('hex').slice(0, 8) : null);
export const nonce = () => randomBytes(16).toString('base64');
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

// HTML pages carry a strict CSP: only our inline script/style with this response's nonce, fetches to
// the same origin, no framing.
export function html(res, status, render, headers = {}) {
  const n = nonce();
  res.writeHead(status, {
    ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${n}' 'self'; style-src 'nonce-${n}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    ...headers,
  });
  res.end(render(n));
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location, ...headers });
  res.end();
}

export async function readBody(req, limit = MAX_BODY) {
  const parts = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('body_too_large'), { status: 413 }); parts.push(c); }
  return Buffer.concat(parts).toString('utf8');
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('='); if (i < 1) continue;
    const k = part.slice(0, i).trim(); if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function page(title, body, n) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style nonce="${n}">body{font:16px system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222}code{background:#eee;padding:2px 4px;border-radius:3px}a.btn,button{display:inline-block;padding:10px 16px;background:#185;color:#fff;border:0;border-radius:6px;text-decoration:none;font-size:16px;cursor:pointer}button.danger{background:#a22}.big{font-size:30px;letter-spacing:4px;font-family:monospace}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}dt{color:#666}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px;text-align:left;font-size:14px}.muted{color:#666;font-size:14px}</style></head><body>${body}</body></html>`;
}

// Runs an async handler and turns unexpected errors into a 500 without leaking details.
export const wrap = (fn, onError = () => {}) => (req, res) => fn(req, res).catch(e => {
  onError(e);
  if (!res.headersSent) json(res, e.status ?? 500, { error: e.status ? e.message : 'internal_error' });
  else res.destroy();
});
