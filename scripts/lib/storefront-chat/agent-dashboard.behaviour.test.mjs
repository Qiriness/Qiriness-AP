import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFresh } from '../../check-baseline.mjs';

/**
 * `storefront_agent_dashboard` on a fresh build (PGlite): conversations by the
 * window they started in, a click counted once per conversation however many
 * beacons arrived, an order counted once and only when placed after the chat
 * began, revenue net of refunds, cancelled orders out.
 */
test('the storefront agent dashboard counts conversations, clicks and assisted orders once', async () => {
  const db = await buildFresh();
  const q = async (text, params) => (await db.query(text, params)).rows;
  try {
    const shop = 'advisor.test';
    const [{ id: shopId }] = await q(`insert into shops (shop_domain) values ($1) returning id`, [shop]);
    const [{ id: productId, shopify_product_id: gid }] = await q(
      `insert into products (shop_id, shopify_product_id, handle, title) values ($1, 'gid://shopify/Product/1', 'serum', 'Sérum') returning id, shopify_product_id`,
      [shopId]
    );
    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';
    const OLD = '00000000-0000-4000-8000-00000000000c';
    const turn = (conv, at, extra = {}) =>
      q(
        `insert into storefront_agent_turns (shop_domain, conversation_id, created_at, status, route, intent, latency_ms, product_ids, model, input_tokens, output_tokens, escalated, unanswered, error_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [shop, conv, at, extra.status ?? 'answered', extra.route ?? 'llm', extra.intent ?? 'product_discovery', extra.latency ?? 3000,
          extra.products ?? [], extra.model ?? 'gpt-6-luna', 1000, 50, extra.escalated ?? false, extra.unanswered ?? false, extra.error ?? null]
      );
    // A: discovery, shows the product, clicked twice (two beacons), added, bought.
    await turn(A, '2026-10-10T10:00:00Z', { products: [productId] });
    await turn(A, '2026-10-10T10:01:00Z', { route: 'rules', model: null, latency: 200 });
    // B: a routine, ends on a failed turn: not resolved.
    await turn(B, '2026-10-11T09:00:00Z', { intent: 'routine_building' });
    await turn(B, '2026-10-11T09:02:00Z', { intent: 'routine_building', status: 'failed', error: 'timeout' });
    // OLD began before the window: its later turn counts as a turn, not a conversation.
    await turn(OLD, '2026-09-01T09:00:00Z');
    await turn(OLD, '2026-10-12T09:00:00Z');
    for (const type of ['product_clicked', 'product_clicked', 'added_to_cart']) {
      await q(
        `insert into advisory_events (shop_domain, channel, conversation_ref, event_type, product_ids, created_at) values ($1, 'storefront_chat', $2, $3, $4, '2026-10-10T10:00:30Z')`,
        [shop, A, type, [productId]]
      );
    }
    // A rated A's recommendation up; a reply with no products is rated too, but is no recommendation.
    await q(`update storefront_agent_turns set feedback = 'up', feedback_at = now() where conversation_id = $1 and cardinality(product_ids) > 0`, [A]);
    await q(`update storefront_agent_turns set feedback = 'down', feedback_at = now() where conversation_id = $1 and status = 'answered'`, [B]);
    // Two routines provided in the window, one added to the cart; one from before it.
    await q(`insert into advisor_routines (ref, shop_domain, channel, routine_time, created_at, added_to_cart_at) values
      (gen_random_uuid(), $1, 'storefront_chat', 'day', '2026-10-11T09:01:00Z', '2026-10-11T09:03:00Z'),
      (gen_random_uuid(), $1, 'storefront_chat', 'both', '2026-10-12T09:01:00Z', null),
      (gen_random_uuid(), $1, 'storefront_chat', 'night', '2026-09-01T09:01:00Z', null)`, [shop]);
    await q(`insert into advisory_events (shop_domain, channel, conversation_ref, event_type, created_at) values
      ($1, 'storefront_chat', $2, 'routine_builder_started', '2026-10-11T09:00:00Z'),
      ($1, 'storefront_chat', $2, 'routine_builder_completed', '2026-10-11T09:01:00Z'),
      ($1, 'storefront_chat', $3, 'routine_builder_started', '2026-10-12T09:00:00Z')`, [shop, B, A]);
    await q(`insert into storefront_agent_opens (id, shop_domain, created_at) values (gen_random_uuid(), $1, '2026-10-10T09:59:00Z')`, [shop]);
    const order = (name, conv, at, extra = {}) =>
      q(
        `insert into orders (shop_id, shopify_order_id, name, total_price, total_refunded, processed_at, cancelled_at, advisor_conversation_id, line_items)
         values ($1, $2, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [shopId, name, extra.total ?? 50, extra.refunded ?? 0, at, extra.cancelled ?? null, conv,
          JSON.stringify([{ product_id: gid, quantity: 1, discounted_total: '40.00' }])]
      );
    await order('#1', A, '2026-10-10T11:00:00Z', { total: 50, refunded: 10 });
    // Cancelled, and one placed before the conversation began: neither counts.
    await order('#2', A, '2026-10-10T12:00:00Z', { cancelled: '2026-10-10T13:00:00Z' });
    await order('#3', B, '2026-10-01T12:00:00Z');

    const [{ storefront_agent_dashboard: d }] = await q(
      `select storefront_agent_dashboard($1, '2026-10-01T00:00:00', '2026-11-01T00:00:00', 'UTC', 'day')`,
      [[shop]]
    );

    assert.equal(d.conversations.total, 2, 'A and B started in the window; OLD did not');
    assert.equal(d.conversations.resolved, 1, 'B ended on a failure');
    assert.equal(d.conversations.clicked, 1, 'two beacons, one conversation');
    assert.equal(d.conversations.carted, 1);
    assert.equal(d.conversations.purchased, 1);
    assert.equal(d.opens, 1);
    assert.equal(d.orders.count, 1, 'cancelled and pre-chat orders are not assisted');
    assert.equal(Number(d.orders.revenue), 40, 'net of the refund');
    assert.equal(d.turns.total, 5, 'turns in the window, OLD included');
    assert.equal(d.turns.failed, 1);
    assert.deepEqual(d.errors, [{ code: 'timeout', turns: 1 }]);
    assert.equal(d.coverage.orders_synced, true);
    assert.ok(d.coverage.feedback_from);
    assert.equal(d.turns.rated, 1, 'only replies that showed products count for accuracy');
    assert.equal(d.turns.rated_up, 1);
    assert.deepEqual(d.routines, { provided: 2, added: 1, started: 2, completed: 1 });
    assert.ok(d.coverage.routines_from);

    const llm = d.routes.find((r) => r.route === 'llm');
    const rules = d.routes.find((r) => r.route === 'rules');
    assert.equal(rules.turns, 1);
    assert.equal(llm.shown, 1);
    assert.equal(llm.clicked, 1);
    assert.equal(llm.carted, 1);
    assert.equal(llm.rated, 1);
    assert.equal(llm.rated_up, 1);

    const routine = d.intents.find((i) => i.intent === 'routine_building');
    assert.equal(routine.conversations, 1);
    assert.equal(routine.resolved, 0);
    const discovery = d.intents.find((i) => i.intent === 'product_discovery');
    assert.equal(Number(discovery.revenue), 40);

    const [top] = d.products;
    assert.equal(top.product_id, productId);
    assert.equal(top.clicked, 1);
    assert.equal(top.shown, 1);
    assert.equal(Number(top.units), 1);
    assert.equal(Number(top.sales), 40);

    // Tokens come back by model for pricing; the rules turn ran none.
    assert.ok(d.tokens.every((row) => row.model === 'gpt-6-luna'));
  } finally {
    await db.close();
  }
});

/**
 * `storefront_agent_routine_profile`: the window's routines counted per answer,
 * a null answer its own row, other shops and other windows out, and the labels
 * of the shop's active knowledge version only.
 */
test('the routine profile counts the window\'s answers and carries the active knowledge\'s labels', async () => {
  const db = await buildFresh();
  const q = async (text, params) => (await db.query(text, params)).rows;
  try {
    const shop = 'advisor.test';
    const [{ id: shopId }] = await q(`insert into shops (shop_domain) values ($1) returning id`, [shop]);
    const labels = (name) => JSON.stringify({ labels: { main: { A: { fr: name } }, skin: {} }, age_ranges: [{ key: '25_34', label_fr: '25 à 34 ans' }], routine_times: [] });
    await q(`insert into advisor_knowledge (shop_id, version, status, source, products, routines) values
      ($1, 1, 'archived', 'test', '[]', $2::jsonb), ($1, 2, 'active', 'test', '[]', $3::jsonb)`, [shopId, labels('Ancienne'), labels('Hydratation')]);
    await q(`insert into advisor_routines (ref, shop_domain, channel, main_concern, skin_type, age_band, routine_time, created_at) values
      (gen_random_uuid(), $1, 'storefront_chat', 'A', 'dry', '25_34', 'day', '2026-10-11T09:00:00Z'),
      (gen_random_uuid(), $1, 'storefront_chat', 'A', 'oily', '25_34', 'both', '2026-10-12T09:00:00Z'),
      (gen_random_uuid(), $1, 'storefront_chat', 'Y', null, '45_plus', 'both', '2026-10-13T09:00:00Z'),
      (gen_random_uuid(), $1, 'storefront_chat', 'B', 'dry', '25_34', 'night', '2026-09-01T09:00:00Z'),
      (gen_random_uuid(), 'other.test', 'storefront_chat', 'B', 'dry', '25_34', 'night', '2026-10-12T09:00:00Z')`, [shop]);

    const [{ doc }] = await q(
      `select storefront_agent_routine_profile(array[$1], '2026-10-01 00:00', '2026-11-01 00:00', 'Europe/Paris') as doc`,
      [shop]
    );
    assert.equal(doc.total, 3);
    assert.deepEqual(doc.main_concern, [{ code: 'A', routines: 2 }, { code: 'Y', routines: 1 }]);
    assert.deepEqual(doc.skin_type, [{ code: 'dry', routines: 1 }, { code: 'oily', routines: 1 }, { code: null, routines: 1 }]);
    assert.deepEqual(doc.routine_time, [{ code: 'both', routines: 2 }, { code: 'day', routines: 1 }]);
    assert.equal(doc.labels.main.A.fr, 'Hydratation');
    assert.equal(doc.labels.age_ranges[0].label_fr, '25 à 34 ans');

    const [{ doc: empty }] = await q(`select storefront_agent_routine_profile(array['nobody.test'], '2026-10-01 00:00', '2026-11-01 00:00', 'UTC') as doc`);
    assert.deepEqual(empty, { total: 0, main_concern: [], skin_type: [], age_band: [], routine_time: [], labels: {} });
  } finally {
    await db.close();
  }
});
