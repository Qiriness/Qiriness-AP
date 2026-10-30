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

    const llm = d.routes.find((r) => r.route === 'llm');
    const rules = d.routes.find((r) => r.route === 'rules');
    assert.equal(rules.turns, 1);
    assert.equal(llm.shown, 1);
    assert.equal(llm.clicked, 1);
    assert.equal(llm.carted, 1);

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
