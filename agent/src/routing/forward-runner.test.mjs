import assert from 'node:assert/strict';
import test from 'node:test';

import { runForwarding } from './forward-runner.mjs';
import { MAX_ACK_ATTEMPTS } from './forward-rules.mjs';

const SINCE = '2026-09-29T00:00:00.000Z';

const HR = {
  id: 'd-hr',
  label: 'RH',
  forward_email: 'hr@example.com',
  description: 'Candidatures',
  categories: ['careers'],
  request_kinds: [],
  match_description: false,
  timing: 'immediate',
  acknowledge: true
};
const ACCOUNTS = { ...HR, id: 'd-acc', label: 'Comptabilité', forward_email: 'acc@example.com', categories: ['b2b'], public_name_fr: 'au service comptabilité' };
const EXPORT = { ...HR, id: 'd-exp', label: 'Export', forward_email: 'export@example.com', categories: ['b2b'] };
const VIGILANCE = { ...HR, id: 'd-cv', label: 'Cosmétovigilance', forward_email: 'cv@example.com', categories: ['cosmetovigilance'], timing: 'after_first_reply', acknowledge: false };

const message = (id, extra = {}) => ({
  messageId: `msg-${id}`,
  graphMessageId: `graph-${id}`,
  fromEmail: 'sender@outside.fr',
  subject: 'Candidature spontanée',
  priorAttempts: 0,
  ...extra
});

const item = (ticket, messages = [message(1)], extra = {}) => ({
  ticket: { id: 't1', subject: 'Candidature', category: 'careers', request_kind: 'contact', language: 'fr', ...ticket },
  routing: null,
  hasOutbound: false,
  messages,
  ...extra
});

function buildStore({
  destinations = [HR, ACCOUNTS, EXPORT, VIGILANCE],
  settings = { forward_since: SINCE, ack_enabled: true },
  pending = [],
  retries = []
} = {}) {
  const calls = { forwards: [], routing: [], acks: [], findPending: 0 };
  return {
    calls,
    async loadConfig() {
      return { destinations, settings, shopName: 'Acme' };
    },
    async findPending(_shopId, options) {
      calls.findPending += 1;
      calls.pendingOptions = options;
      return pending;
    },
    async loadThread() {
      return [{ subject: 'Invoice', body_text: 'Please send the invoice', from_email: 'buyer@shop.co.uk' }];
    },
    async findAckRetries() {
      return retries;
    },
    async recordRouting(_shopId, ticket, decision) {
      calls.routing.push({ ticketId: ticket.id, ...decision });
      return {
        ticket_id: ticket.id,
        category: ticket.category,
        request_kind: ticket.request_kind,
        outcome: decision.outcome,
        destination_id: decision.destination?.id ?? null,
        destination_label: decision.destination?.label ?? null,
        ack_state: null,
        ack_attempts: 0
      };
    },
    async recordForward(entry) {
      calls.forwards.push(entry);
    },
    async recordAck(ticketId, patch) {
      calls.acks.push({ ticketId, ...patch });
    }
  };
}

function buildGraph({ fail = null } = {}) {
  const sent = [];
  return {
    sent,
    async forwardMessage(id, options) {
      if (fail) throw new Error(fail);
      sent.push({ id, ...options });
    }
  };
}

function buildProvider({ failDraft = false, failSend = false } = {}) {
  const replies = [];
  return {
    replies,
    async createReplyDraft(messageId, { bodyText, to }) {
      if (failDraft) throw new Error('ErrorServerBusy');
      replies.push({ messageId, bodyText, to });
      return { draftId: `draft-${messageId}` };
    },
    async sendDraft() {
      if (failSend) throw new Error('ErrorAccessDenied');
    }
  };
}

const chooserPicking = (label) => ({
  calls: 0,
  async choose(_input, candidates) {
    this.calls += 1;
    return { destination: candidates.find((c) => c.label === label) ?? null, reason: 'because', model: 'mini' };
  }
});

