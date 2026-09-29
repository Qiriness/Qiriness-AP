import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ATTEMPTS,
  dueReportMonth,
  nextStep,
  reportEventKey,
  reportMail,
  reportRecipients,
  runSalesReportMail
} from './sales-report-mail.mjs';

const PARIS = 'Europe/Paris';

test('due on the 1st from the send hour, for the month that just ended, on the shop clock', () => {
  // 07:30 Paris on 1 October: before the hour.
  assert.equal(dueReportMonth({ now: new Date('2026-10-01T05:30:00Z'), tz: PARIS, sendHour: 8 }), null);
  // 08:00 Paris on 1 October.
  assert.equal(dueReportMonth({ now: new Date('2026-10-01T06:00:00Z'), tz: PARIS, sendHour: 8 }), '2026-09');
  // 23:30 UTC on 30 September is already 1 October in Paris, but before 08:00.
  assert.equal(dueReportMonth({ now: new Date('2026-09-30T23:30:00Z'), tz: PARIS, sendHour: 0 }), '2026-09');
  // January covers December of the year before.
  assert.equal(dueReportMonth({ now: new Date('2027-01-01T09:00:00Z'), tz: PARIS, sendHour: 8 }), '2026-12');
});

test('a worker down on the 1st catches up for a week, then leaves the month', () => {
  assert.equal(dueReportMonth({ now: new Date('2026-10-07T12:00:00Z'), tz: PARIS }), '2026-09');
  assert.equal(dueReportMonth({ now: new Date('2026-10-08T12:00:00Z'), tz: PARIS }), null);
  // Deployed on 29 September: nothing goes until 1 October.
  assert.equal(dueReportMonth({ now: new Date('2026-09-29T12:00:00Z'), tz: PARIS }), null);
});

test('the subject and body are short, and in French', () => {
  const mail = reportMail({ month: '2026-09', brand: 'Qiriness' });
  assert.equal(mail.subject, 'Rapport des ventes E-commerce Qiriness - Septembre 2026');
  assert.equal(
    mail.text,
    'Bonjour,\n\nVeuillez trouver ci-joint le rapport des ventes e-commerce de septembre 2026.\n\nBien cordialement,\nAgent Contact Qiriness\n\n' +
      'P.S. : pour consulter le rapport, téléchargez la pièce jointe puis ouvrez-la avec un navigateur (Chrome, Safari, Edge…).'
  );
  assert.equal(reportMail({ month: '2026-12', brand: 'Qiriness' }).subject, 'Rapport des ventes E-commerce Qiriness - Décembre 2026');
});

const user = (email, role, extra = {}) => ({ email, app_metadata: { dashboard_role: role }, ...extra });

test('recipients: active accounts with a report role, plus the extras, once each', () => {
  const users = [
    user('Boss@Example.com', 'management'),
    user('agent@example.com', 'contact'),
    user('dev@example.com', 'developer'),
    user('gone@example.com', 'management', { banned_until: '2999-01-01T00:00:00Z' })
  ];
  assert.deepEqual(reportRecipients(users, { roles: ['management'], extra: ['me@example.com', 'boss@example.com'] }), [
    'boss@example.com',
    'me@example.com'
  ]);
});

test('next step: insert when new, never twice, retry a failure after the wait, up to the cap', () => {
  const now = new Date('2026-10-01T10:00:00Z');
  assert.equal(nextStep(undefined, now), 'insert');
  assert.equal(nextStep({ status: 'completed' }, now), null);
  assert.equal(nextStep({ status: 'processing' }, now), null);
  assert.equal(nextStep({ status: 'failed', counts: { attempts: 1 }, finished_at: '2026-10-01T09:50:00Z' }, now), null);
  assert.equal(nextStep({ status: 'failed', counts: { attempts: 1 }, finished_at: '2026-10-01T09:00:00Z' }, now), 'retry');
  assert.equal(
    nextStep({ status: 'failed', counts: { attempts: MAX_ATTEMPTS }, finished_at: '2026-10-01T09:00:00Z' }, now),
    null
  );
});

