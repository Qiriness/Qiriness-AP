import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { loadEnv } from '../../scripts/lib/sync-config.mjs';
import { FILES, read } from './_shared.test.mjs';

/**
 * The baseline, actually applied.
 *
 * WHY THIS EXISTS. Every other assertion in this directory reads the .sql files
 * as TEXT — `tablesIn`, `checkClause`, `literalsIn` are regexes over a string.
 * That is enough for "does this constraint list the same 14 subjects as the
 * taxonomy module", and it is worth nothing at all for "does this view return
 * the row we think it does": a join can be wrong in every way and still contain
 * the words the text assertions look for.
 *
 * The projections in 02 and 04 are the first thing in this schema whose
 * behaviour is not visible in its text, so this is the first test that runs it.
 * It also makes permanent the check that was previously done by hand — the 8→4
 * split was proved by applying both sets into throwaway schemas and diffing the
 * catalogue, once, from a terminal.
 *
 * SKIPPED WITHOUT A DATABASE, deliberately. `npm test` has never needed one and
 * this must not be what changes that: a contributor with no Supabase project
 * still gets the full text suite, and this file reports as skipped rather than
 * red. Set SUPABASE_DB_URL to run it.
 *
 * The schema is thrown away at the end whatever happens. It is named with a uuid
 * so two runs cannot collide, and dropped in a `finally` so a failed assertion
 * does not leave one behind.
 */

const { Client } = pg;

function resolveDbUrl() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  try {
    return loadEnv().SUPABASE_DB_URL || null;
  } catch {
    // No .env.local at all is a normal state for a fresh clone.
    return null;
  }
}

const DB_URL = resolveDbUrl();
const skip = DB_URL ? false : 'SUPABASE_DB_URL is not set — skipping the applied-baseline test';

/**
 * Rewrite the baseline to install into a throwaway schema.
 *
 * Two substitutions, and both are needed:
 *
 *   `public.`            — every object the files create or reference.
 *   `search_path = public` — the explicit search_path on each function. Left
 *                            alone, a function would resolve `french_unaccent`
 *                            and the tables against the REAL public schema and
 *                            quietly test nothing.
 *
 * `public` is kept on the search_path after the temp schema, and `extensions`
 * added, so the `vector` type and its `<=>` operator still resolve wherever
 * Supabase installed them.
 */
function scopedTo(schema, sql) {
  return sql
    .replaceAll('public.', `${schema}.`)
    .replaceAll('search_path = public', `search_path = ${schema}, public, extensions`);
}