test('off until a start date is set: nothing is even looked for', async () => {
  const store = buildStore({ settings: { forward_since: null, ack_enabled: true }, pending: [item({})] });
  const totals = await runForwarding({ store, graphClient: buildGraph(), shopId: 's' });
  assert.equal(store.calls.findPending, 0);
  assert.equal(totals.forwarded, 0);
});

test('a rehearsal date works on a dry run and is refused on a real one', async () => {
  const store = buildStore({ settings: { forward_since: null, ack_enabled: true } });
  await runForwarding({ store, graphClient: buildGraph(), shopId: 's', dryRun: true, rehearseSince: '2026-07-01T00:00:00Z' });
  assert.equal(store.calls.pendingOptions.since, '2026-07-01T00:00:00Z');
  await assert.rejects(runForwarding({ store, graphClient: buildGraph(), shopId: 's', rehearseSince: '2026-07-01T00:00:00Z' }), /dry runs only/);
});

test('only the categories some destination with an address takes are looked for', async () => {
  const store = buildStore({ destinations: [HR, { ...EXPORT, forward_email: null }] });
  await runForwarding({ store, graphClient: buildGraph(), shopId: 's' });
  assert.deepEqual(store.calls.pendingOptions, { since: SINCE, categories: ['careers'] });
});

