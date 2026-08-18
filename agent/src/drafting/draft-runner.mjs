import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';

import { brandVoiceProblem, composeSystemPrompt } from './brand-voice.mjs';
import { checksPassed, failedChecks, runDraftChecks } from './draft-checks.mjs';
import { autoSendEligible, draftDecision, replyLanguage } from './draft-rules.mjs';
import {
  DRAFT_SCHEMA,
  caseFileFromRow,
  composeDraftingMessage,
  promptInputs
} from './compose-draft.mjs';

// The drafting pass: one reply per case file that has one to write.
//
// IT MAKES NO GRAPH CALL. Input is stored rows, output is a stored row. That is
// what lets the whole quality loop — read the draft, change the prompt, run it
// again — happen without a mailbox being involved at any point, and it is why
// drafting was never blocked by the mailbox question that blocks sending.
//
// ONE FAILURE DOES NOT STOP THE PASS, same contract as forwarding: each ticket
// is drafted and stored on its own, and a model error becomes a skipped ticket
// with a reason rather than an abandoned batch.
//
// THE BRAND VOICE IS LOADED ONCE AND CHECKED BEFORE ANY WORK. It is the system
// prompt for every ticket in the run, so a missing one is a property of the run
// and not of a ticket — discovering it on ticket 40 of 91 would mean 39 drafts
// written in a voice nobody approved.

export async function runDrafting({
  store,
  draftRecord,
  openai,
  brandVoice,
  shopId,
  model,
  logger,
  limit,
  ticketId = null,
  // Rehearsal: compose everything, call the model, store nothing. The prompt is
  // the thing being iterated on, so being able to read what came back without
  // writing a row is the inner loop of this phase.
  dryRun = false,
  // Re-draft tickets that already have one, overwriting it.
  //
  // NEEDED BECAUSE THE QUEUE IS DERIVED. A ticket drops out of it the moment a
  // draft exists, which is the right default — it stops a re-run spending the
  // mid tier on replies nobody has read yet. But the whole loop of this phase is
  // "change the prompt, look at the same tickets again", and without this the
  // only way to do that was to delete rows. It also exists because a check
  // CHANGE leaves stored results describing a rule that no longer applies.
  //
  // Safe by construction: `save` upserts on (shop_id, trigger_message_id), so
  // this rewrites one row per reading rather than accumulating variants, and it
  // never touches the human columns.
  redraft = false,
  onDraft
} = {}) {
  const problem = brandVoiceProblem(brandVoice);
  if (problem) {
    throw new Error(problem);
  }

  const candidates = await store.claimable({ shopId, limit, ticketId, redraft });
  const totals = { considered: candidates.length, drafted: 0, skipped: 0, failed: 0 };
  const skippedBy = {};

  for (const candidate of candidates) {
    const { investigation, ticket, message, orderContext } = candidate;

    const decision = draftDecision({ investigation, ticket });
    if (!decision.draft) {
      totals.skipped += 1;
      skippedBy[decision.reason] = (skippedBy[decision.reason] || 0) + 1;
      continue;
    }

    const caseFile = caseFileFromRow(investigation);
    const language = replyLanguage(ticket);

    try {
      const answer = await openai.completeJson({
        model,
        system: composeSystemPrompt(brandVoice, { language }),
        user: composeDraftingMessage({ message, caseFile, orderContext, ticket }),
        schema: DRAFT_SCHEMA,
        schemaName: 'draft',
        // A support reply runs longer than any other output in this worker: the
        // case file's questions are whole sentences and the signature is two
        // lines. Truncation here is not a degraded answer, it is a reply that
        // stops mid-word, so the ceiling is set well above what a good draft
        // needs rather than at it.
        maxTokens: 1200,
        pass: 'draft',
        ticketId: ticket.id
      });

      const body = String(answer?.body || '').trim();
      if (!body) {
        totals.failed += 1;
        logger?.warn?.('draft.empty', { ticketId: ticket.id });
        continue;
      }

      const checks = runDraftChecks({
        body,
        doNotClaim: caseFile.doNotClaim,
        missing: caseFile.missing,
        verdict: investigation.verdict,
        signature: brandVoice.signature
      });
      const passed = checksPassed(checks);

      const draft = {
        ticketId: ticket.id,
        triggerMessageId: investigation.trigger_message_id,
        investigationId: investigation.id,
        sourceVerdict: investigation.verdict,
        level: ticket.level ?? null,
        language,
        subject: answer?.subject || null,
        bodyText: body,
        checks,
        checksPassed: passed,
        autoSendEligible: autoSendEligible({
          level: ticket.level,
          happiness: ticket.happiness,
          checksPassed: passed
        }),
        promptInputs: promptInputs({
          caseFile,
          orderContext,
          investigationId: investigation.id,
          model
        }),
        model
      };

      if (!dryRun) {
        await draftRecord.save(draft);
      }

      totals.drafted += 1;
      onDraft?.({ ...draft, ticket, failedChecks: failedChecks(checks) });
    } catch (error) {
      // A model failure is one ticket's problem. Recorded and stepped over, so a
      // rate limit on ticket 3 does not cost the other 88.
      totals.failed += 1;
      logger?.warn?.('draft.failed', { ticketId: ticket.id, reason: error.message });
    }
  }

  return { ...totals, skippedBy };
}

