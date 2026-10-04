import { supabaseSelect, supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';
import { caseTimeline } from '../../../scripts/lib/case-reply-target.mjs';
import { driftCurrentFor, orderSourcedClaims } from '../casework/change-router.mjs';

import { brandVoiceProblem, composeSystemPrompt } from './brand-voice.mjs';
import { checksPassed, failedChecks, runDraftChecks, warningChecks } from './draft-checks.mjs';
import {
  autoSendBlockers,
  closureAllowed,
  describesChase,
  draftDecision,
  PARCEL_NEEDS,
  isParcelQuestion,
  replyLanguage,
  situationKeysOf
} from './draft-rules.mjs';
import { healthTopicOf } from './health-topic.mjs';
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
  // The numbers a rule's skeleton may quote, loaded once per run by the caller.
  // Absent by default: a skeleton naming an unset parameter is dropped, which is
  // the behaviour before skeletons existed.
  parameters = new Map(),
  // Whether a cosmetovigilance draft may ever count as auto-sendable. TRUE BY
  // DEFAULT, so a caller that has not wired `config.draftOnlyCosmetovigilance`
  // still records the safe answer rather than the permissive one.
  cosmetovigilanceDraftOnly = true,
  // Situations marked « never send automatically » (`support_exemplars.never_auto_send`).
  // Null means « read them from the store », once per run; a store without the
  // read (the rehearsal's) holds none, which is how drafting behaved before.
  heldSituations = null,
  // Which rules and situations answer « where is my parcel », for the
  // tracking-number check (`isParcelQuestion`). Null means « read them from the
  // store », once per run; a store without the read falls back to the category.
  parcelScope = null,
  // Which discount codes are still offerable, loaded once per run by the caller
  // like `parameters`. Empty by default, which drops every offer rather than
  // sending a code nobody checked — the safe direction for the one field in a
  // reply that is a key rather than prose.
  offerableCodes = new Set(),
  // The articles rules pin, loaded once per run by the caller like the codes.
  // Empty by default and safe: a pin whose document is missing here is dropped,
  // which is exactly what an unapproved or deleted article looks like.
  pinnedArticles = new Map(),
  // The shop's active company policies by key, loaded once per run like the
  // articles. Empty by default and safe: the case's policies are then dropped.
  companyPolicies = new Map(),
  // Reads whether the customer's latest message closes their request.
  // ABSENT BY DEFAULT, and absence means no closure: a caller that has not
  // wired it — the rehearsal harness, every existing test — writes exactly the
  // replies it wrote before, rather than quietly shortening one.
  closureReader = null,
  // Resolves each message's sender to a role, so a colleague's note is not
  // rendered as the customer speaking. Absent means every inbound message
  // reads as « client », which is what it did before.
  senderDirectory = null,
  // WHICH GATES APPLY (stage 6). `manual`: the CLI and the rehearsal, as
  // before. `poll`: the worker, which drafts only when it is our turn to reply
  // on a case that has moved since the mailbox cutover (`pollGate`).
  gates = 'manual',
  // `sync_cursors.mail_ingest_cutover_at`; required by the poll gates (Q3).
  cutoverAt = null,
  // Count what would be drafted and call no model: the dry run before
  // DRAFT_IN_POLL is switched on (decided 2026-09-26).
  estimateOnly = false,
  onDraft
} = {}) {
  const problem = brandVoiceProblem(brandVoice);
  if (problem) {
    throw new Error(problem);
  }

  const candidates = await store.claimable({ shopId, limit, ticketId, redraft, gates, cutoverAt });
  const held =
    heldSituations ?? (candidates.length > 0 && store.heldSituations ? await store.heldSituations(shopId) : new Set());
  const parcelScopeForRun =
    parcelScope ?? (candidates.length > 0 && store.parcelScope ? await store.parcelScope(shopId) : null);
  const totals = { considered: candidates.length, drafted: 0, skipped: 0, failed: 0 };
  const skippedBy = {};
  const skip = (reason) => {
    totals.skipped += 1;
    skippedBy[reason] = (skippedBy[reason] || 0) + 1;
  };

  for (const candidate of candidates) {
    const { investigation, ticket, message, orderContext, thread = [], conversation = [], caseState = null, caseTarget } = candidate;
    const caseCurrent = candidate.caseCurrent ?? null;

    if (gates === 'poll') {
      const gate = pollGate({ caseCurrent, ticket, investigation, conversation, cutoverAt });
      if (!gate.ok) {
        skip(gate.reason);
        continue;
      }
    }

    const decision = draftDecision({ investigation, ticket, conversation, caseTarget });
    if (!decision.draft) {
      skip(decision.reason);
      continue;
    }

    // THE DRY RUN BEFORE THE SWITCH: every gate has run, no model is called.
    if (estimateOnly) {
      totals.drafted += 1;
      onDraft?.({ ticket, estimate: true, sourceVerdict: investigation.verdict, level: ticket.level ?? null, caseVersion: caseCurrent?.version ?? null });
      continue;
    }

    // ORDER CLAIMS THE ORDER HAS SINCE CONTRADICTED. When the change router found
    // the rule still holds but an order state moved (a redraft, not a new case
    // file), the case file's sentences about the order describe the order as it
    // was. They are left out, and the « Commande concernée » section — rebuilt
    // from the current bundle — states it as it is (DECISIONS § Change router).
    const staleClaims = staleOrderClaims({ ticket, investigation });
    const caseFile = withoutClaims(caseFileFromRow(investigation), staleClaims);
    const language = replyLanguage(ticket);
    // DOES THIS MESSAGE CLOSE THE CASE? The code gate runs first and costs
    // nothing: with a question outstanding or a point sitting with a colleague,
    // a customer's thanks cannot end the case, and the model is never asked.
    // Only when the dossier is clear is the message itself read — a small
    // minority of tickets, on the cheap tier.
    const closure =
      closureReader && closureAllowed(investigation)
        ? await closureReader({ message, ticketId: ticket.id, senderDirectory })
        : { closes: false, why: 'dossier non clos' };
    // Did we leave them waiting? A fact about our own conduct, computed from the
    // thread rather than inferred from the customer's tone.
    const chase = describesChase(thread);

    try {
      const answer = await openai.completeJson({
        model,
        // The verdict picks which INTENT_RULES set travels: answer, ask, or
        // only acknowledge. Sending all three would hand the model a prompt
        // that contradicts itself and let it choose.
        //
        // `closing` is the one intent the verdict does not choose, because it is
        // not a property of the dossier: the case file is `answerable` either
        // way, and what makes the reply three lines is the customer having said
        // they need nothing more.
        system: composeSystemPrompt(brandVoice, {
          language,
          verdict: investigation.verdict,
          intent: closure.closes ? 'closing' : null
        }),
        user: composeDraftingMessage({
          message, caseFile, orderContext, ticket, chase, parameters, offerableCodes,
          pinnedArticles, conversation, senderDirectory, caseState, companyPolicies,
          signature: brandVoice.signature, closingLine: brandVoice.closingLine, logger
        }),
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
        chased: chase.chased,
        closingLine: brandVoice.closingLine,
        signature: brandVoice.signature,
        // The signature check needs it: the approved wording is French, so on a
        // reply in another language it should have been translated rather than
        // reproduced, and "reproduced" is the failure.
        language,
        // The parcels we are already holding, and the subject that says whether
        // the customer asked about them. Read from the same bundle the prompt
        // was built from, so the check cannot ask for a number the model was
        // never given.
        parcels: orderContext?.order?.delivery?.tracking || [],
        category: ticket.category,
        // Whether the reply answers « where is my parcel »: only then is the
        // number we hold owed to the customer.
        parcelQuestion: isParcelQuestion({ exemplarMatch: investigation.exemplar_match, caseState, scope: parcelScopeForRun }),
        // The link the prompt described, so the check cannot demand a marker the
        // model was never told to write.
        replyLink: caseFile.link,
        closing: closure.closes
      });
      const passed = checksPassed(checks);
      const blockers = autoSendBlockers({
        level: ticket.level,
        happiness: ticket.happiness,
        checksPassed: passed,
        verdict: investigation.verdict,
        category: ticket.category,
        cosmetovigilanceDraftOnly,
        // What the customer wrote, never the draft: see health-topic.mjs.
        healthTerms: healthTopicOf({ conversation, message, triggerMessageId: investigation.trigger_message_id }),
        heldSituations: situationKeysOf({ exemplarMatch: investigation.exemplar_match, caseState }).filter((key) =>
          held.has(key)
        )
      });

      const draft = {
        ticketId: ticket.id,
        triggerMessageId: investigation.trigger_message_id,
        // The case version this reply answers, and the message that produced it
        // (stage 6). Null from a caller with no fold, like the rehearsal.
        caseVersion: caseCurrent?.version ?? null,
        triggerEventId: caseCurrent?.as_of_message_id ?? null,
        investigationId: investigation.id,
        sourceVerdict: investigation.verdict,
        // Derived by draftDecision from the verdict and the case file's
        // handoff, and carried here rather than recomputed at send time: it
        // decides whether sending closes the ticket.
        disposition: decision.disposition,
        level: ticket.level ?? null,
        language,
        subject: answer?.subject || null,
        bodyText: body,
        // Copied now, so the [[marker]] keeps pointing where it was written to.
        replyLink: caseFile.link ?? null,
        checks,
        checksPassed: passed,
        autoSendEligible: blockers.length === 0,
        autoSendBlockers: blockers,
        promptInputs: {
          ...promptInputs({
            closure,
            caseFile,
            orderContext,
            investigationId: investigation.id,
            model,
            companyPolicies,
            parameters
          }),
          // So a reviewer can see the case file was not read whole.
          ...(staleClaims.length > 0 ? { dropped_order_claims: staleClaims.length } : {})
        },
        model
      };

      if (!dryRun) {
        await draftRecord.save(draft);
      }

      totals.drafted += 1;
      onDraft?.({ ...draft, ticket, failedChecks: failedChecks(checks), warnings: warningChecks(checks) });
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
 * The worker's gates (stage 6 of codex_plans/Case_State_Plan.md). A draft is
 * written in the poll only when every one holds; the first that fails is the
 * reason counted.
 *
 *   not_folded             no `case_current` row yet: the fold runs first
 *   not_our_turn           `next_actor` is not support (the customer, a colleague
 *                          or Deret owes the next step, or nobody does)
 *   pass_pending           the categoriser or the investigation still owes a pass
 *   not_open               resolved, closed, forwarded or spam
 *   stale_case_file        the case file answers an older message than the
 *                          customer's latest
 *   before_cutover         the message answered predates the mailbox cutover (Q3):
 *                          the imported history is never drafted to
 *   not_customer_trigger   the message answered is not the customer's
 *
 * `draftDecision`'s own skips (already answered, duplicate, level 4…) follow.
 */
export function pollGate({ caseCurrent, ticket, investigation, conversation = [], cutoverAt }) {
  if (!caseCurrent) return { ok: false, reason: 'not_folded' };
  if (caseCurrent.next_actor !== 'support') return { ok: false, reason: 'not_our_turn' };
  if (ticket?.needs_categorisation || ticket?.needs_investigation) return { ok: false, reason: 'pass_pending' };
  if (!['open', 'awaiting_human'].includes(ticket?.status)) return { ok: false, reason: 'not_open' };

  const trigger = conversation.find((message) => message?.id === investigation?.trigger_message_id) ?? null;
  const time = (message) => Date.parse(message?.received_at ?? message?.sent_at ?? '') || 0;
  const latestCustomer = conversation
    .filter((message) => message?.actor === 'customer' || (!message?.actor && message?.direction === 'inbound'))
    .reduce((latest, message) => (!latest || time(message) > time(latest) ? message : latest), null);
  if (latestCustomer && trigger && time(latestCustomer) > time(trigger)) return { ok: false, reason: 'stale_case_file' };

  const cutover = Date.parse(cutoverAt ?? '');
  if (!Number.isFinite(cutover) || !trigger || time(trigger) < cutover) return { ok: false, reason: 'before_cutover' };
  if (trigger.actor !== 'customer') return { ok: false, reason: 'not_customer_trigger' };
  return { ok: true, reason: null };
}

/**
 * The case file's established claims the order has moved past: only when the
 * ticket carries a drift measured against THIS case file (a newer case file was
 * written from the new order and holds), and only the claims resting on the
 * order bundle alone (`orderSourcedClaims`).
 */
export function staleOrderClaims({ ticket, investigation }) {
  if (!driftCurrentFor(ticket?.fact_drift, investigation)) return [];
  return orderSourcedClaims(investigation);
}

/** The case file without these claims, compared by identity. */
export function withoutClaims(caseFile, claims) {
  if (claims.length === 0) return caseFile;
  const drop = new Set(claims.map((claim) => claim?.claim));
  return { ...caseFile, established: caseFile.established.filter((entry) => !drop.has(entry?.claim)) };
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
/**
 * Which readings still need a draft: none yet, or only a pending one written
 * before its case file.
 *
 * THE SECOND HALF IS A RE-INVESTIGATION OF THE SAME MESSAGE. The case file is
 * rewritten in place — same row, same trigger — so keyed on the message alone
 * the old draft counted as done and kept asking for an order number the new
 * case file had (ticket `fcf4ca11`, #6669). An order confirmed after the
 * investigation is what queues one (`reinvestigationColumns`).
 *
 * PENDING ONLY. A draft a person approved, edited, rejected or sent is theirs;
 * `save` would keep its status but replace the text they decided on.
 */
export function needingDraft(investigations = [], drafts = [], versions = new Map()) {
  const olderThanCaseFile = (row, draft) => {
    const investigated = Date.parse(row.investigated_at || '');
    const drafted = Date.parse(draft.drafted_at || '');
    return Number.isFinite(investigated) && Number.isFinite(drafted) && investigated > drafted;
  };
  // A stale draft answers a case that has moved: it never stands for the current one.
  const live = drafts.filter((row) => row.status !== 'stale');
  return investigations.filter((row) => {
    // STAGE 6: ONE DRAFT PER CASE VERSION. With a fold, the question is whether
    // this version has one. A draft from before versions (none recorded) on the
    // same message still counts, so the switch does not redraft history.
    const version = versions.get(row.ticket_id);
    if (version !== undefined && version !== null) {
      const exact = live.find((draft) => draft.ticket_id === row.ticket_id && draft.case_version === version);
      if (exact) return exact.status === 'pending' && olderThanCaseFile(row, exact);
      const legacy = live.find(
        (draft) => (draft.case_version ?? null) === null && draft.trigger_message_id === row.trigger_message_id
      );
      if (legacy) return legacy.status === 'pending' && olderThanCaseFile(row, legacy);
      return true;
    }
    const draft = live.find((candidate) => candidate.trigger_message_id === row.trigger_message_id);
    if (!draft) return true;
    if (draft.status !== 'pending') return false;
    return olderThanCaseFile(row, draft);
  });
}

/** Ids per `in.()` request: the list travels in the URL (the HTTP 414 of 2026-09-27). */
const ID_BATCH = 100;

async function selectInBatches(supabase, table, column, ids, filters, columns, options) {
  const unique = [...new Set(ids.filter(Boolean))];
  const pages = [];
  for (let index = 0; index < unique.length; index += ID_BATCH) {
    const batch = unique.slice(index, index + ID_BATCH);
    pages.push(
      supabaseSelect(supabase, table, { ...filters, [column]: { operator: 'in', value: `(${batch.join(',')})` } }, columns, options)
    );
  }
  return (await Promise.all(pages)).flat();
}

/**
 * The message a case's reply goes to, or null when nothing is owed; undefined
 * when the case's target has never been computed, which turns the case gate
 * off rather than refusing every draft.
 */
export function caseTargetOf(caseRow) {
  if (!caseRow || !caseRow.target_computed_at) return undefined;
  return caseRow.latest_actionable_inbound_message_id ?? null;
}

export function createDraftingStore(supabase, { caseStateStore = null } = {}) {
  return {
    /** The situations marked « never send automatically », as a Set of keys. */
    async heldSituations(shopId) {
      const rows = await supabaseSelect(
        supabase,
        T.SUPPORT_EXEMPLARS,
        { shop_id: shopId, never_auto_send: true, deleted_at: { operator: 'is', value: 'null' } },
        'exemplar_key'
      );
      return new Set((rows || []).map((row) => row.exemplar_key));
    },

    /**
     * The live rules that branch on where the parcel is, and the situations that
     * declare it, for `isParcelQuestion`. Read from the rules and situations the
     * business wrote, so nothing here names a key.
     */
    async parcelScope(shopId) {
      const [rules, situations] = await Promise.all([
        supabaseSelect(
          supabase,
          T.SUPPORT_ANSWERS,
          { shop_id: shopId, approval_status: 'approved', deleted_at: { operator: 'is', value: 'null' } },
          'answer_set,answer_key,when_conditions'
        ),
        supabaseSelect(
          supabase,
          T.SUPPORT_EXEMPLARS,
          { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
          'exemplar_key,requirement_needs'
        )
      ]);
      const readsParcel = (needs) => needs.some((need) => PARCEL_NEEDS.includes(need));
      return {
        parcelRules: new Set(
          (rules || [])
            .filter((row) => readsParcel(Object.keys(row.when_conditions || {})))
            .map((row) => `${row.answer_set}/${row.answer_key}`)
        ),
        parcelSituations: new Set(
          (situations || []).filter((row) => readsParcel(row.requirement_needs || [])).map((row) => row.exemplar_key)
        )
      };
    },

    async claimable({ shopId, limit, ticketId = null, redraft = false, gates = 'manual', cutoverAt = null }) {
      const filters = {
        shop_id: shopId,
        // All three verdicts produce text now. `needs_human` gets an
        // acknowledgement rather than an answer — see DRAFTABLE_VERDICTS.
        verdict: { operator: 'in', value: '(answerable,needs_customer_input,needs_human)' }
      };
      if (ticketId) {
        filters.ticket_id = ticketId;
      }

      // THE POLL STARTS FROM THE CASES, NOT THE CASE FILES. Every case file in
      // the shop, with its jsonb, on every poll would be the worker's heaviest
      // read for a handful of tickets. `case_current` narrows it first: our
      // turn, and something new since the mailbox cutover. `pollGate` then
      // checks each one properly; this only has to be a superset.
      let caseRows = null;
      if (gates === 'poll') {
        const cutover = Date.parse(cutoverAt ?? '');
        if (!Number.isFinite(cutover)) return [];
        caseRows = await supabaseSelectAll(
          supabase,
          T.CASE_CURRENT,
          {
            shop_id: shopId,
            next_actor: 'support',
            as_of_at: { operator: 'gte', value: new Date(cutover).toISOString() },
            ...(ticketId ? { ticket_id: ticketId } : {})
          },
          'ticket_id,version,next_actor,as_of_message_id,as_of_at',
          { order: 'ticket_id.asc' }
        );
        if (caseRows.length === 0) return [];
      }

      const investigations = caseRows
        ? await selectInBatches(
            supabase,
            T.TICKET_INVESTIGATIONS,
            'ticket_id',
            caseRows.map((row) => row.ticket_id),
            filters,
            COLUMNS.investigationForDrafting,
            { order: 'investigated_at.desc' }
          )
        : await supabaseSelect(supabase, T.TICKET_INVESTIGATIONS, filters, COLUMNS.investigationForDrafting, {
            order: 'investigated_at.desc'
          });
      // Batches each come back newest first; the per-ticket pick below needs it overall.
      investigations.sort((a, b) => String(b.investigated_at ?? '').localeCompare(String(a.investigated_at ?? '')));

      // Newest first from the query, so the first row seen per ticket is the
      // one to keep.
      //
      // `handoff` IS REDUCED TO A BOOLEAN HERE, at the boundary, and that is the
      // whole reason this loop rewrites the row rather than passing it through.
      // The disposition needs to know WHETHER a human owes an action; the text
      // of what they owe is internal — « rembourser le client et relancer le
      // transporteur » — and the drafting projection excludes it precisely so it
      // cannot be rendered into a reply. Selecting the column and dropping its
      // contents one line later keeps both: the derivation gets its answer, and
      // no internal prose ever reaches the runner, let alone the prompt.
      const latest = [];
      const seen = new Set();
      for (const row of investigations) {
        if (seen.has(row.ticket_id)) continue;
        seen.add(row.ticket_id);
        latest.push({ ...row, handoff: Boolean(row.handoff) });
      }

      // The case each ticket is at, when a fold exists: the version a draft is
      // written against, and the next actor the poll gate reads.
      const caseByTicket = new Map(
        (caseRows ??
          (await selectInBatches(
            supabase,
            T.CASE_CURRENT,
            'ticket_id',
            latest.map((row) => row.ticket_id),
            { shop_id: shopId },
            'ticket_id,version,next_actor,as_of_message_id,as_of_at'
          ))
        ).map((row) => [row.ticket_id, row])
      );
      const versions = new Map([...caseByTicket].map(([id, row]) => [id, row.version]));

      const pending = redraft ? latest : await this.undrafted(shopId, latest, versions);
      const claimed = typeof limit === 'number' ? pending.slice(0, limit) : pending;
      if (claimed.length === 0) {
        return [];
      }

      const [tickets, messages, envelopes] = await Promise.all([
        selectInBatches(
          supabase,
          T.TICKETS,
          'id',
          claimed.map((row) => row.ticket_id),
          { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
          COLUMNS.ticketForDrafting
        ),
        selectInBatches(supabase, T.TICKET_MESSAGES, 'id', claimed.map((row) => row.trigger_message_id), {}, COLUMNS.messageForDrafting),
        // THE WHOLE THREAD, BOTH DIRECTIONS, WITH BODIES.
        //
        // This read was envelopes only — directions and timestamps — and
        // answered one question: was the customer left waiting
        // (`describesChase`). It still answers it; the extra columns cost that
        // question nothing and buy the one nothing in this pipeline could
        // answer before, which is what we have already told this customer.
        selectInBatches(supabase, T.TICKET_MESSAGES, 'ticket_id', claimed.map((row) => row.ticket_id), {}, COLUMNS.threadForDrafting)
      ]);

      // WHAT THE LAST READING LEFT: which questions are answered, which are
      // still out, what we promised. One read for the batch, newest first so
      // the row kept per ticket is the most recent.
      const caseStateByTicket = new Map();
      if (caseStateStore) {
        const readings = await caseStateStore.forTickets(claimed.map((row) => row.ticket_id));
        for (const row of readings) {
          if (!caseStateByTicket.has(row.ticket_id)) caseStateByTicket.set(row.ticket_id, row);
        }
      }

      const ticketById = new Map(tickets.map((row) => [row.id, row]));
      const messageById = new Map(messages.map((row) => [row.id, row]));
      const threadByTicket = new Map();
      for (const envelope of envelopes) {
        const thread = threadByTicket.get(envelope.ticket_id) || [];
        thread.push(envelope);
        threadByTicket.set(envelope.ticket_id, thread);
      }
      // THE CASE, NOT ONLY THE THREAD (61_cases.sql). A customer who writes
      // again under a new conversation id is in the same case, and the draft is
      // written with every thread of it in view: what we already said on the
      // first thread, whether we left them waiting across both (`describesChase`
      // reads the merged rows, which is what the related-ticket merge did before
      // it), and whether a reply on the other thread already answered them
      // (`answeredSince`). This replaces the related-ticket merge: the related
      // link is no longer written, a link between threads is the case.
      //
      // Each row keeps its `ticket_id`, so the prompt marks the other threads.
      const caseIds = [...new Set(tickets.map((row) => row.case_id).filter(Boolean))];
      const caseById = new Map();
      if (caseIds.length > 0) {
        const [caseRows, siblings] = await Promise.all([
          selectInBatches(supabase, T.CASES, 'id', caseIds, { shop_id: shopId }, 'id,latest_actionable_inbound_message_id,reply_thread_id,target_computed_at'),
          selectInBatches(supabase, T.TICKETS, 'case_id', caseIds, { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } }, 'id,case_id,subject')
        ]);
        for (const row of caseRows) caseById.set(row.id, row);
        const claimedIds = new Set(claimed.map((row) => row.ticket_id));
        const otherIds = siblings.filter((row) => !claimedIds.has(row.id)).map((row) => row.id);
        const otherMessages = otherIds.length
          ? await selectInBatches(supabase, T.TICKET_MESSAGES, 'ticket_id', otherIds, {}, COLUMNS.threadForDrafting)
          : [];
        const messagesByTicket = new Map(threadByTicket);
        for (const row of otherMessages) {
          const list = messagesByTicket.get(row.ticket_id) || [];
          list.push(row);
          messagesByTicket.set(row.ticket_id, list);
        }
        const threadsByCase = new Map();
        for (const row of siblings) {
          const list = threadsByCase.get(row.case_id) || [];
          list.push(row.id);
          threadsByCase.set(row.case_id, list);
        }
        for (const ticket of tickets) {
          const ids = threadsByCase.get(ticket.case_id) || [];
          if (ids.length < 2) continue;
          threadByTicket.set(ticket.id, caseTimeline(ids.flatMap((id) => messagesByTicket.get(id) || [])));
        }
      }
      const conversationByTicket = threadByTicket;

      return claimed
        .map((investigation) => ({
          investigation,
          ticket: ticketById.get(investigation.ticket_id),
          message: messageById.get(investigation.trigger_message_id),
          // The bundle lives on the ticket, never copied onto the case file —
          // `context_ref` is a pointer for exactly this reason.
          orderContext: ticketById.get(investigation.ticket_id)?.resolved_context || null,
          thread: threadByTicket.get(investigation.ticket_id) || [],
          // The last reading of this case, if the casework pass has made one.
          // Absent on a first message and on any thread it has not read, which
          // renders no block and leaves the prompt exactly as it was.
          caseState: caseStateByTicket.get(investigation.ticket_id) || null,
          conversation: conversationByTicket.get(investigation.ticket_id) || [],
          // Where the case's reply goes. `undefined` when the case's target was
          // never computed (`cases:targets` not run yet): no case gate then,
          // rather than every draft refused.
          caseTarget: caseTargetOf(caseById.get(ticketById.get(investigation.ticket_id)?.case_id)),
          // `case_current`: the version this draft is written against (stage 6).
          caseCurrent: caseByTicket.get(investigation.ticket_id) || null
        }))
        // A soft-deleted ticket or a purged message drops out here rather than
        // reaching the model as an undefined.
        .filter((candidate) => candidate.ticket && candidate.message);
    },

    /** The candidates that still need a draft for their case version, in the order they were claimed. */
    async undrafted(shopId, investigations, versions = new Map()) {
      if (investigations.length === 0) {
        return [];
      }
      const drafted = await selectInBatches(
        supabase,
        T.TICKET_DRAFTS,
        'ticket_id',
        investigations.map((row) => row.ticket_id),
        { shop_id: shopId },
        'ticket_id,trigger_message_id,case_version,status,drafted_at'
      );
      return needingDraft(investigations, drafted, versions);
    }
  };
}
