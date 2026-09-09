/**
 * Why the closing investigation call cached 0%, and whether the fix holds.
 *
 * REPRODUCES THE MEASUREMENT behind codex_plans/Model_Cost_Notes.md
 * § SOLVED 2026-09-07. It exists because that finding reversed four earlier
 * conclusions that had each been "tested" — and the reason those tests were
 * wrong is that they replayed a synthetic prefix instead of the sequence
 * production actually runs. This replays the real one: the real system prompt
 * (read out of investigate.mjs, so it cannot drift), the real tool definitions
 * for a real ticket, and the real FINALIZE_TOOL.
 *
 * TWO EXPERIMENTS, both against the live API:
 *
 *   A — diagnosis. Five calls isolating one request field at a time. Shows that
 *       `tool_choice: none` is innocent and `response_format` is not, and that
 *       the closing shape caches perfectly off ANOTHER closing-shape call — so
 *       response_format PARTITIONS the cache rather than breaking it.
 *   B — the fix. Three calls proving the forced-tool shape caches instead.
 *
 * Costs about $0.05 in gpt-4o calls. Writes nothing.
 *
 *   npm run probe:prompt-cache [-- <ticket-uuid>]
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import pg from 'pg';

import { loadEnv } from './lib/sync-config.mjs';
import {
  CASE_FILE_SCHEMA,
  FINALIZE_TOOL,
  FINALIZE_TOOL_NAME,
  MISSING_FIELDS
} from '../agent/src/investigation/case-file.mjs';
import { allowedTools } from '../agent/src/investigation/investigation-rules.mjs';
import { TOOL_DEFINITIONS } from '../agent/src/investigation/tool-registry.mjs';

const env = loadEnv(process.cwd());
const MODEL = env.AGENT_INVESTIGATOR_MODEL || 'gpt-4o';
// Default is the 2-turn `order` ticket whose closing call sat at turn 2 and
// still cached 0 — the production row that proved the effect is the CALL and
// not its position in the run.
const TICKET_ID = process.argv[2] || '9c7e0421-f0b0-4e0d-81ae-7f058570b00b';

const sha = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 8);

/** The system prompt as investigate.mjs builds it, read rather than copied. */
function realSystemPrompt() {
  const src = readFileSync(
    new URL('../agent/src/investigation/investigate.mjs', import.meta.url),
    'utf8'
  );
  const open = 'const SYSTEM_PROMPT = [';
  const start = src.indexOf(open);
  const end = src.indexOf("].join('\\n');", start);
  if (start < 0 || end < 0) {
    throw new Error('SYSTEM_PROMPT not found in investigate.mjs — this probe needs updating.');
  }
  return new Function(
    'MISSING_FIELDS',
    `return [${src.slice(start + open.length, end)}].join('\\n');`
  )(MISSING_FIELDS);
}

async function call(label, body) {
  const startedAt = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const elapsedMs = Date.now() - startedAt;
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  }
  const usage = json.usage || {};
  const input = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    call: label,
    input,
    cached,
    'hit%': input ? +((100 * cached) / input).toFixed(1) : 0,
    tool_choice:
      typeof body.tool_choice === 'object' ? body.tool_choice.function.name : body.tool_choice,
    max: body.max_tokens,
    rf: sha(body.response_format),
    msgs: sha(body.messages),
    tools: sha(body.tools),
    ms: elapsedMs,
    model: json.model,
    called: json.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? null
  };
}

const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL });
await db.connect();
const { rows } = await db.query(
  `select t.id, t.subject, t.category, t.request_kind, t.level, t.shopify_order_number,
          (select m.body_text from public.ticket_messages m
             where m.ticket_id = t.id and m.direction = 'inbound'
             order by m.received_at limit 1) as text
     from public.tickets t where t.id = $1`,
  [TICKET_ID]
);
await db.end();
if (rows.length === 0) {
  throw new Error(`Ticket ${TICKET_ID} not found.`);
}
const ticket = rows[0];

const SYSTEM_PROMPT = realSystemPrompt();
const tools = allowedTools(ticket.category, ticket.request_kind, ticket.level ?? 1)
  .filter((name) => TOOL_DEFINITIONS[name])
  .map((name) => ({
    type: 'function',
    function: {
      name,
      description: TOOL_DEFINITIONS[name].description,
      parameters: TOOL_DEFINITIONS[name].parameters
    }
  }));
