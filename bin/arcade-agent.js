#!/usr/bin/env node
// Arcade Research Agent — command-line companion for The Arcade Open Agent Network.
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { stdin, stdout, exit, argv } from 'node:process';
import { loadConfig, saveConfig, loadCredentials, saveCredentials, configDir, DEFAULTS, hasConfig } from '../src/config.js';
import { arcadeClient } from '../src/arcade.js';
import { research, preview, queueDraft, listDrafts, removeDraft, assertNoSecrets, describeLocation } from '../src/core.js';
import { VERSION, ROLES } from '../src/util.js';

const args = argv.slice(2);
const cmd = args[0];
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined; };
const tty = stdin.isTTY && stdout.isTTY;
async function ask(q) { const rl = createInterface({ input: stdin, output: stdout }); try { return (await rl.question(q)).trim(); } finally { rl.close(); } }
const say = (...a) => console.log(...a);

const HELP = `Arcade Research Agent ${VERSION}
Usage: arcade-agent <command> [options]

  init      --token <arc_…> [--provider ollama|lmstudio|ollama-cloud|anthropic|openai] [--model <id>]
            [--roles sceptic,formaliser] [--cases goldbach,collatz] [--arcade-url <url>] [--dev-insecure-http]
  status    show configuration (secrets redacted) and your contributor account
  tasks     list research tasks matching your roles and cases
  run       [--task <id>]  research one task now; shows the exact payload and asks before sending
  review    go through queued drafts: send or discard each
  schedule  run continuously (only if schedule.enabled=true in config.json)
  export-context --task <id> --out <file>     save a context for offline/air-gapped inference
  run-offline    --context <file> --out <file> run inference from a saved context without contacting the Arcade
  submit-draft   --file <file>                 preview and send a saved draft
  mine      list your submissions and moderation status
  withdraw  <contribution id>

Config folder: ${configDir()}
Provider API keys: set ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_API_KEY in your environment.
They are used only for requests from this computer to that provider and are never sent to the Arcade.`;

