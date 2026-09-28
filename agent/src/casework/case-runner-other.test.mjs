import assert from 'node:assert/strict';
import test from 'node:test';

import { runOtherMessageCasework } from './case-runner.mjs';

// The model, scripted per message id: what each reading returns.
function fakeOpenAI(answers, seen) {
  return {
    async completeJson({ user, schema }) {
      // The message being read, not one quoted in the thread above it.
      const id = /# Le nouveau message[^\n]*\n\[msg:(\w+)\]/.exec(user)?.[1];
      seen.push({ id, user, owners: schema.properties.obligations_opened.items.properties.owner.enum });
      return {
        case_relationship: 'continuation',
        answered: [],
        new_facts: [],
        commitments: [],
        contradictions: [],
        case_summary: '',
        effect: 'holding',
        asked: [],
        obligations_opened: [],
        obligations_cleared: [],
        ...answers[id]
      };
    }
  };
}

const message = (id, actor, at) => ({ id, ticket_id: 't1', actor, direction: actor === 'support' ? 'outbound' : 'inbound', body_text: `[msg:${id}]`, received_at: at });

test('our messages and the back office are read in date order, each seeing the checks the one before left', async () => {
  const saved = [];
  const seen = [];
  const store = {
    async otherMessagesDue({ since }) {
      assert.equal(since, '2026-09-26T09:27:21Z');
      return [{ ticket: { id: 't1', subject: 'Colis' }, messages: [message('a', 'support', '2026-09-27T10:00:00Z'), message('b', 'partner', '2026-09-28T10:00:00Z')] }];
    },
    async openObligations() { return []; }
  };
  const record = { async conversation() { return [message('a', 'support', '2026-09-27T10:00:00Z'), message('b', 'partner', '2026-09-28T10:00:00Z')]; } };
  const caseStateRecord = {
    async latest() { return { pending_customer_inputs: [], situation_key: 'D-05', case_summary: 'Colis en retard' }; },
    async save(row) { saved.push(row); }
  };
  const openai = fakeOpenAI(
    {
      a: { effect: 'holding', obligations_opened: [{ owner: 'partner', need: 'delivery_state', quote: 'je vérifie auprès de l’entrepôt' }] },
      b: { effect: 'internal_note', obligations_cleared: ['o-a-0'] }
    },
    seen
  );

  const counts = await runOtherMessageCasework({
    store, record, caseStateRecord, openai, model: 'm', shopId: 's',
    owners: ['support', 'colleague', 'partner'], since: '2026-09-26T09:27:21Z'
  });

  assert.equal(counts.read, 2);
  assert.deepEqual(seen.map((s) => s.id), ['a', 'b']);
  assert.match(seen[1].user, /o-a-0/, 'the partner message is read against the check the first one opened');
  assert.deepEqual(saved.map((r) => [r.actor, r.effect, r.caseRelationship, r.situationKey]), [
    ['support', 'holding', null, 'D-05'],
    ['partner', 'internal_note', null, 'D-05']
  ]);
  assert.deepEqual(saved[1].obligationsCleared, ['o-a-0']);
});

test('without a cutover nothing is read, and the owners offered follow the brand', async () => {
  const counts = await runOtherMessageCasework({ store: {}, record: {}, caseStateRecord: {}, openai: {}, model: 'm', shopId: 's', since: null });
  assert.equal(counts.considered, 0);

  const seen = [];
  await runOtherMessageCasework({
    store: { async otherMessagesDue() { return [{ ticket: { id: 't1' }, messages: [message('a', 'support', '2026-09-27')] }]; }, async openObligations() { return []; } },
    record: { async conversation() { return []; } },
    caseStateRecord: { async latest() { return null; }, async save() {} },
    openai: fakeOpenAI({}, seen),
    model: 'm', shopId: 's', owners: ['support', 'colleague'], since: '2026-09-26'
  });
  assert.deepEqual(seen[0].owners, ['support', 'colleague'], 'no operations partner on file, none offered');
});
