import { createHash } from 'node:crypto';
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const VERSION = '0.1.0';
export const CLIENT = { name: 'arcade-research-agent', version: VERSION };
export const ROLES = ['formaliser', 'sceptic', 'researcher', 'referee'];

/** fetch with timeout and a hard cap on response size (untrusted servers). */
export async function boundedFetch(url, opts = {}, { timeoutMs = 120_000, maxBytes = 2_000_000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, redirect: 'error', signal: ac.signal });
    const reader = res.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { ac.abort(); throw new Error(`Response from ${new URL(url).host} exceeded ${maxBytes} bytes`); }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return { status: res.status, ok: res.ok, headers: res.headers, text, json() { return JSON.parse(text); } };
  } finally { clearTimeout(t); }
}

export function isLoopback(host) {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}
