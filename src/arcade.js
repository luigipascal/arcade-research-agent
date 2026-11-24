// Outbound-only HTTPS client for The Arcade community API.
// Everything received is treated as untrusted data and validated against a strict shape.
import { boundedFetch, isLoopback, CLIENT } from './util.js';

export class ArcadeError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const TASK_ID = /^[a-z0-9-]{2,64}\.(formaliser|sceptic|researcher|referee)\.[0-9a-f]{24}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function arcadeClient(cfg, token) {
  const u = new URL(cfg.arcade_url);
  if (u.protocol !== 'https:' && !(cfg.dev_allow_insecure_http && isLoopback(u.hostname))) throw new Error('The Arcade must be reached over https');
  const api = `${u.origin}/api/observatory/community/v1`;
  async function call(method, path, body) {
    if (!token) throw new ArcadeError(401, 'No contributor token configured (run: arcade-agent init --token …)');
    const r = await boundedFetch(api + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'user-agent': `${CLIENT.name}/${CLIENT.version}` }, body: body ? JSON.stringify(body) : undefined }, { timeoutMs: 60_000, maxBytes: 2_000_000 });
    let j = {}; try { j = r.json(); } catch {}
    if (!r.ok) throw new ArcadeError(r.status, j.error || `HTTP ${r.status}`);
    return j;
  }
  return {
    me: () => call('GET', '/me'),
    async tasks({ roles, cases, limit = 20 } = {}) {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (roles?.length) qs.set('roles', roles.join(','));
      if (cases?.length) qs.set('cases', cases.join(','));
      const j = await call('GET', `/tasks?${qs}`);
      return (Array.isArray(j.tasks) ? j.tasks : []).filter((t) => TASK_ID.test(t.task_id)).map((t) => ({
        task_id: t.task_id, case_id: String(t.case_id), case_title: String(t.case_title || '').slice(0, 200), role: String(t.role), question: String(t.question || '').slice(0, 1500) }));
    },
    async context(taskId) {
      if (!TASK_ID.test(taskId)) throw new Error('Invalid task id');
      const j = await call('GET', `/tasks/${encodeURIComponent(taskId)}/context`);
      if (j.task_id !== taskId || !HEX64.test(j.context_version) || typeof j.messages?.system !== 'string' || typeof j.messages?.user !== 'string') throw new Error('Malformed context from server');
      if (j.messages.system.length > 40_000 || j.messages.user.length > 60_000) throw new Error('Context too large');
      // Only these fields are used. Nothing in the context can select a model, endpoint, tool or file.
      return { task_id: j.task_id, case_id: String(j.case_id), case_title: String(j.case_title || ''), role: String(j.role), question: String(j.question || ''),
        context_version: j.context_version, system: j.messages.system, user: j.messages.user };
    },
    submit: (payload) => call('POST', '/contributions', payload),
    mine: () => call('GET', '/contributions'),
    withdraw: (id) => call('POST', `/contributions/${parseInt(id, 10)}/withdraw`, {}),
  };
}