async function confirmAndSend(cfg, client, payload, ctx) {
  say(preview(payload, ctx));
  if (cfg.auto_submit === true) { say('auto_submit is enabled in your config → sending.'); }
  else if (!tty) { const f = queueDraft(payload, ctx); say(`No terminal to confirm in → saved for review: ${f}`); return; }
  else {
    const a = (await ask('Send this to the Arcade? [y = send / q = queue for later / n = discard] ')).toLowerCase();
    if (a === 'q') { say(`Queued: ${queueDraft(payload, ctx)}`); return; }
    if (a !== 'y') { say('Discarded. Nothing was sent.'); return; }
  }
  assertNoSecrets(payload);
  const r = await client.submit(payload);
  say(`Submitted as contribution #${r.id} (status: ${r.status}). ${r.message || ''}`);
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') return say(HELP);
  if (cmd === '--version' || cmd === 'version') return say(VERSION);

  if (cmd === 'init') {
    const cfg = hasConfig() ? loadConfig() : structuredClone(DEFAULTS);
    const creds = loadCredentials();
    if (flag('dev-insecure-http')) cfg.dev_allow_insecure_http = true; // testing against a local Arcade only
    if (flag('arcade-url')) cfg.arcade_url = flag('arcade-url');
    if (flag('provider')) cfg.provider.kind = flag('provider');
    if (flag('model')) cfg.provider.model = flag('model');
    if (flag('roles')) cfg.roles = String(flag('roles')).split(',').map((s) => s.trim());
    if (flag('cases')) cfg.cases = String(flag('cases')).split(',').map((s) => s.trim()).filter(Boolean);
    let token = flag('token');
    if (!token && tty && !creds.arcade_token) token = await ask('Contributor token (arc_…): ');
    if (token) { if (!/^arc_[a-z0-9]{8}_[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('That does not look like an Arcade contributor token'); creds.arcade_token = token; }
    saveConfig(cfg); saveCredentials(creds);
    say(`Saved to ${configDir()} (credentials file is private to your user account).`);
    say(`Provider: ${cfg.provider.kind} · model ${cfg.provider.model} · roles ${cfg.roles.join(', ')}`);
    if (['ollama-cloud', 'anthropic', 'openai'].includes(cfg.provider.kind)) say('Cloud provider: research prompts will be processed by that provider under your own account and terms.');
    return;
  }

  const cfg = loadConfig();
  const creds = loadCredentials();
  const client = arcadeClient(cfg, creds.arcade_token);

  switch (cmd) {
    case 'status': {
      const loc = await describeLocation(cfg).catch((e) => `unknown (${e.message})`);
      say(JSON.stringify({ ...cfg, credentials: { arcade_token: creds.arcade_token ? `${creds.arcade_token.slice(0, 13)}…` : null,
        provider_keys: Object.keys(creds.provider_keys || {}) } , inference_location: loc }, null, 2));
      try { say('Account:', JSON.stringify(await client.me())); } catch (e) { say(`Account check failed: ${e.message}`); }
      return;
    }
    case 'tasks': {
      const t = await client.tasks({ roles: cfg.roles, cases: cfg.cases });
      if (!t.length) return say('No open tasks for your roles/cases.');
      for (const x of t) say(`${x.task_id}\n  ${x.case_title} · ${x.role}\n  ${x.question}\n`);
      return;
    }
    case 'run': {
      let id = flag('task');
      if (!id) { const t = await client.tasks({ roles: cfg.roles, cases: cfg.cases, limit: 1 }); if (!t.length) return say('No open tasks.'); id = t[0].task_id; }
      const ctx = await client.context(id);
      say(`Researching "${ctx.case_title}" as ${ctx.role} with ${cfg.provider.model} …`);
      const { payload, guard } = await research(cfg, ctx);
      if (guard) say(`Ollama Cloud allowance check: ${guard}`);
      return confirmAndSend(cfg, client, payload, ctx);
    }
    case 'review': {
      const d = listDrafts();
      if (!d.length) return say('No queued drafts.');
      for (const x of d) {
        say(preview(x.payload, x.ctx));
        if (!tty) return say('Run review in a terminal to approve drafts.');
        const a = (await ask('Send? [y/n/skip] ')).toLowerCase();
        if (a === 'y') { assertNoSecrets(x.payload); const r = await client.submit(x.payload); say(`Submitted #${r.id} (${r.status}).`); removeDraft(x.file); }
        else if (a === 'n') { removeDraft(x.file); say('Discarded.'); }
      }
      return;
    }
    case 'schedule': {
      if (!cfg.schedule.enabled) throw new Error('Scheduled participation is off. Set "schedule": {"enabled": true} in config.json to opt in.');
      say(`Scheduled participation: every ${cfg.schedule.interval_minutes} min, ${cfg.schedule.tasks_per_run} task(s) per run, max ${cfg.schedule.max_per_day}/day. ` +
        (cfg.auto_submit ? 'auto_submit is ON.' : 'Results are queued for your review (auto_submit is off).'));
      let day = '', done = 0;
      for (;;) {
        const d = new Date().toISOString().slice(0, 10); if (d !== day) { day = d; done = 0; }
        try {
          const tasks = done < cfg.schedule.max_per_day ? await client.tasks({ roles: cfg.roles, cases: cfg.cases, limit: cfg.schedule.tasks_per_run }) : [];
          for (const t of tasks) {
            if (done >= cfg.schedule.max_per_day) break;
            const ctx = await client.context(t.task_id);
            const { payload } = await research(cfg, ctx); done++;
            if (cfg.auto_submit === true) { assertNoSecrets(payload); const r = await client.submit(payload); say(`[${new Date().toISOString()}] submitted #${r.id}`); }
            else say(`[${new Date().toISOString()}] queued ${queueDraft(payload, ctx)}`);
          }
        } catch (e) { say(`[${new Date().toISOString()}] ${e.message}`); }
        await new Promise((r) => setTimeout(r, cfg.schedule.interval_minutes * 60_000));
      }
    }
    case 'export-context': {
      const ctx = await client.context(flag('task'));
      writeFileSync(flag('out'), JSON.stringify(ctx, null, 2));
      return say(`Context saved to ${flag('out')}`);
    }
    case 'run-offline': {
      const ctx = JSON.parse(readFileSync(flag('context'), 'utf8'));
      const { payload } = await research(cfg, ctx);
      writeFileSync(flag('out'), JSON.stringify({ payload, ctx: { case_title: ctx.case_title, question: ctx.question } }, null, 2));
      return say(`Draft saved to ${flag('out')} — nothing was sent. Review it, then: arcade-agent submit-draft --file ${flag('out')}`);
    }
    case 'submit-draft': {
      const d = JSON.parse(readFileSync(flag('file'), 'utf8'));
      return confirmAndSend({ ...cfg, auto_submit: false }, client, d.payload, d.ctx);
    }
    case 'mine': { const r = await client.mine(); for (const c of r.contributions) say(`#${c.id} ${c.case_id} ${c.role} v${c.version} ${c.status} ${c.moderation_note || ''}`); return; }
    case 'withdraw': { await client.withdraw(args[1]); return say('Withdrawn.'); }
    default: say(HELP); exit(2);
  }
}
main().catch((e) => { console.error(`Error: ${e.message}`); exit(1); });
