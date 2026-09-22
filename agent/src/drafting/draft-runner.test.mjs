import assert from 'node:assert/strict';
import test from 'node:test';

import { CAVEATS } from '../investigation/case-file.mjs';
import { needingDraft, runDrafting } from './draft-runner.mjs';

const SIGNATURE = 'Bien cordialement,\nService Client Qiriness';

const VOICE = {
  approvalStatus: 'approved',
  roleDescription: 'Vous êtes l’agent de rédaction du Service Client Qiriness.',
  toneAndVoice: 'Professionnel et concis.',
  responseFramework: [],
  guidelinesAndGuardrails: [],
  signature: SIGNATURE,
  generalContext: ''
};

const CANDIDATE = {
  investigation: {
    id: 'investigation-1',
    ticket_id: 'ticket-1',
    trigger_message_id: 'message-1',
    verdict: 'answerable',
    established: [{ claim: 'La commande est en préparation.' }],
    unverified: [],
    missing: [],
    do_not_claim: [],
    knowledge: []
  },
  ticket: { id: 'ticket-1', level: 2, language: 'fr', happiness: 1, requester_name: 'Laurence' },
  message: { id: 'message-1', subject: 'Ma commande', body_text: 'Où en est ma commande ?' },
  orderContext: null
};

const GOOD_BODY = `Bonjour Laurence,\n\nVotre commande est en préparation.\n\n${SIGNATURE}`;

function harness({ candidates = [CANDIDATE], answers = [{ subject: null, body: GOOD_BODY }] } = {}) {
  const saved = [];
  const calls = [];
  let next = 0;

  return {
    saved,
    calls,
    args: {
      store: { async claimable() { return candidates; } },
      draftRecord: {
        async save(draft) {
          saved.push(draft);
          return draft;
        }
      },
      openai: {
        async completeJson(request) {
          calls.push(request);
          const answer = answers[Math.min(next, answers.length - 1)];
          next += 1;
          if (answer instanceof Error) throw answer;
          return answer;
        }
      },
      brandVoice: VOICE,
      shopId: 'shop-1',
      model: 'gpt-4o'
    }
  };
}

// --- the brand voice is a property of the run --------------------------------

test('an unapproved brand voice stops the run before any ticket is drafted', async () => {
  // Discovering it on ticket 40 of 91 would mean 39 replies written in a voice
  // nobody signed off.
  const h = harness();
  await assert.rejects(
    () => runDrafting({ ...h.args, brandVoice: { ...VOICE, approvalStatus: 'draft' } }),
    /not approved/
  );
  assert.equal(h.calls.length, 0);
});

test('a missing brand voice stops it too', async () => {
  const h = harness();
  await assert.rejects(() => runDrafting({ ...h.args, brandVoice: null }), /No Brand voice/);
});

// --- the happy path ----------------------------------------------------------

test('it drafts, checks and stores one reply per candidate', async () => {
  const h = harness();
  const totals = await runDrafting(h.args);

  assert.deepEqual(
    { considered: totals.considered, drafted: totals.drafted, skipped: totals.skipped, failed: totals.failed },
    { considered: 1, drafted: 1, skipped: 0, failed: 0 }
  );
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].bodyText, GOOD_BODY);
  assert.equal(h.saved[0].checksPassed, true);
  assert.equal(h.saved[0].sourceVerdict, 'answerable');
  assert.equal(h.saved[0].triggerMessageId, 'message-1');
  assert.equal(h.saved[0].investigationId, 'investigation-1');
});

test('the call is billed to the drafting pass and to its ticket', async () => {
  const h = harness();
  await runDrafting(h.args);
  assert.equal(h.calls[0].pass, 'draft');
  assert.equal(h.calls[0].ticketId, 'ticket-1');
  assert.equal(h.calls[0].model, 'gpt-4o');
});

test('the ticket’s language reaches the system prompt', async () => {
  const h = harness({
    candidates: [{ ...CANDIDATE, ticket: { ...CANDIDATE.ticket, language: 'en' } }]
  });
  await runDrafting(h.args);
  assert.match(h.calls[0].system, /en anglais/);
});

// --- the gate ----------------------------------------------------------------

