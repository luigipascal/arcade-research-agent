// Restricted model-inference interface.
//
// infer({ system, user }) → { text, model, location }
//   * Exactly one system + one user text message are sent. No tools, functions, files,
//     images, browsing or code execution are ever offered to the model.
//   * Any tool/function calls a model tries to emit are discarded, never executed.
//   * Request bodies are built from a fixed whitelist of fields — nothing from the
//     (untrusted) task context can add parameters or change the endpoint.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boundedFetch, isLoopback } from './util.js';
import { configDir, providerKey } from './config.js';

export class ProviderRefusal extends Error {}

const OFFICIAL = {
  'ollama-cloud': 'https://ollama.com',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};
const LOCAL_DEFAULT = { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234' };

function baseUrl(cfg) {
  const p = cfg.provider;
  if (p.kind in LOCAL_DEFAULT) {
    const u = new URL(p.base_url || LOCAL_DEFAULT[p.kind]);
    if (!isLoopback(u.hostname) && !p.allow_lan_endpoint) {
      throw new ProviderRefusal(`${p.kind} endpoint must be on this computer (127.0.0.1/localhost). Set provider.allow_lan_endpoint=true only for a machine on your own private network.`);
    }
    return u.origin;
  }
  const u = new URL(p.base_url || OFFICIAL[p.kind]);
  const devOk = cfg.dev_allow_insecure_http && u.protocol === 'http:' && isLoopback(u.hostname);
  if (u.protocol !== 'https:' && !devOk) throw new ProviderRefusal(`${p.kind} endpoint must use https`);
  return u.origin;
}

// ── Ollama Cloud: stay inside the plan's included allowance ──────────
// Before every cloud request we check https://ollama.com/api/balance and refuse when the
// included allowance is low, so a request can never fall through to purchased credits.
// Fails closed: if the balance cannot be read, no cloud request is made.
const statePath = () => join(configDir(), 'state.json');
function readState() { try { return JSON.parse(readFileSync(statePath(), 'utf8')); } catch { return {}; } }
function writeState(s) { mkdirSync(configDir(), { recursive: true }); writeFileSync(statePath(), JSON.stringify(s, null, 2), { mode: 0o600 }); }
const today = () => new Date().toISOString().slice(0, 10);

export async function ollamaCloudGuard(cfg, { balanceUrl } = {}) {
  const g = cfg.ollama_cloud;
  const st = readState();
  const day = st.ollama_cloud?.day === today() ? st.ollama_cloud : { day: today(), requests: 0, stopped: null };
  if (day.stopped) throw new ProviderRefusal(`Ollama Cloud paused for today: ${day.stopped}`);
  if (day.requests >= g.max_requests_per_day) throw new ProviderRefusal(`Ollama Cloud daily request cap reached (${g.max_requests_per_day})`);
  const key = providerKey('ollama-cloud');
  let verdict = null;
  if (!key) {
    if (!g.allow_unverified_balance) throw new ProviderRefusal('Ollama Cloud: set OLLAMA_API_KEY so the agent can confirm your included allowance before each request (or explicitly set ollama_cloud.allow_unverified_balance=true).');
    verdict = 'unverified (allowed by configuration)';
  } else {
    const url = balanceUrl || `${cfg.provider.kind === 'ollama-cloud' ? baseUrl(cfg) : OFFICIAL['ollama-cloud']}/api/balance`;
    let r;
    try { r = await boundedFetch(url, { headers: { authorization: `Bearer ${key}` } }, { timeoutMs: 15_000, maxBytes: 64_000 }); }
    catch (e) { throw new ProviderRefusal(`Ollama Cloud balance check failed (${e.message}); not sending.`); }
    if (!r.ok) throw new ProviderRefusal(`Ollama Cloud balance check returned HTTP ${r.status}; not sending.`);
    const b = r.json();
    const inc = b.included || {};
    if (typeof inc.balance_usd === 'number') {
      if (inc.balance_usd < g.min_included_balance_usd) throw new ProviderRefusal(`Ollama Cloud included allowance low ($${inc.balance_usd.toFixed(2)} < $${g.min_included_balance_usd}); stopping to avoid purchased credits.`);
      verdict = `included $${inc.balance_usd.toFixed(2)} remaining`;
    } else if (inc.session && inc.weekly) {
      const min = Math.min(inc.session.remaining_percent, inc.weekly.remaining_percent);
      if (!(min >= g.min_remaining_percent)) throw new ProviderRefusal(`Ollama Cloud plan usage low (${min}% remaining); stopping.`);
      verdict = `session ${inc.session.remaining_percent}% / weekly ${inc.weekly.remaining_percent}% remaining`;
    } else throw new ProviderRefusal('Ollama Cloud balance response not understood; not sending.');
  }
  day.requests++;
  writeState({ ...st, ollama_cloud: day });
  return verdict;
}
function ollamaCloudStop(reason) {
  const st = readState();
  const day = st.ollama_cloud?.day === today() ? st.ollama_cloud : { day: today(), requests: 0 };
  writeState({ ...st, ollama_cloud: { ...day, stopped: reason } });
}

// ── Location detection for Ollama (local model vs ":cloud" model via the local daemon) ──
async function ollamaIsCloudModel(base, model) {
  if (/[:-]cloud$/.test(model)) return true;
  try {
    const r = await boundedFetch(`${base}/api/tags`, {}, { timeoutMs: 10_000, maxBytes: 1_000_000 });
    const m = (r.json().models || []).find((x) => x.name === model || x.model === model || x.name === `${model}:latest`);
    return !!(m && m.remote_host);
  } catch { return false; }
}

export async function describeLocation(cfg) {
  const k = cfg.provider.kind;
  if (k === 'lmstudio') return 'local';
  if (k === 'ollama') return (await ollamaIsCloudModel(baseUrl(cfg), cfg.provider.model)) ? 'cloud' : 'local';
  return 'cloud';
}

/** The ONLY function that talks to a model. */
export async function infer(cfg, { system, user }) {
  const p = cfg.provider;
  const base = baseUrl(cfg);
  const max = Math.min(p.max_output_tokens || 1500, 4000);
  const temperature = typeof p.temperature === 'number' ? Math.max(0, Math.min(1, p.temperature)) : 0.3;
  if (p.kind === 'openai' && !providerKey('openai')) throw new ProviderRefusal('OPENAI_API_KEY is not set on this computer');
  if (p.kind === 'ollama-cloud' && !providerKey('ollama-cloud')) throw new ProviderRefusal('OLLAMA_API_KEY is not set on this computer');
  const location = await describeLocation(cfg);
  let guard = null;
  if (p.kind === 'ollama-cloud' || (p.kind === 'ollama' && location === 'cloud')) guard = await ollamaCloudGuard(cfg);

  let r, text;
  if (p.kind === 'ollama' || p.kind === 'ollama-cloud') {
    const headers = { 'content-type': 'application/json' };
    if (p.kind === 'ollama-cloud') headers.authorization = `Bearer ${providerKey('ollama-cloud') || ''}`;
    const body = { model: p.model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      options: { num_predict: max, temperature, num_ctx: Math.max(2048, Math.min(p.num_ctx || 8192, 65536)) } };
    if (p.json_mode !== false) body.format = 'json';
    if (typeof p.think === 'boolean') body.think = p.think;
    r = await boundedFetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify(body) }, { timeoutMs: 600_000 });
    if (!r.ok && guard && [402, 403, 429].includes(r.status)) ollamaCloudStop(`HTTP ${r.status} from Ollama Cloud`);
    if (!r.ok) throw new Error(`${p.kind} returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    text = r.json().message?.content || '';
  } else if (p.kind === 'lmstudio' || p.kind === 'openai') {
    const headers = { 'content-type': 'application/json' };
    if (p.kind === 'openai') headers.authorization = `Bearer ${providerKey('openai') || ''}`;
    const body = { model: p.model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (p.kind === 'openai') body.max_completion_tokens = max; else { body.max_tokens = max; body.temperature = temperature; }
    r = await boundedFetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, { timeoutMs: 600_000 });
    if (!r.ok) throw new Error(`${p.kind} returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    text = r.json().choices?.[0]?.message?.content || '';
  } else if (p.kind === 'anthropic') {
    const key = providerKey('anthropic');
    if (!key) throw new ProviderRefusal('ANTHROPIC_API_KEY is not set on this computer');
    const body = { model: p.model, max_tokens: max, temperature, system, messages: [{ role: 'user', content: user }] };
    r = await boundedFetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) }, { timeoutMs: 600_000 });
    if (!r.ok) throw new Error(`anthropic returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    text = (r.json().content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  return { text: String(text).trim(), model: p.model, location, guard };
}