const toolsPlus = [...tools, FINALIZE_TOOL];

const messages = [
  { role: 'system', content: SYSTEM_PROMPT },
  {
    role: 'user',
    content: [
      `Sujet : ${ticket.subject || '(aucun)'}`,
      `Catégorie : ${ticket.category} / ${ticket.request_kind} — niveau ${ticket.level ?? '?'}`,
      '',
      'Message du client :',
      String(ticket.text || '').slice(0, 3000) || '(vide)'
    ].join('\n')
  }
];

// The shape the loop appends: an assistant tool_call, then its result.
const callId = 'call_probe000000000000001';
const firstTool = tools.some((t) => t.function.name === 'getOrderContext')
  ? 'getOrderContext'
  : tools[0].function.name;
const withHistory = [
  ...messages,
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: callId, type: 'function', function: { name: firstTool, arguments: '{}' } }]
  },
  {
    role: 'tool',
    tool_call_id: callId,
    content:
      `[t1] ${firstTool} — Commande ${ticket.shopify_order_number || '#6668'} trouvée. ` +
      'Statut de préparation : FULFILLED. Expédiée le 2026-08-14. ' +
      'Transporteur : DERET. Numéro de suivi : 6A18402931742. ' +
      'Adresse de livraison : Nantes, France. Montant total : 89,90 €. ' +
      "Aucun remboursement n'est enregistré sur cette commande."
  },
  { role: 'user', content: 'Produis maintenant le dossier à partir des éléments ci-dessus.' }
];

const responseFormat = {
  type: 'json_schema',
  json_schema: { name: 'case_file', schema: CASE_FILE_SCHEMA, strict: true }
};
const base = { model: MODEL, temperature: 0 };

console.log(`ticket ${ticket.id}  ${ticket.category}/${ticket.request_kind} L${ticket.level}`);
console.log(`model  ${MODEL}   tools ${tools.length} (+1 finalize)\n`);

// --- A: what breaks it -----------------------------------------------------
const diagnosis = [];
diagnosis.push(
  await call('1 warm (loop shape)', { ...base, max_tokens: 800, messages, tools, tool_choice: 'auto' })
);
diagnosis.push(
  await call('2 +tool history', {
    ...base, max_tokens: 800, messages: withHistory, tools, tool_choice: 'auto'
  })
);
diagnosis.push(
  await call('3 only tool_choice=none', {
    ...base, max_tokens: 800, messages: withHistory, tools, tool_choice: 'none'
  })
);
diagnosis.push(
  await call('4 production closing', {
    ...base, max_tokens: 900, messages: withHistory, tools,
    tool_choice: 'none', response_format: responseFormat
  })
);
diagnosis.push(
  await call('5 closing repeated', {
    ...base, max_tokens: 900, messages: withHistory, tools,
    tool_choice: 'none', response_format: responseFormat
  })
);
console.log('A — DIAGNOSIS: calls 2-5 share byte-identical messages and tools.');
console.table(diagnosis);
console.log(
  'Expect: 3 caches (tool_choice is innocent), 4 drops to 0 (response_format),\n' +
    '5 caches off 4 (it partitions the cache rather than breaking it).\n'
);

// --- B: what fixes it ------------------------------------------------------
const fix = [];
fix.push(
  await call('A loop t1 (+finalize)', {
    ...base, max_tokens: 800, messages, tools: toolsPlus, tool_choice: 'auto'
  })
);
fix.push(
  await call('B loop t2 (+finalize)', {
    ...base, max_tokens: 800, messages: withHistory, tools: toolsPlus, tool_choice: 'auto'
  })
);
fix.push(
  await call('C forced finalize', {
    ...base, max_tokens: 900, messages: withHistory, tools: toolsPlus,
    tool_choice: { type: 'function', function: { name: FINALIZE_TOOL_NAME } }
  })
);
console.log('B — THE FIX, as shipped: no response_format anywhere.');
console.table(fix);
console.log('Expect: C caches ~96% and returns a finalize_investigation call.');
