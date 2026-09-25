import { createSupabaseClient, supabaseSelect } from '../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../scripts/lib/tables.mjs';
import { createTicketRecord } from '../../scripts/lib/ticket-record.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { logger } from '../src/lib/logger.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';
import { createOpenAIClient } from '../src/llm/openai-client.mjs';
import { readCase } from '../src/casework/case-manager.mjs';
import { readsAsClosure } from '../src/casework/closure.mjs';
import { closureAllowed } from '../src/drafting/draft-rules.mjs';
import { createSenderDirectoryStore, senderRole } from '../src/ingestion/sender-directory.mjs';

import { CASEWORK_CASES } from './casework-cases.mjs';
import { threadUpTo } from './casework-cuts.mjs';
import { CUSTOMER_QUESTIONS } from './casework-vocabulary.mjs';
import { PIPELINE_NEXT_ACTIONS, compare, expectedRelationship, pipelineNextAction, tally } from './score-casework.mjs';

// Scores today's pipeline against the multi-turn labelled set.
//
//   npm run eval:casework
//   npm run eval:casework -- --repeat 3     # the model fields, asked three times
//   npm run eval:casework -- --show         # every cut, not only disagreements
//
// WHAT IS SCORED, per inbound cut: the Case Manager's reading of the message
// (`effect`, and which of our questions it `answered`), and what the pipeline
// then does (`nextAction` — draft skip, closing reply or full reply). Outbound
// cuts, `caseState` and `waitingInternal` are COUNTED, not scored: nothing in
// the pipeline reads our mail or holds a case state, so every one of them is
// work not yet built, and the report says how much.
//
// EACH CUT STARTS FROM THE LABELS, NOT FROM THE MODEL'S OWN PREVIOUS ANSWER.
// The questions carried into a cut are the labeller's `waitingCustomer` from the
// cut before it, so one wrong reading is one failure rather than a thread of
// them. The investigation is not re-run: its tools answer as of today, and a
// July order reads as months late now.
//
// NOTHING GATES YET. This is a baseline; the exit code is always 0 until a
// threshold is agreed. IT WRITES NOTHING, and records no `llm_usage`, like
// `eval:closure`.

const args = process.argv.slice(2);
const show = args.includes('--show');
const repeat = Math.max(1, Number(value('--repeat')) || 1);

function value(flag) {
  const index = args.indexOf(flag);
  return index === -1 || index === args.length - 1 ? undefined : args[index + 1];
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  if (!config.openaiApiKey || !config.caseworkModel) {
    console.error('OPENAI_API_KEY and a non-empty AGENT_CASEWORK_MODEL are required.');
    process.exitCode = 1;
    return;
  }

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const record = createTicketRecord(supabase, { shopId });
  const openai = createOpenAIClient({ apiKey: config.openaiApiKey });
  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.graph.mailbox
  });

  const ticketIds = [...new Set(CASEWORK_CASES.map((row) => row.ticketId))];
  const tickets = new Map(
    (
      await supabaseSelect(
        supabase,
        T.TICKETS,
        { shop_id: shopId, id: { operator: 'in', value: `(${ticketIds.join(',')})` } },
        'id,subject,category,request_kind,sender_label,duplicate_of_ticket_id,level'
      )
    ).map((row) => [row.id, row])
  );

  const investigations = await supabaseSelect(
    supabase,
    T.TICKET_INVESTIGATIONS,
    { shop_id: shopId, ticket_id: { operator: 'in', value: `(${ticketIds.join(',')})` } },
    'ticket_id,trigger_message_id,verdict,missing,handoff'
  );

  const scored = [];
  const counted = { outbound: 0, caseState: 0, waitingInternal: 0 };
  const missing = [];

  for (const ticketId of ticketIds) {
    const ticket = tickets.get(ticketId);
    const conversation = ticket ? await record.conversation(ticketId, { columns: COLUMNS.threadForDrafting }) : [];
    const position = new Map(conversation.map((message, index) => [message.id, index]));
    const cases = CASEWORK_CASES.filter((row) => row.ticketId === ticketId)
      .map((row) => ({ ...row, index: position.get(row.messageId) }))
      .sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));

    const runs = investigations
      .filter((run) => run.ticket_id === ticketId)
      .map((run) => ({ ...run, index: position.get(run.trigger_message_id) ?? Infinity }));

    let carried = [];
    for (const row of cases) {
      if (row.caseState) counted.caseState += 1;
      if (row.waitingInternal.length) counted.waitingInternal += 1;
      if (row.index === undefined) {
        missing.push(row.messageId);
        continue;
      }
      if (row.direction === 'outbound') {
        counted.outbound += 1;
        carried = row.waitingCustomer;
        continue;
      }

      const thread = threadUpTo(conversation, row.index);
      const message = thread.at(-1);
      // The case file drafting would have read at this message: the newest one
      // triggered by it or by an earlier message. None yet means the gate is
      // unknown, and `pipelineNextAction` takes it as open.
      const caseFile = runs.filter((run) => run.index <= row.index).sort((a, b) => a.index - b.index).at(-1);
      const gateOpen = caseFile ? closureAllowed(caseFile) : null;
      const reads = [];
      for (let attempt = 0; attempt < repeat; attempt += 1) {
        const reading = await readCase({
          openai,
          model: config.caseworkModel,
          ticket,
          message,
          conversation: thread,
          pendingInputs: carried,
          senderDirectory,
          logger
        });
        const closure = config.closureModel
          ? await readsAsClosure({ openai, model: config.closureModel, message, senderDirectory, logger, ticketId })
          : { closes: false };
        reads.push({
          effect: reading.caseRelationship,
          answered: reading.resolvedInputs,
          ...(({ action, why }) => ({ nextAction: action, why }))(
            pipelineNextAction({ ticket, closes: closure.closes, gateOpen })
          ),
          failed: reading.failed
        });
      }

      const expectedEffect = expectedRelationship(row.effect);
      // `answered` is scored only where there was something to answer: with no
      // question outstanding both sides are trivially empty, and counting those
      // would pad the agreement with cuts that tested nothing.
      const customerAnswered = row.answered.filter((key) => Object.hasOwn(CUSTOMER_QUESTIONS, key));
      const answerable = carried.length > 0 || customerAnswered.length > 0;

      const outcomes = reads.map((read) => ({
        effect: compare(expectedEffect ?? row.effect, read.effect, { expressible: expectedEffect !== null }),
        answered: answerable ? compare(customerAnswered, read.answered) : 'unlabelled',
        nextAction: compare(row.nextAction, read.nextAction, {
          expressible: PIPELINE_NEXT_ACTIONS.includes(row.nextAction)
        })
      }));
      // A cut counts as agreeing on a field only if every attempt agreed; the
      // disagreeing read is the one reported.
      const worst = outcomes.find((o) => Object.values(o).includes('disagree')) ?? outcomes[0];
      const unstable = Object.keys(worst).filter((field) => new Set(outcomes.map((o) => o[field])).size > 1);
      const shown = reads[outcomes.indexOf(worst)];

      scored.push({
        row,
        role: senderRole(message, senderDirectory),
        outcome: worst,
        got: shown,
        unstable,
        carried
      });
      carried = row.waitingCustomer;
    }
  }

  report({ scored, counted, missing });
}