test('the baseline applies, and its projections return what they claim', { skip }, async (t) => {
  const schema = `tmp_baseline_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const client = new Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}, public, extensions`);

    await t.test('every file applies, in order, against an empty schema', async () => {
      for (const file of FILES) {
        await client.query(scopedTo(schema, read(file)));
      }
    });

    // ---------------------------------------------------------------- seed
    //
    // The smallest population that can tell each projection right from wrong:
    // two tickets on one shop, one of them soft-deleted; a thread with an
    // outbound message BEFORE the first inbound one, so "first inbound" cannot
    // be satisfied by "first message"; and a soft-deleted message, so the count
    // and the first-inbound pick both have something to exclude.
    const { rows: [shop] } = await client.query(
      `insert into ${schema}.shops (shop_domain) values ('projections.test') returning id`
    );
    const { rows: [customer] } = await client.query(
      `insert into ${schema}.customers (shop_id, shopify_customer_id, display_name, first_name, last_name, rfm_group)
       values ($1, 'gid://c/1', 'Ada Lovelace', 'Ada', 'Lovelace', 'CHAMPIONS') returning id`,
      [shop.id]
    );
    const { rows: [live] } = await client.query(
      `insert into ${schema}.tickets (shop_id, graph_conversation_id, subject, customer_id, status)
       values ($1, 'conv-live', 'Où est ma commande ?', $2, 'open') returning id`,
      [shop.id, customer.id]
    );
    const { rows: [archived] } = await client.query(
      `insert into ${schema}.tickets (shop_id, graph_conversation_id, subject, status, archived_at)
       values ($1, 'conv-archived', 'Archivé', 'open', now()) returning id`,
      [shop.id]
    );
    const { rows: [erased] } = await client.query(
      `insert into ${schema}.tickets (shop_id, graph_conversation_id, subject, deleted_at)
       values ($1, 'conv-erased', 'Effacé', now()) returning id`,
      [shop.id]
    );

    const message = (ticketId, id, direction, receivedAt, body, deleted = null) =>
      client.query(
        `insert into ${schema}.ticket_messages
           (ticket_id, shop_id, graph_message_id, graph_conversation_id, direction, subject, body_text, received_at, deleted_at)
         values ($1, $2, $3, 'conv-live', $4, 'Où est ma commande ?', $5, $6, $7)`,
        [ticketId, shop.id, id, direction, body, receivedAt, deleted]
      );

    // Our own reply lands first in time: the thread was opened by the desk.
    await message(live.id, 'm-out', 'outbound', '2026-01-01T09:00:00Z', 'notre réponse');
    await message(live.id, 'm-in-1', 'inbound', '2026-01-02T09:00:00Z', 'commande #4854 svp');
    await message(live.id, 'm-in-2', 'inbound', '2026-01-03T09:00:00Z', 'toujours rien');
    await message(live.id, 'm-gone', 'inbound', '2026-01-01T10:00:00Z', 'effacé', new Date().toISOString());

    await client.query(
      `update ${schema}.ticket_messages
       set sent_at = received_at
       where direction = 'outbound'`
    );

    await client.query(
      `insert into ${schema}.orders (shop_id, shopify_order_id, name, order_number) values
         ($1, 'gid://o/1', '#4716', 4716),
         ($1, 'gid://o/2', '#6770', 6770),
         ($1, 'gid://o/3', '#5000', null)`,
      [shop.id]
    );
    await client.query(
      `insert into ${schema}.orders (shop_id, shopify_order_id, name, order_number, deleted_at)
       values ($1, 'gid://o/4', '#9999', 9999, now())`,
      [shop.id]
    );

    // ------------------------------------------------------------ assertions

    await t.test('ticket_message_counts counts live messages only', async () => {
      const { rows } = await client.query(
        `select ticket_id, message_count, inbound_count, latest_inbound_at, latest_outbound_at
         from ${schema}.ticket_message_counts where shop_id = $1`,
        [shop.id]
      );
      assert.equal(rows.length, 1, 'only the ticket with messages should appear');
      assert.equal(rows[0].ticket_id, live.id);
      // 4 written, 1 soft-deleted. Both directions count: the dashboard shows
      // the size of the conversation, not the size of the customer's half.
      assert.equal(Number(rows[0].message_count), 3);
      assert.equal(Number(rows[0].inbound_count), 2);
      assert.ok(rows[0].latest_inbound_at, 'latest inbound timestamp should be present');
      assert.ok(rows[0].latest_outbound_at, 'latest outbound timestamp should be present');
    });

    await t.test('ticket_first_inbound picks the earliest inbound, ignoring ours and the erased', async () => {
      const { rows } = await client.query(
        `select ticket_id, message_id, body_text from ${schema}.ticket_first_inbound where shop_id = $1`,
        [shop.id]
      );
      assert.equal(rows.length, 1);
      // NOT m-out (outbound, and earlier), NOT m-gone (soft-deleted, and
      // earlier than the message that should win), NOT m-in-2 (later).
      assert.equal(rows[0].body_text, 'commande #4854 svp');
    });

    await t.test('ticket_queue joins the customer and the count, and hides erased tickets', async () => {
      const { rows } = await client.query(
        `select id, subject, customer_display_name, customer_rfm_group, message_count,
                inbound_count, waiting_since, archived_at
         from ${schema}.ticket_queue where shop_id = $1 order by subject`,
        [shop.id]
      );
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(live.id), 'the live ticket is missing');
      assert.ok(ids.includes(archived.id), 'archiving must not hide a ticket from the queue');
      assert.ok(!ids.includes(erased.id), 'a soft-deleted ticket reached the queue');

      const linked = rows.find((r) => r.id === live.id);
      assert.equal(linked.customer_display_name, 'Ada Lovelace');
      assert.equal(linked.customer_rfm_group, 'CHAMPIONS');
      assert.equal(Number(linked.message_count), 3);
      assert.equal(Number(linked.inbound_count), 2);
      assert.ok(linked.waiting_since, 'the latest inbound is unanswered');

      // An unlinked ticket with no messages: the join must yield nulls and a
      // zero, not drop the row.
      const unlinked = rows.find((r) => r.id === archived.id);
      assert.equal(unlinked.customer_display_name, null);
      assert.equal(Number(unlinked.message_count), 0);
      assert.equal(Number(unlinked.inbound_count), 0);
      assert.equal(unlinked.waiting_since, null);
    });

    await t.test('order_number_range reports the live extremes, in one row', async () => {
      const { rows } = await client.query(`select * from ${schema}.order_number_range($1)`, [shop.id]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].min_order_number, 4716);
      // 9999 is soft-deleted and must not set the ceiling; the null-numbered
      // order must not sink the floor.
      assert.equal(rows[0].max_order_number, 6770);
    });

    await t.test('order_number_range answers null for a shop with no orders', async () => {
      const { rows: [empty] } = await client.query(
        `insert into ${schema}.shops (shop_domain) values ('empty.test') returning id`
      );
      const { rows } = await client.query(`select * from ${schema}.order_number_range($1)`, [empty.id]);
      // One row of nulls, not zero rows: the caller reads "we cannot judge
      // whether a quoted number is ours", which is different from a range of 0.
      assert.equal(rows.length, 1);
      assert.equal(rows[0].min_order_number, null);
      assert.equal(rows[0].max_order_number, null);
    });

    // ------------------------------------------------------- ranged reads
    //
    // Four orders either side of midnight in Paris (UTC+2 in summer). In UTC,
    // A and B share 31 July; in Paris, A is 1 August. That single order is the
    // whole reason the functions take a timezone.
    const { rows: [ranges] } = await client.query(
      `insert into ${schema}.shops (shop_domain) values ('ranges.test') returning id`
    );
    await client.query(
      `insert into ${schema}.orders
         (shop_id, shopify_order_id, name, processed_at, total_price, total_refunded, sales_channel_handle, cancelled_at)
       values
         ($1, 'gid://r/a', '#A', '2026-07-31T22:30:00Z', 100, 0, 'web', null),
         ($1, 'gid://r/b', '#B', '2026-07-31T21:30:00Z', 50, 0, 'amazon', null),
         ($1, 'gid://r/c', '#C', '2026-08-01T10:00:00Z', 30, 10, 'web', null),
         ($1, 'gid://r/d', '#D', '2026-08-01T11:00:00Z', 999, 0, 'web', '2026-08-01T12:00:00Z')`,
      [ranges.id]
    );
    const window = [ranges.id, '2026-07-31T00:00:00', '2026-08-02T00:00:00', 'Europe/Paris'];

    await t.test('series bucket on the shop clock, not the database one', async () => {
      const { rows } = await client.query(
        `select bucket::text as bucket, orders, revenue
         from ${schema}.insights_orders_series($1, $2, $3, $4, 'day')`,
        window
      );
      assert.deepEqual(
        rows.map((r) => [r.bucket, Number(r.orders)]),
        [['2026-07-31 00:00:00', 1], ['2026-08-01 00:00:00', 3]]
      );
      // A's 100 plus C net of its refund; the cancelled D earns nothing.
      assert.equal(Number(rows[1].revenue), 120);
    });

    await t.test('the channel filters keep and drop by handle', async () => {
      const summary = async (channels, notChannels) =>
        (
          await client.query(
            `select * from ${schema}.insights_orders_summary($1, $2, $3, $4, $5, $6)`,
            [...window, channels, notChannels]
          )
        ).rows[0];

      const all = await summary(null, null);
      assert.equal(Number(all.orders), 4);
      assert.equal(Number(all.cancelled_orders), 1);
      assert.equal(Number(all.revenue), 170);

      assert.equal(Number((await summary(['amazon'], null)).orders), 1);
      const shopify = await summary(null, ['amazon']);
      assert.equal(Number(shopify.orders), 3);
      assert.equal(Number(shopify.revenue), 120);
    });

    await t.test('the VIP rule needs BOTH conditions, each strictly exceeded, inside the window', async () => {
      // Four customers, rule "> €100 and > 1 order in 12 months":
      //   both    — 2 orders, €150            -> VIP
      //   spender — 1 order, €500             -> not: one condition is not both
      //   regular — 3 orders, €60             -> not: the other one
      //   stale   — 2 orders, €300, 2 years ago -> not: outside the window
      //   edge    — 2 orders, exactly €100    -> not: "more than" is strict
      const people = ['both', 'spender', 'regular', 'stale', 'edge'];
      const ids = {};
      for (const name of people) {
        const { rows: [row] } = await client.query(
          `insert into ${schema}.customers (shop_id, shopify_customer_id, display_name) values ($1, $2, $3) returning id`,
          [ranges.id, `gid://vip/${name}`, name]
        );
        ids[name] = row.id;
      }
      const orders = [
        ['both', 100, 'now()'], ['both', 50, 'now()'],
        ['spender', 500, 'now()'],
        ['regular', 20, 'now()'], ['regular', 20, 'now()'], ['regular', 20, 'now()'],
        ['stale', 150, "now() - interval '2 years'"], ['stale', 150, "now() - interval '2 years'"],
        ['edge', 50, 'now()'], ['edge', 50, 'now()']
      ];
      for (const [i, [name, price, at]] of orders.entries()) {
        await client.query(
          `insert into ${schema}.orders (shop_id, shopify_order_id, shopify_customer_id, name, processed_at, total_price, sales_channel_handle)
           values ($1, $2, $3, $4, ${at}, $5, 'web')`,
          [ranges.id, `gid://vip-order/${i}`, `gid://vip/${name}`, `#V${i}`, price]
        );
      }
      const { rows } = await client.query(
        `select customer_id from ${schema}.vip_customers($1, 100, 1, 12, array['amazon'])`,
        [ranges.id]
      );
      assert.deepEqual(rows.map((r) => r.customer_id), [ids.both]);
    });

    await t.test('an empty range is one row of zeros, never no row', async () => {
      const { rows } = await client.query(
        `select * from ${schema}.insights_orders_summary($1, '2020-01-01T00:00:00', '2020-01-02T00:00:00', 'UTC')`,
        [ranges.id]
      );
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].orders), 0);
      assert.equal(rows[0].p50_hours, null);
    });
  } finally {
    await client.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    await client.end();
  }
});
