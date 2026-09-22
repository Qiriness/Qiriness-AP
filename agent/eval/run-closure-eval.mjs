import { createSupabaseClient, supabaseSelect } from '../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../scripts/lib/tables.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { logger } from '../src/lib/logger.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';
import { createOpenAIClient } from '../src/llm/openai-client.mjs';
import { readsAsClosure } from '../src/casework/closure.mjs';
import { closureAllowed } from '../src/drafting/draft-rules.mjs';
import { createSenderDirectoryStore } from '../src/ingestion/sender-directory.mjs';

import { CLOSURE_CASES } from './closure-cases.mjs';

// Scores closure detection over every thread where a customer wrote after our
// reply — all 16 as of 2026-09-21, the whole population rather than a sample.
//
//   npm run eval:closure
//   npm run eval:closure -- --show    # the message and the model's reason
//
// THE TWO FAILURE MODES ARE NOT WORTH THE SAME, and the report keeps them apart
// rather than printing one accuracy figure. A missed closure sends a full reply
// to somebody who wanted a line — mildly annoying, and the reviewer sees it. A
// FALSE closure sends three lines to somebody who needed help, and reads as a
// brush-off. Recall is a nuisance; precision is the thing that can hurt.
//
// IT WRITES NOTHING. Case files and drafts are read, never re-run.
//
// THE LABELS ARE THE AUTHOR'S OWN — see `closure-cases.mjs`. Read the score as a
// regression signal, not as an accuracy claim.

const args = process.argv.slice(2);
const show = args.includes('--show');
// HOW OFTEN THE SAME QUESTION IS ASKED, because one clean run is not a result.
// `fcf4ca11` was first measured wrong, fixed by a prompt change, then read
// correctly six times out of seven — and the seventh is the one that matters.
// A single pass of this eval would have reported either 16/16 or 15/16 and both
// would have been true. Repetition turns that into a rate.
const repeat = Math.max(1, Number(parseValue(args, '--repeat')) || 1);

function parseValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 || index === argv.length - 1 ? undefined : argv[index + 1];
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  if (!config.openaiApiKey) {
    console.error('OPENAI_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }
  if (!config.closureModel) {
    console.error('AGENT_CLOSURE_MODEL is empty — closure detection is switched off.');
    process.exitCode = 1;
    return;
  }

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const openai = createOpenAIClient({ apiKey: config.openaiApiKey });
  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.graph.mailbox
  });

  const ids = CLOSURE_CASES.map((c) => c.ticketId);
  const investigations = await supabaseSelect(
    supabase,
    T.TICKET_INVESTIGATIONS,
    { shop_id: shopId, ticket_id: { operator: 'in', value: `(${ids.join(',')})` } },
    'ticket_id,trigger_message_id,verdict,missing,handoff'
  );
  const byTicket = new Map(investigations.map((row) => [row.ticket_id, row]));

  const messages = await supabaseSelect(
    supabase,
    T.TICKET_MESSAGES,
    {
      shop_id: shopId,
      id: { operator: 'in', value: `(${investigations.map((r) => r.trigger_message_id).join(',')})` }
    },
    'id,body_text,direction,from_email'
  );
  const byMessage = new Map(messages.map((row) => [row.id, row]));

  const results = [];
  for (const testCase of CLOSURE_CASES) {
    const investigation = byTicket.get(testCase.ticketId);
    if (!investigation) {
      results.push({ ...testCase, missingRow: true });
      continue;
    }
    const gate = closureAllowed(investigation);
    // The model is asked ONLY where the gate opens — the same order production
    // uses. Asking it everywhere would score a question production never puts.
    const reads = [];
    for (let attempt = 0; attempt < (gate ? repeat : 1); attempt += 1) {
      reads.push(
        gate
          ? await readsAsClosure({
              openai,
              model: config.closureModel,
              message: byMessage.get(investigation.trigger_message_id),
          senderDirectory,
              ticketId: testCase.ticketId,
              logger
            })
          : { closes: false, why: 'dossier non clos (garde-fou code)' }
      );
    }

    // THE WORST ANSWER IS THE ONE REPORTED, not the majority. A closure that
    // fires once in seven runs still reaches a customer once in seven.
    const agreed = reads.filter((r) => r.closes === testCase.expectedClosure).length;
    const worst = reads.find((r) => r.closes !== testCase.expectedClosure) || reads[0];

    results.push({
      ...testCase,
      gate,
      closes: worst.closes,
      why: worst.why,
      attempts: reads.length,
      agreed,
      verdict: investigation.verdict
    });
  }

  report(results, show);
}

function report(results, show) {
  const scored = results.filter((r) => !r.missingRow);
  const unstable = scored.filter((r) => r.attempts > 1 && r.agreed !== r.attempts);

  // The gate's own job: did it open exactly where the labels say it should?
  const gateWrong = scored.filter((r) => r.gateOpen === false && r.gate === true);
  // What production would actually do, which is the number that matters.
  const falseClosures = scored.filter((r) => r.closes && !r.expectedClosure);
  const missed = scored.filter((r) => !r.closes && r.expectedClosure);
  const right = scored.filter((r) => r.closes === r.expectedClosure);

  for (const r of scored) {
    const mark = r.closes === r.expectedClosure ? '·' : '✗';
    console.log(
      `${mark} ${r.ticketId.slice(0, 8)} | ${String(r.verdict).padEnd(21)} | porte ${r.gate ? 'OUVERTE' : 'fermée '} ` +
        `| clôture ${String(r.closes).padEnd(5)} attendu ${String(r.expectedClosure).padEnd(5)}` +
        `${r.attempts > 1 ? ` | ${r.agreed}/${r.attempts} d'accord` : ''}`
    );
    if (show || r.closes !== r.expectedClosure) {
      console.log(`    ${r.note}`);
      if (r.gate) console.log(`    modèle : ${r.why}`);
    }
  }

  console.log(
    `\n${right.length}/${scored.length} d'accord avec l'étiquette` +
      `${results.length !== scored.length ? ` · ${results.length - scored.length} sans dossier` : ''}`
  );
  console.log(`FAUSSES CLÔTURES : ${falseClosures.length} — le mode d'échec qui blesse`);
  console.log(`clôtures manquées : ${missed.length} — le relecteur les voit`);
  console.log(
    `garde-fou code : ${scored.filter((r) => !r.gate).length}/${scored.length} arrêtés sans appel modèle` +
      `${gateWrong.length ? ` · ${gateWrong.length} auraient dû être arrêtés` : ''}`
  );
  if (repeat > 1) {
    console.log(
      `instables sur ${repeat} passages : ${unstable.length}` +
        `${unstable.length ? ' — ' + unstable.map((r) => `${r.ticketId.slice(0, 8)} ${r.agreed}/${r.attempts}`).join(' · ') : ''}`
    );
  }

  // A false closure is the one outcome worth failing a command over: it is the
  // reply a customer reads as a brush-off.
  if (falseClosures.length > 0) process.exitCode = 1;
}
