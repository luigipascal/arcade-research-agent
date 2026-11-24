// Research workflow: fetch context → local/own-subscription inference → build payload →
// show exact payload → submit (only after approval, unless auto_submit is explicitly on).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, CLIENT } from './util.js';
import { configDir, allSecrets } from './config.js';
import { infer, describeLocation } from './providers.js';

/** Build the exact JSON body that will be sent to The Arcade. */
export function buildPayload(cfg, ctx, result, timing) {
  return {
    task_id: ctx.task_id, case_id: ctx.case_id, role: ctx.role,
    context_version: ctx.context_version,
    prompt_sha256: sha256(ctx.system + '\n\n' + ctx.user),   // equals context_version when the context was sent unmodified
    model: { declared_model: cfg.provider.model, provider: cfg.provider.kind, inference_location: result.location },
    client: { ...CLIENT },
    inference_started_at: timing.started, inference_completed_at: timing.completed,
    output: result.text,
  };
}

/** Refuse to transmit anything that contains a local secret. */
export function assertNoSecrets(payload, secrets = allSecrets()) {
  const body = JSON.stringify(payload);
  for (const s of secrets) if (s && body.includes(s)) throw new Error('Refusing to submit: payload contains one of your local credentials');
  if (/sk-ant-[A-Za-z0-9_-]{10,}|\bsk-(proj-)?[A-Za-z0-9_-]{20,}|arc_[a-z0-9]{8}_[A-Za-z0-9_-]{20,}/.test(body)) throw new Error('Refusing to submit: payload looks like it contains an API key');
}

export async function research(cfg, ctx) {
  const started = new Date().toISOString();
  const result = await infer(cfg, { system: ctx.system, user: ctx.user });
  if (result.text.length < 20) throw new Error('Model returned an empty or very short answer; nothing to submit');
  const payload = buildPayload(cfg, ctx, result, { started, completed: new Date().toISOString() });
  assertNoSecrets(payload);
  return { payload, guard: result.guard };
}

export function preview(payload, ctx) {
  const lines = [];
  lines.push('════════ EXACT DATA TO BE SENT TO THE ARCADE ════════');
  lines.push(`Endpoint: POST /api/observatory/community/v1/contributions`);
  lines.push(`Case: ${ctx?.case_title || payload.case_id}  ·  Role: ${payload.role}`);
  lines.push(`Model: ${payload.model.declared_model} (${payload.model.provider}, inference ${payload.model.inference_location})`);
  if (payload.model.inference_location === 'cloud') lines.push('Note: this answer was produced by a cloud provider, which processed the research prompt.');
  lines.push('Published under your contributor identity after moderation.');
  lines.push('──── JSON body ────');
  lines.push(JSON.stringify(payload, null, 2));
  lines.push('══════════════════════════════════════════════════════');
  return lines.join('\n');
}

// ── Local review queue (drafts awaiting approval) ──
const qdir = () => join(configDir(), 'queue');
export function queueDraft(payload, ctx) {
  mkdirSync(qdir(), { recursive: true });
  const f = join(qdir(), `${Date.now()}-${payload.task_id.replace(/[^a-z0-9.-]/g, '_')}.json`);
  writeFileSync(f, JSON.stringify({ payload, ctx: { case_title: ctx.case_title, question: ctx.question } }, null, 2), { mode: 0o600 });
  return f;
}
export function listDrafts() {
  try { return readdirSync(qdir()).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: join(qdir(), f), ...JSON.parse(readFileSync(join(qdir(), f), 'utf8')) })); }
  catch { return []; }
}
export const removeDraft = (f) => unlinkSync(f);
export { describeLocation };