test('a fixed route forwards, records the decision and the destination, and acknowledges', async () => {
  const store = buildStore({ pending: [item({})] });
  const graphClient = buildGraph();
  const provider = buildProvider();

  const totals = await runForwarding({ store, graphClient, provider, shopId: 's' });

  assert.equal(totals.forwarded, 1);
  assert.deepEqual(graphClient.sent[0].toRecipients, ['hr@example.com']);
  assert.match(graphClient.sent[0].comment, /nous avons reçu une candidature/);
  assert.equal(store.calls.routing[0].method, 'fixed');
  assert.equal(store.calls.forwards[0].destinationLabel, 'RH');
  assert.equal(store.calls.forwards[0].error, null);
  // The acknowledgement answers the forwarded message, to its sender.
  assert.deepEqual(provider.replies[0].to, ['sender@outside.fr']);
  assert.equal(provider.replies[0].messageId, 'graph-1');
  assert.match(provider.replies[0].bodyText, /Nous l'avons transmis au service concerné/);
  assert.deepEqual(store.calls.acks.map((a) => a.state), ['requested', 'sent']);
  assert.equal(totals.acknowledged, 1);
});

test('a choice asks the router once and forwards where it points', async () => {
  const store = buildStore({ pending: [item({ category: 'b2b', request_kind: 'problem' })] });
  const chooser = chooserPicking('Comptabilité');
  const provider = buildProvider();
  const graphClient = buildGraph();

  await runForwarding({ store, graphClient, provider, chooser, shopId: 's' });

  assert.equal(chooser.calls, 1);
  assert.deepEqual(graphClient.sent[0].toRecipients, ['acc@example.com']);
  assert.equal(store.calls.routing[0].method, 'model');
  assert.match(provider.replies[0].bodyText, /au service comptabilité/);
});

test('the router keeping the ticket forwards nothing and says nothing', async () => {
  const store = buildStore({ pending: [item({ category: 'b2b', request_kind: 'contact' })] });
  const graphClient = buildGraph();
  const provider = buildProvider();

  const totals = await runForwarding({ store, graphClient, provider, chooser: chooserPicking('nobody'), shopId: 's' });

  assert.equal(totals.kept, 1);
  assert.equal(graphClient.sent.length, 0);
  assert.equal(provider.replies.length, 0);
  assert.equal(store.calls.routing[0].outcome, 'keep');
});

test('without a chooser a choice is left undecided, never guessed', async () => {
  const store = buildStore({ pending: [item({ category: 'b2b', request_kind: 'problem' })] });
  const totals = await runForwarding({ store, graphClient: buildGraph(), shopId: 's' });
  assert.equal(totals.undecided, 1);
  assert.equal(store.calls.routing.length, 0);
});

test('a stored decision is reused while the category holds, and re-taken when it changes', async () => {
  const stored = { ticket_id: 't1', category: 'b2b', request_kind: 'problem', outcome: 'forward', destination_id: 'd-exp', ack_state: 'sent', ack_attempts: 1 };
  const chooser = chooserPicking('Comptabilité');

  const same = buildStore({ pending: [item({ category: 'b2b', request_kind: 'problem' }, [message(2)], { routing: stored })] });
  const graph = buildGraph();
  const provider = buildProvider();
  await runForwarding({ store: same, graphClient: graph, provider, chooser, shopId: 's' });
  assert.equal(chooser.calls, 0);
  // The follow-up goes where the first message went, and no second acknowledgement.
  assert.deepEqual(graph.sent[0].toRecipients, ['export@example.com']);
  assert.equal(provider.replies.length, 0);

  const changed = buildStore({ pending: [item({ category: 'careers', request_kind: 'contact' }, [message(3)], { routing: stored })] });
  const graph2 = buildGraph();
  await runForwarding({ store: changed, graphClient: graph2, provider: buildProvider(), chooser, shopId: 's' });
  assert.deepEqual(graph2.sent[0].toRecipients, ['hr@example.com']);
});

test('after our first reply: waits until we have replied, then says so in the note', async () => {
  const waiting = buildStore({ pending: [item({ category: 'cosmetovigilance', request_kind: 'problem' })] });
  const totals = await runForwarding({ store: waiting, graphClient: buildGraph(), shopId: 's' });
  assert.equal(totals.waiting, 1);
  assert.equal(waiting.calls.forwards.length, 0);

  const replied = buildStore({ pending: [item({ category: 'cosmetovigilance', request_kind: 'problem' }, [message(1)], { hasOutbound: true })] });
  const graph = buildGraph();
  const provider = buildProvider();
  await runForwarding({ store: replied, graphClient: graph, provider, shopId: 's' });
  assert.deepEqual(graph.sent[0].toRecipients, ['cv@example.com']);
  assert.match(graph.sent[0].comment, /Une première réponse a déjà été envoyée/);
  // Our reply already spoke to the sender: no acknowledgement on top.
  assert.equal(provider.replies.length, 0);
});

test('a colleague\'s message on a routed ticket is skipped, the customer\'s still goes', async () => {
  const store = buildStore({
    pending: [item({}, [message(1, { fromEmail: 'colleague@example.com' }), message(2)])]
  });
  const graph = buildGraph();
  const totals = await runForwarding({ store, graphClient: graph, provider: buildProvider(), shopId: 's', internalDomains: ['example.com'] });
  assert.equal(totals.skipped, 1);
  assert.deepEqual(graph.sent.map((s) => s.id), ['graph-2']);
});

test('a message with no Graph id is skipped rather than re-composed', async () => {
  const store = buildStore({ pending: [item({}, [message(1, { graphMessageId: null })])] });
  const totals = await runForwarding({ store, graphClient: buildGraph(), shopId: 's' });
  assert.equal(totals.skipped, 1);
  assert.equal(store.calls.forwards.length, 0);
});

test('a send failure is recorded, consumes an attempt unless transient, and sends no acknowledgement', async () => {
  const permanent = buildStore({ pending: [item({}, [message(1, { priorAttempts: 2 })])] });
  const provider = buildProvider();
  const totals = await runForwarding({ store: permanent, graphClient: buildGraph({ fail: 'Graph forward failed: ErrorAccessDenied' }), provider, shopId: 's' });
  assert.equal(totals.failed, 1);
  assert.equal(permanent.calls.forwards[0].priorAttempts, 2);
  assert.match(permanent.calls.forwards[0].error, /ErrorAccessDenied/);
  assert.equal(provider.replies.length, 0);

  const transient = buildStore({ pending: [item({}, [message(1, { priorAttempts: 2 })])] });
  await runForwarding({ store: transient, graphClient: buildGraph({ fail: 'Graph forward failed: ErrorMailboxMoveInProgress' }), shopId: 's' });
  assert.equal(transient.calls.forwards[0].priorAttempts, 1);
});

test('acknowledgements switched off mark the ticket skipped for good', async () => {
  const store = buildStore({ settings: { forward_since: SINCE, ack_enabled: false }, pending: [item({})] });
  const provider = buildProvider();
  const totals = await runForwarding({ store, graphClient: buildGraph(), provider, shopId: 's' });
  assert.equal(provider.replies.length, 0);
  assert.deepEqual(store.calls.acks, [{ ticketId: 't1', state: 'skipped', error: 'acknowledgements_off' }]);
  assert.equal(totals.ackSkipped, 1);
});

test('an automated sender is never acknowledged', async () => {
  const store = buildStore({ pending: [item({}, [message(1, { fromEmail: 'noreply@shop.fr' })])] });
  const provider = buildProvider();
  await runForwarding({ store, graphClient: buildGraph(), provider, shopId: 's' });
  assert.equal(provider.replies.length, 0);
  assert.equal(store.calls.acks[0].error, 'automated_sender');
});

test('a draft that could not be created is failed and retryable; a failed send is failed too', async () => {
  const draftFails = buildStore({ pending: [item({})] });
  await runForwarding({ store: draftFails, graphClient: buildGraph(), provider: buildProvider({ failDraft: true }), shopId: 's' });
  assert.deepEqual(draftFails.calls.acks.map((a) => [a.state, a.attempts]), [['failed', 1]]);

  const sendFails = buildStore({ pending: [item({})] });
  await runForwarding({ store: sendFails, graphClient: buildGraph(), provider: buildProvider({ failSend: true }), shopId: 's' });
  assert.deepEqual(sendFails.calls.acks.map((a) => a.state), ['requested', 'failed']);
});

test('a failed acknowledgement is retried on a later poll against the first forwarded message', async () => {
  const store = buildStore({
    retries: [
      {
        routing: { ticket_id: 't9', destination_id: 'd-hr', ack_state: 'failed', ack_attempts: 1 },
        ticket: { id: 't9', language: 'en' },
        message: { id: 'm9', graph_message_id: 'graph-9', from_email: 'person@outside.co.uk' }
      },
      {
        routing: { ticket_id: 't10', destination_id: 'd-hr', ack_state: 'failed', ack_attempts: MAX_ACK_ATTEMPTS },
        ticket: { id: 't10', language: 'fr' },
        message: { id: 'm10', graph_message_id: 'graph-10', from_email: 'person@outside.fr' }
      }
    ]
  });
  const provider = buildProvider();
  await runForwarding({ store, graphClient: buildGraph(), provider, shopId: 's' });
  assert.equal(provider.replies.length, 1);
  assert.equal(provider.replies[0].messageId, 'graph-9');
  assert.match(provider.replies[0].bodyText, /^Hello,/);
  assert.deepEqual(store.calls.acks.map((a) => [a.state, a.attempts]), [['requested', 2], ['sent', undefined]]);
});

test('a dry run decides everything, the router included, but sends and records nothing', async () => {
  const store = buildStore({ pending: [item({ category: 'b2b', request_kind: 'problem' })] });
  const graph = buildGraph();
  const provider = buildProvider();
  const previews = [];
  const totals = await runForwarding({
    store,
    graphClient: graph,
    provider,
    chooser: chooserPicking('Export'),
    shopId: 's',
    dryRun: true,
    onPreview: (p) => previews.push(p.kind)
  });
  assert.deepEqual(previews, ['route', 'forward', 'ack']);
  assert.equal(totals.forwarded, 1);
  assert.equal(graph.sent.length, 0);
  assert.equal(provider.replies.length, 0);
  assert.equal(store.calls.routing.length, 0);
  assert.equal(store.calls.forwards.length, 0);
  assert.equal(store.calls.acks.length, 0);
});