/** A PostgREST stand-in holding `shops` and `integration_events`. */
function fakeSupabase({ events = [] } = {}) {
  const rows = { shops: [{ id: 'shop-1', shop_name: 'Qiriness', iana_timezone: PARIS }], integration_events: events };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').pop();
    const filters = [...parsed.searchParams].filter(([k]) => k !== 'select').map(([k, v]) => [k, v.replace(/^eq\./, '')]);
    const match = (row) => filters.every(([k, v]) => String(row[k]) === v);
    const method = init.method || 'GET';
    calls.push({ method, table });
    let body;
    if (method === 'GET') body = rows[table].filter(match);
    if (method === 'POST') {
      const [row] = JSON.parse(init.body);
      if (rows[table].some((r) => r.event_key === row.event_key)) {
        return new Response(JSON.stringify({ message: 'duplicate key value violates unique constraint' }), { status: 409 });
      }
      const stored = { id: `ev-${rows[table].length + 1}`, updated_at: 'u1', ...row };
      rows[table].push(stored);
      body = [stored];
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body);
      body = rows[table].filter(match).map((row) => Object.assign(row, patch, { updated_at: 'u2' }));
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return {
    client: { baseUrl: 'https://db.test/rest/v1', key: 'k' },
    rows,
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    }
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };
const reportConfig = {
  url: 'https://dash.test/api/reports/sales',
  secret: 's'.repeat(40),
  roles: ['management'],
  extraRecipients: ['me@example.com'],
  sendHour: 8
};
const admin = { listUsers: async () => [user('boss@example.com', 'management')] };

function run(db, overrides = {}) {
  const sent = [];
  const fetched = [];
  return {
    sent,
    fetched,
    promise: runSalesReportMail({
      supabase: db.client,
      graphClient: { sendMail: async (mail) => sent.push(mail) },
      adminClient: admin,
      shopId: 'shop-1',
      config: reportConfig,
      logger: quietLogger,
      now: new Date('2026-10-01T07:00:00Z'),
      fetchImpl: async (url, init) => {
        fetched.push({ url: String(url), auth: init.headers.Authorization });
        return new Response('<html>report</html>', { status: 200 });
      },
      ...overrides
    })
  };
}

test('sends September once, from the report the dashboard built, and records it', async () => {
  const db = fakeSupabase();
  try {
    const first = run(db);
    assert.deepEqual(await first.promise, { sent: true, month: '2026-09', recipients: 2 });
    assert.equal(first.fetched[0].url, 'https://dash.test/api/reports/sales?month=2026-09');
    assert.equal(first.fetched[0].auth, `Bearer ${reportConfig.secret}`);
    assert.equal(first.sent.length, 1);
    assert.deepEqual(first.sent[0].toRecipients, ['boss@example.com', 'me@example.com']);
    assert.equal(first.sent[0].subject, 'Rapport des ventes E-commerce Qiriness - Septembre 2026');
    assert.equal(first.sent[0].attachments[0].name, 'qiriness-sales-report-2026-09.html');
    assert.equal(first.sent[0].attachments[0].content, '<html>report</html>');
    const [event] = db.rows.integration_events;
    assert.equal(event.event_key, reportEventKey('shop-1', '2026-09'));
    assert.equal(event.status, 'completed');

    const second = run(db);
    assert.deepEqual(await second.promise, { skipped: 'handled', month: '2026-09' });
    assert.equal(second.sent.length, 0);
    assert.equal(second.fetched.length, 0);
  } finally {
    db.restore();
  }
});

test('a failed send is recorded and retried after the wait, not on the next poll', async () => {
  const db = fakeSupabase();
  try {
    const failing = run(db, { graphClient: { sendMail: async () => { throw new Error('Graph sendMail failed: ErrorAccessDenied'); } } });
    assert.equal((await failing.promise).sent, false);
    assert.equal(db.rows.integration_events[0].status, 'failed');

    const tooSoon = run(db, { now: new Date('2026-10-01T07:05:00Z') });
    assert.equal((await tooSoon.promise).skipped, 'handled');

    const later = run(db, { now: new Date('2026-10-01T08:00:00Z') });
    assert.equal((await later.promise).sent, true);
    assert.equal(db.rows.integration_events[0].status, 'completed');
    assert.equal(db.rows.integration_events[0].counts.attempts, 2);
  } finally {
    db.restore();
  }
});

test('does nothing until configured, or outside the window', async () => {
  const db = fakeSupabase();
  try {
    assert.deepEqual(await run(db, { config: { ...reportConfig, secret: '' } }).promise, { skipped: 'not_configured' });
    assert.deepEqual(await run(db, { now: new Date('2026-09-29T12:00:00Z') }).promise, { skipped: 'not_due' });
    assert.equal(db.rows.integration_events.length, 0);
  } finally {
    db.restore();
  }
});
