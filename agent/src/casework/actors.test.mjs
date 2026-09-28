import assert from 'node:assert/strict';
import test from 'node:test';

import * as actorsModule from './actors.mjs';
import { DEFAULT_ACTOR_BY_LABEL, actorOf, parseActorMap } from './actors.mjs';

const directory = {
  lookup: (email) =>
    ({
      'lea@staff.example': { label: 'internal' },
      'ops@partner.example': { label: 'logistics' },
      'buyer@retail.example': { label: 'retailer' },
      'x@new.example': { label: 'wholesaler' }
    })[email] ?? null
};

test('outbound is support, whoever sent it', () => {
  assert.equal(actorOf({ direction: 'outbound', from_email: 'lea@staff.example' }, directory), 'support');
});

test('inbound follows the directory label through the map; an unlisted sender is the customer', () => {
  assert.equal(actorOf({ direction: 'inbound', from_email: 'lea@staff.example' }, directory), 'colleague');
  assert.equal(actorOf({ direction: 'inbound', from_email: 'ops@partner.example' }, directory), 'partner');
  assert.equal(actorOf({ direction: 'inbound', from_email: 'buyer@retail.example' }, directory), 'customer');
  assert.equal(actorOf({ direction: 'inbound', from_email: 'marie@example.com' }, directory), 'customer');
  assert.equal(actorOf({ direction: 'inbound', from_email: 'x@new.example' }, directory), 'customer', 'a label the map does not know');
});

test('a deployment overrides the map, and only the labels it names', () => {
  const map = parseActorMap('logistics:colleague, wholesaler:partner');
  assert.equal(map.logistics, 'colleague');
  assert.equal(map.wholesaler, 'partner');
  assert.equal(map.internal, DEFAULT_ACTOR_BY_LABEL.internal);
  assert.equal(actorOf({ direction: 'inbound', from_email: 'ops@partner.example' }, directory, map), 'colleague');
});

test('an unset map is the default, and an unknown actor is refused', () => {
  assert.deepEqual(parseActorMap(''), { ...DEFAULT_ACTOR_BY_LABEL });
  assert.deepEqual(parseActorMap(undefined), { ...DEFAULT_ACTOR_BY_LABEL });
  assert.throws(() => parseActorMap('logistics:vendor'), /not an actor/);
});

test('who may owe a check follows the directory: no partner on file, no partner owner', () => {
  const { obligationOwners } = actorsModule;
  assert.deepEqual(obligationOwners({ labels: ['internal', 'logistics', 'retailer'] }), ['support', 'colleague', 'partner']);
  assert.deepEqual(obligationOwners({ labels: ['internal'] }), ['support', 'colleague']);
  assert.deepEqual(obligationOwners({ labels: [] }), ['support']);
  // A brand whose 3PL counts as the team: logistics is a colleague, no partner.
  assert.deepEqual(obligationOwners({ labels: ['logistics'], actorByLabel: { logistics: 'colleague' } }), ['support', 'colleague']);
});