test('needs_human is drafted as an intermediary acknowledgement', async () => {
  // It used to be skipped. The customer heard nothing while a colleague worked
  // on it, and the colleague started from a blank page.
  const h = harness({
    candidates: [
      {
        ...CANDIDATE,
        investigation: {
          ...CANDIDATE.investigation,
          verdict: 'needs_human',
          handoff: true
        }
      }
    ]
  });
  const totals = await runDrafting(h.args);

  assert.equal(totals.drafted, 1);
  assert.equal(totals.skipped, 0);
  assert.equal(h.saved[0].sourceVerdict, 'needs_human');
  assert.equal(h.saved[0].disposition, 'intermediary');
});

test('the handover rule set is the one that travels for needs_human', async () => {
  const h = harness({
    candidates: [
      {
        ...CANDIDATE,
        investigation: { ...CANDIDATE.investigation, verdict: 'needs_human', handoff: true }
      }
    ]
  });
  await runDrafting(h.args);
  assert.match(h.calls[0].system, /nommer précisément le point/);
  assert.doesNotMatch(h.calls[0].system, /Ne pas transformer toute la réponse/);
});

test('an acknowledgement is never auto-send eligible', async () => {
  const h = harness({
    candidates: [
      {
        ...CANDIDATE,
        investigation: { ...CANDIDATE.investigation, verdict: 'needs_human', handoff: true },
        ticket: { ...CANDIDATE.ticket, level: 1, happiness: 1 }
      }
    ]
  });
  await runDrafting(h.args);
  assert.equal(h.saved[0].autoSendEligible, false);
});

test('an answer with nothing left to do is terminal', async () => {
  // The only disposition that lets a send close the ticket.
  const h = harness();
  await runDrafting(h.args);
  assert.equal(h.saved[0].disposition, 'terminal');
});

test('level 4 is skipped even with a draftable verdict', async () => {
  const h = harness({
    candidates: [{ ...CANDIDATE, ticket: { ...CANDIDATE.ticket, level: 4 } }]
  });
  const totals = await runDrafting(h.args);
  assert.deepEqual(totals.skippedBy, { level_4: 1 });
});

// --- the checks decide sendability, not the draft's existence ----------------

test('a draft that fails a check is still stored, and flagged', async () => {
  // Reading what the model wrote is how you find out why it failed.
  const h = harness({
    candidates: [
      {
        ...CANDIDATE,
        investigation: {
          ...CANDIDATE.investigation,
          do_not_claim: [CAVEATS.purchase_unverified]
        }
      }
    ],
    answers: [{ subject: null, body: `Bonjour,\n\nAucune commande n’a été trouvée.\n\n${SIGNATURE}` }]
  });
  const totals = await runDrafting(h.args);

  assert.equal(totals.drafted, 1);
  assert.equal(h.saved[0].checksPassed, false);
  assert.ok(h.saved[0].checks.some((check) => check.passed === false));
});

test('a failed check makes it ineligible for auto-send', async () => {
  const h = harness({
    answers: [{ subject: null, body: 'Bonjour,\n\nMerci.\n\nCordialement,\nQiriness' }]
  });
  await runDrafting(h.args);
  assert.equal(h.saved[0].checksPassed, false, 'the signature was altered');
  assert.equal(h.saved[0].autoSendEligible, false);
});

test('a clean level 2 draft for a calm customer is auto-send eligible', async () => {
  const h = harness();
  await runDrafting(h.args);
  assert.equal(h.saved[0].autoSendEligible, true);
});

test('the same draft for an unhappy customer is not', async () => {
  const h = harness({
    candidates: [{ ...CANDIDATE, ticket: { ...CANDIDATE.ticket, happiness: 4 } }]
  });
  await runDrafting(h.args);
  assert.equal(h.saved[0].autoSendEligible, false);
});

// --- failure isolation -------------------------------------------------------

test('one model failure does not cost the rest of the batch', async () => {
  const second = {
    ...CANDIDATE,
    investigation: { ...CANDIDATE.investigation, id: 'i2', trigger_message_id: 'message-2' },
    ticket: { ...CANDIDATE.ticket, id: 'ticket-2' },
    message: { ...CANDIDATE.message, id: 'message-2' }
  };
  const h = harness({
    candidates: [CANDIDATE, second],
    answers: [new Error('429 rate limited'), { subject: null, body: GOOD_BODY }]
  });

  const totals = await runDrafting(h.args);
  assert.equal(totals.failed, 1);
  assert.equal(totals.drafted, 1);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].ticketId, 'ticket-2');
});

