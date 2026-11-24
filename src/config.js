// Local configuration and credentials. Secrets stay on this computer:
//   config.json       — non-secret settings
//   credentials.json  — Arcade contributor token and (optionally) provider API keys, file mode 0600
// Provider keys may instead come from environment variables (recommended).
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { ROLES } from './util.js';

export function configDir() {
  if (process.env.ARCADE_AGENT_HOME) return process.env.ARCADE_AGENT_HOME;
  if (platform() === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'arcade-agent');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'arcade-agent');
}

export const DEFAULTS = {
  arcade_url: 'https://arcade.rondanini.com',
  provider: { kind: 'ollama', model: 'llama3.2', base_url: null, max_output_tokens: 1500, temperature: 0.3, json_mode: true, num_ctx: 8192 },
  roles: ['sceptic'],
  cases: [],                         // empty = any case
  auto_submit: false,                // when false every submission is shown for approval (or queued)
  schedule: { enabled: false, interval_minutes: 180, tasks_per_run: 1, max_per_day: 6 },
  ollama_cloud: { min_included_balance_usd: 0.5, min_remaining_percent: 10, max_requests_per_day: 20, allow_unverified_balance: false },
  dev_allow_insecure_http: false,    // testing only: allows http:// to loopback for the Arcade and cloud endpoints
};

function readJson(p, d) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } }
function writePrivate(p, obj) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
}
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v; return o; };

export function loadConfig() {
  const p = join(configDir(), 'config.json');
  if (!existsSync(p)) throw new Error(`No configuration at ${p}. Run "arcade-agent init" first.`);
  let file;
  try { file = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`Cannot read ${p}: ${e.message}`); }
  const c = merge(DEFAULTS, file);
  validateConfig(c);
  return c;
}
export function saveConfig(c) { validateConfig(c); writePrivate(join(configDir(), 'config.json'), c); }
export function loadCredentials() { return readJson(join(configDir(), 'credentials.json'), {}); }
export function saveCredentials(cr) { writePrivate(join(configDir(), 'credentials.json'), cr); }
export const hasConfig = () => existsSync(join(configDir(), 'config.json'));

export function validateConfig(c) {
  const u = new URL(c.arcade_url);
  if (u.protocol !== 'https:' && !(c.dev_allow_insecure_http && u.protocol === 'http:')) throw new Error('arcade_url must use https://');
  if (!['ollama', 'lmstudio', 'ollama-cloud', 'anthropic', 'openai'].includes(c.provider.kind)) throw new Error(`Unsupported provider ${c.provider.kind}`);
  if (!c.provider.model) throw new Error('provider.model is required');
  if (!Array.isArray(c.roles) || !c.roles.length || c.roles.some((r) => !ROLES.includes(r))) throw new Error(`roles must be a non-empty subset of ${ROLES.join(', ')}`);
  if (c.schedule.interval_minutes < 30) throw new Error('schedule.interval_minutes must be ≥ 30');
  if (c.provider.max_output_tokens > 4000) throw new Error('provider.max_output_tokens must be ≤ 4000');
}

/** Provider secret: env var first, then credentials.json. Never sent to the Arcade. */
export function providerKey(kind, creds = loadCredentials()) {
  const env = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', 'ollama-cloud': 'OLLAMA_API_KEY', ollama: 'OLLAMA_API_KEY' }[kind];
  return (env && process.env[env]) || creds.provider_keys?.[kind] || null;
}
export function allSecrets(creds = loadCredentials()) {
  return [creds.arcade_token, ...Object.values(creds.provider_keys || {}),
    process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.OLLAMA_API_KEY].filter((s) => s && s.length >= 8);
}