function report({ scored, counted, missing }) {
  const totals = tally(scored.map((s) => s.outcome));
  console.log(`\nCasework — ${CASEWORK_CASES.length} messages étiquetés, ${scored.length} reçus notés · ${repeat} passage(s)\n`);
  console.log('champ        accord  désaccord  inexprimable  non étiqueté');
  for (const [field, t] of Object.entries(totals)) {
    console.log(
      `${field.padEnd(12)} ${String(t.agree).padStart(6)} ${String(t.disagree).padStart(10)} ${String(t.inexpressible).padStart(13)} ${String(t.unlabelled).padStart(13)}`
    );
  }
  console.log(
    `\nPas encore lus par le pipeline : ${counted.outbound} messages envoyés · ${counted.caseState} états de dossier · ` +
      `${counted.waitingInternal} vérifications internes attendues`
  );
  const unstable = scored.filter((s) => s.unstable.length);
  if (repeat > 1) console.log(`Instables sur ${repeat} passages : ${unstable.length}`);
  if (missing.length) console.log(`⚠ ${missing.length} message(s) introuvable(s) dans leur fil : ${missing.map((id) => id.slice(0, 8)).join(', ')}`);

  console.log('');
  for (const s of scored) {
    const bad = Object.entries(s.outcome).filter(([, o]) => o === 'disagree' || o === 'inexpressible');
    if (!show && bad.length === 0) continue;
    const parts = ['effect', 'answered', 'nextAction']
      .filter((field) => show || ['disagree', 'inexpressible'].includes(s.outcome[field]))
      .map((field) => {
        const expected = field === 'answered' ? `[${s.row.answered.join(',')}]` : s.row[field];
        const got = field === 'answered' ? `[${s.got.answered.join(',')}]` : s.got[field];
        const mark = s.outcome[field] === 'agree' ? '·' : s.outcome[field] === 'inexpressible' ? '∅' : '✗';
        const why = field === 'nextAction' && s.got.why ? ` (${s.got.why})` : '';
        return `${mark} ${field} attendu ${expected} / obtenu ${got}${why}`;
      });
    console.log(`${s.row.ticketId.slice(0, 8)} ${s.row.messageId.slice(0, 8)} ${s.role.padEnd(9)} ${parts.join(' · ')}${s.unstable.length ? ' (instable)' : ''}`);
    if (s.row.note) console.log(`      note : ${s.row.note}`);
  }
}