test('an empty body is a failure, not a stored blank draft', async () => {
  const h = harness({ answers: [{ subject: null, body: '   ' }] });
  const totals = await runDrafting(h.args);
  assert.equal(totals.failed, 1);
  assert.equal(h.saved.length, 0);
});

// --- re-drafting -------------------------------------------------------------

test('redraft is passed through to the claim, not applied after it', async () => {
  // The exclusion is a query narrowing, so dropping it has to happen where the
  // candidates are chosen — filtering afterwards would still have cost the
  // model calls it exists to avoid.
  const seen = [];
  await runDrafting({
    ...harness().args,
    store: {
      async claimable(options) {
        seen.push(options);
        return [];
      }
    },
    redraft: true
  });
  assert.equal(seen[0].redraft, true);
});

test('the default is not to re-draft', async () => {
  const seen = [];
  await runDrafting({
    ...harness().args,
    store: {
      async claimable(options) {
        seen.push(options);
        return [];
      }
    }
  });
  assert.equal(seen[0].redraft, false);
});

// --- the dry run -------------------------------------------------------------

test('a dry run calls the model and stores nothing', async () => {
  // The prompt is what is being iterated on, so reading what came back without
  // writing a row is the inner loop of this phase.
  const h = harness();
  const seen = [];
  const totals = await runDrafting({ ...h.args, dryRun: true, onDraft: (d) => seen.push(d) });

  assert.equal(totals.drafted, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.saved.length, 0);
  assert.equal(seen[0].bodyText, GOOD_BODY);
});

// --- which readings need a draft ---------------------------------------------

const READING = { ticket_id: 't1', trigger_message_id: 'm1', investigated_at: '2026-09-17T12:00:00Z' };

test('a reading with no draft needs one', () => {
  assert.deepEqual(needingDraft([READING], []), [READING]);
});

test('a pending draft written after its case file is current', () => {
  const drafts = [{ trigger_message_id: 'm1', status: 'pending', drafted_at: '2026-09-17T12:05:00Z' }];
  assert.deepEqual(needingDraft([READING], drafts), []);
});

test('a pending draft older than a re-investigation is redrafted', () => {
  // Ticket fcf4ca11: investigated without #6669, drafted a request for the
  // number, then re-investigated with the order in hand.
  const drafts = [{ trigger_message_id: 'm1', status: 'pending', drafted_at: '2026-09-14T00:28:47Z' }];
  assert.deepEqual(needingDraft([READING], drafts), [READING]);
});

test('a draft a person has decided on is never redrafted, however stale', () => {
  for (const status of ['approved', 'edited', 'rejected', 'sent']) {
    const drafts = [{ trigger_message_id: 'm1', status, drafted_at: '2026-09-14T00:28:47Z' }];
    assert.deepEqual(needingDraft([READING], drafts), [], status);
  }
});

test('an unreadable timestamp keeps the existing draft', () => {
  const drafts = [{ trigger_message_id: 'm1', status: 'pending', drafted_at: null }];
  assert.deepEqual(needingDraft([READING], drafts), []);
});

test('a closing reply is written when the dossier is clear and the customer says so', async () => {
  const h = harness();
  await runDrafting({
    ...h.args,
    closureReader: async () => ({ closes: true, why: 'le client confirme la réception' })
  });

  // The `closing` intent travelled instead of the verdict's own.
  assert.match(h.calls[0].system, /accuser réception et clore/);
  assert.ok(!/Objectif : résoudre entièrement la demande/.test(h.calls[0].system));
  assert.equal(h.saved[0].promptInputs.closes_case, true);
  assert.equal(h.saved[0].promptInputs.closure_reason, 'le client confirme la réception');
});

test('with no closure reader wired the reply is exactly what it was before', async () => {
  const h = harness();
  await runDrafting({ ...h.args });

  assert.match(h.calls[0].system, /Objectif : résoudre entièrement la demande/);
  assert.equal(h.saved[0].promptInputs.closes_case, false);
  assert.equal(h.saved[0].promptInputs.closure_reason, null);
});

test('a reader that says the case is not closed changes nothing', async () => {
  const h = harness();
  await runDrafting({ ...h.args, closureReader: async () => ({ closes: false, why: 'pose une question' }) });

  assert.match(h.calls[0].system, /Objectif : résoudre entièrement la demande/);
  assert.equal(h.saved[0].promptInputs.closes_case, false);
});