/**
 * What the drafting pass reads.
 *
 * THE QUEUE IS DERIVED, not flagged. Categorisation and investigation run off
 * `needs_*` booleans on `tickets`; a third would mean adding a column to a
 * populated table, which the baseline has none of. Instead: the case files whose
 * verdict produces text, minus the trigger messages that already have a draft.
 * Affordable because the candidate set is bounded by the case files (80 today,
 * 91 with `--include-closed`) rather than by the corpus.
 *
 * LATEST READING PER TICKET, and this is the rule that stops a backfill being
 * wrong. A thread investigated three times has three case files; drafting all
 * three would produce a reply to a message the conversation has moved past, and
 * `unique(shop_id, trigger_message_id)` would happily store every one of them.
 * Only the newest reading of each ticket is a candidate.
 */
export function createDraftingStore(supabase) {
  return {
    async claimable({ shopId, limit, ticketId = null, redraft = false }) {
      const filters = {
        shop_id: shopId,
        verdict: { operator: 'in', value: '(answerable,needs_customer_input)' }
      };
      if (ticketId) {
        filters.ticket_id = ticketId;
      }

      const investigations = await supabaseSelect(
        supabase,
        T.TICKET_INVESTIGATIONS,
        filters,
        COLUMNS.investigationForDrafting,
        { order: 'investigated_at.desc' }
      );

      // Newest first from the query, so the first row seen per ticket is the
      // one to keep.
      const latest = [];
      const seen = new Set();
      for (const row of investigations) {
        if (seen.has(row.ticket_id)) continue;
        seen.add(row.ticket_id);
        latest.push(row);
      }

      const pending = redraft ? latest : await this.undrafted(shopId, latest);
      const claimed = typeof limit === 'number' ? pending.slice(0, limit) : pending;
      if (claimed.length === 0) {
        return [];
      }

      const [tickets, messages] = await Promise.all([
        supabaseSelect(
          supabase,
          T.TICKETS,
          {
            shop_id: shopId,
            id: { operator: 'in', value: `(${claimed.map((row) => row.ticket_id).join(',')})` },
            deleted_at: { operator: 'is', value: 'null' }
          },
          COLUMNS.ticketForDrafting
        ),
        supabaseSelect(
          supabase,
          T.TICKET_MESSAGES,
          {
            id: {
              operator: 'in',
              value: `(${claimed.map((row) => row.trigger_message_id).join(',')})`
            }
          },
          COLUMNS.messageForDrafting
        )
      ]);

      const ticketById = new Map(tickets.map((row) => [row.id, row]));
      const messageById = new Map(messages.map((row) => [row.id, row]));

      return claimed
        .map((investigation) => ({
          investigation,
          ticket: ticketById.get(investigation.ticket_id),
          message: messageById.get(investigation.trigger_message_id),
          // The bundle lives on the ticket, never copied onto the case file —
          // `context_ref` is a pointer for exactly this reason.
          orderContext: ticketById.get(investigation.ticket_id)?.resolved_context || null
        }))
        // A soft-deleted ticket or a purged message drops out here rather than
        // reaching the model as an undefined.
        .filter((candidate) => candidate.ticket && candidate.message);
    },

    /** The candidates that have no draft yet, in the order they were claimed. */
    async undrafted(shopId, investigations) {
      if (investigations.length === 0) {
        return [];
      }
      const drafted = await supabaseSelect(
        supabase,
        T.TICKET_DRAFTS,
        {
          shop_id: shopId,
          trigger_message_id: {
            operator: 'in',
            value: `(${investigations.map((row) => row.trigger_message_id).join(',')})`
          }
        },
        'trigger_message_id'
      );
      const has = new Set(drafted.map((row) => row.trigger_message_id));
      return investigations.filter((row) => !has.has(row.trigger_message_id));
    }
  };
}
