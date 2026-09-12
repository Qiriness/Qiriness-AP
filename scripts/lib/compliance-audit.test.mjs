import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STALE_SYNC_MINUTES,
  failStaleIntegrationEvents,
  maskEmail
} from './compliance-audit.mjs';

// --- maskEmail ----------------------------------------------------------------

test('maskEmail keeps the shape a person recognises and nothing else', () => {
  assert.equal(maskEmail('jocelyne.wastiel@bluewin.ch'), 'j***l@bluewin.ch');
  assert.equal(maskEmail('CATHERINE.MONTEIL@YAHOO.FR'), 'c***l@yahoo.fr');
});

test('maskEmail keeps the domain whole, because it is the discriminating half', () => {
  // "Same person, second address at the same provider" is the mismatch question,
  // and the domain is what answers it. A provider domain is not personal data —
  // the sender directory already stores company domains for the same reason.
  assert.match(maskEmail('someone@orange.fr'), /@orange\.fr$/);
});

test('maskEmail does not half-mask a short local part', () => {
  // `b***o@x.fr` would be longer than `bo@x.fr` and hide nothing.
  assert.equal(maskEmail('bo@x.fr'), '**@x.fr');
  assert.equal(maskEmail('a@x.fr'), '**@x.fr');
});

test('maskEmail returns null for anything that is not an address', () => {
  // Distinguishable from "we have one": a masked non-address would read as a
  // readable identifier we do not actually hold.
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail(''), null);
  assert.equal(maskEmail('not-an-address'), null);
  assert.equal(maskEmail('@nolocal.fr'), null);
  assert.equal(maskEmail('nodomain@'), null);
});

test('maskEmail cannot be reversed to reach anyone', () => {
  // The point of the column: two different addresses at one provider stay
  // distinguishable to a human without either being recoverable.
  const a = maskEmail('marie.dupont@orange.fr');
  const b = maskEmail('m.dupont@orange.fr');
  assert.equal(a, b, 'and identical shapes are honestly identical');
  assert.ok(!a.includes('dupont'));
});

// --- failStaleIntegrationEvents -----------------------------------------------

test('failStaleIntegrationEvents closes only rows older than the job timeout', async () => {
  // The filter is the whole point: a run that started twenty minutes ago is this
  // process's sibling, not a corpse. Both halves are asserted on the URL because
  // PostgREST does the selecting, so the URL IS the logic.
  const { requests, restore } = stubFetch([{ id: 'event-1', event_type: 'nightly_sync', started_at: '2026-09-12T06:42:33Z' }]);
  const now = new Date('2026-09-12T10:27:00Z');

  try {
    const closed = await failStaleIntegrationEvents(client(), { now });
    assert.equal(closed.length, 1);
  } finally {
    restore();
  }

  assert.equal(requests.length, 1);
  const { url, options } = requests[0];
  assert.equal(options.method, 'PATCH');
  assert.ok(url.includes('status=eq.processing'), 'only unfinished rows');
  // 10:27 minus 180 minutes.
  assert.ok(
    decodeURIComponent(url).includes('started_at=lt.2026-09-12T07:27:00.000Z'),
    `cutoff should be the timeout before now, got ${decodeURIComponent(url)}`
  );

  const body = JSON.parse(options.body);
  assert.equal(body.status, 'failed');
  assert.equal(body.finished_at, now.toISOString());
  assert.match(body.error_summary, /killed before it could close its own row/);
});

test('failStaleIntegrationEvents defaults to the workflow job timeout', () => {
  // If these drift apart the sweep either fails a live run or leaves a dead one
  // showing as "running". 180 is `timeout-minutes` in nightly-sync.yml.
  assert.equal(STALE_SYNC_MINUTES, 180);
});

test('failStaleIntegrationEvents returns an empty list when nothing was stale', async () => {
  // A quiet night must not read as an error, and PostgREST answers a matchless
  // PATCH with an empty array rather than a failure.
  const { restore } = stubFetch([]);
  try {
    assert.deepEqual(await failStaleIntegrationEvents(client()), []);
  } finally {
    restore();
  }
});

function client() {
  return { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' };
}

function stubFetch(payload) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => payload };
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}
