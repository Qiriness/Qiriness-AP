import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The order the poll runs its passes in.
 *
 * READ AS TEXT, because `index.mjs` calls `main()` at module scope and cannot be
 * imported without starting a worker. That is the same trade `_shared.test.mjs`
 * makes over the .sql files, and it is worth it here for the same reason: the
 * alternative is no guard at all.
 *
 * WHY THIS FILE EXISTS. The order was load-bearing, documented as load-bearing,
 * and asserted nowhere — so it drifted. Order resolution sat AFTER the
 * investigation while its own comment said "every order tool downstream needs its
 * output", and the cost was invisible: `getOrderContext` reads
 * `tickets.resolved_context` rather than querying, so every first email quoting an
 * order number was investigated as though no order existed. Caught by a rehearsal
 * of a real ticket (order #5144, quoted in the message, registered to the sender)
 * — the deterministic resolver confirmed it by email hash seconds after the
 * investigation had already recorded it as unverified and sent it to a human.
 *
 * Two things are asserted, and the pair is the point: what the stage list
 * DECLARES, and what the poll body actually DOES. A bug that moves one without
 * the other is exactly what happened.
 */

const SOURCE = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

/** The stages, in the order `PIPELINE_STAGES` declares them. */
function declaredStages() {
  const block = SOURCE.match(/const PIPELINE_STAGES = \[([\s\S]*?)\];/);
  assert.ok(block, 'PIPELINE_STAGES is not declared as an array literal any more');
  return [...block[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
}

/** The stages, in the order the poll body guards them. */
function executedStages() {
  return [...SOURCE.matchAll(/runsThrough\('([a-z]+)'\)/g)].map((m) => m[1]);
}

test('the poll runs the stages it declares, in the order it declares them', () => {
  // `ingest` is guarded inside the delta poll rather than by a `runsThrough`
  // call of its own, so it is the one declared stage with no guard to find.
  assert.deepEqual(executedStages(), declaredStages().filter((stage) => stage !== 'ingest'));
});

test('the order passes run BEFORE the investigation', () => {
  // THE REGRESSION THIS FILE EXISTS FOR. `getOrderContext` is a reader: it
  // returns what these two passes stored and never queries for itself, so an
  // investigation that runs first cannot see an order however clearly the
  // customer quoted its number.
  const stages = executedStages();
  assert.ok(
    stages.indexOf('orders') < stages.indexOf('investigate'),
    'order resolution must run before the investigation that reads its output'
  );
  assert.ok(
    stages.indexOf('context') < stages.indexOf('investigate'),
    'the order bundle must be built before the investigation that reads it'
  );
  assert.ok(
    stages.indexOf('orders') < stages.indexOf('context'),
    'the bundle is built from the confirmed number, so resolution comes first'
  );
});

test('the investigation still runs after categorisation', () => {
  // The labels choose the tool set, so investigating first would hand the agent
  // a registry built from the previous conversation's subject — or from none.
  const stages = executedStages();
  assert.ok(stages.indexOf('categorise') < stages.indexOf('investigate'));
});

test('forwarding still runs after categorisation', () => {
  // It routes on `category`, which does not exist until the categoriser writes it.
  const stages = executedStages();
  assert.ok(stages.indexOf('categorise') < stages.indexOf('forward'));
});

test('auto-close runs last, so it sees this poll’s own timestamps', () => {
  const stages = executedStages();
  assert.equal(stages.at(-1), 'close');
});

test('`--stop-after=categorise` still means what the corpus-building run needs', () => {
  // Documented in index.mjs: `ingest:once --limit=500 --stop-after=categorise`
  // ingests and labels a backlog without spending the mid tier on it. Moving the
  // order passes ahead of `categorise` would have quietly added two more stages
  // to that command, which is why they went after it instead.
  //
  // `casework` JOINED IT ON 2026-09-22, and this line is the deliberate change
  // rather than a test bending to fit. It has to run before the categoriser,
  // because the one decision it feeds is whether the labels need re-reading at
  // all — after it, the categoriser has already spent the call.
  //
  // WHAT IT COSTS THE BACKLOG RUN IS NOTHING, which is what makes the move
  // affordable. Casework claims only tickets that ALREADY have a case file, and
  // a corpus-building run over freshly ingested mail has none — so the stage is
  // present, claims an empty queue, and the command still ingests and labels for
  // exactly the price it did before.
  const declared = declaredStages();
  const throughCategorise = declared.slice(0, declared.indexOf('categorise') + 1);
  assert.deepEqual(throughCategorise, ['ingest', 'customers', 'casework', 'categorise']);
});

test('casework runs before the categoriser, which is the whole point of its position', () => {
  const declared = declaredStages();
  assert.ok(declared.indexOf('casework') < declared.indexOf('categorise'));
  // And after customer resolution, which needs no model key and identifies the
  // sender the reading is about.
  assert.ok(declared.indexOf('customers') < declared.indexOf('casework'));
});

test('the send pass runs after the fold and drafting, and before forwarding', () => {
  // After the fold: the pre-send check compares the approved case version with
  // the one this poll just folded. After drafting: an auto-send follows its draft.
  const stages = executedStages();
  assert.ok(stages.indexOf('fold') < stages.indexOf('send'));
  assert.ok(stages.indexOf('draft') < stages.indexOf('send'));
  assert.ok(stages.indexOf('send') < stages.indexOf('forward'));
});

test('--also can add back only the send stage, and runsThrough honours it', () => {
  // A sync-only worker with --also=send must never reach a model stage.
  assert.match(SOURCE, /if \(stage !== 'send'\) \{\s*throw new Error/);
  assert.match(SOURCE, /const runsThrough = \(stage\) =>[\s\S]*?\|\| also\.has\(stage\);/);
});

test('a sent reply is confirmed straight after the mailbox read, before the fold', () => {
  // Otherwise the fold first marks that draft superseded by our own reply.
  const sent = SOURCE.indexOf("folder: 'sentitems'");
  const confirm = SOURCE.indexOf('confirmSentActions({');
  const fold = SOURCE.indexOf('runFold({');
  assert.ok(sent > 0 && confirm > sent && confirm < fold);
});

test('the change router runs after the bundle is rebuilt and before the investigation', () => {
  // It compares the bundle `context` just rebuilt; a re-investigation it queues
  // must run in the same poll; the fold after both turns its drift into a version.
  const stages = executedStages();
  assert.ok(stages.indexOf('context') < stages.indexOf('route'));
  assert.ok(stages.indexOf('route') < stages.indexOf('investigate'));
  assert.ok(stages.indexOf('route') < stages.indexOf('fold'));
});

test('the change gate is the only binding of its name in the worker', () => {
  // 2026-10-06: it was called `gate`, and the poll body's spam filter declares
  // its own `gate` (`blocklistStore.loadGate`). The inner one shadowed it, every
  // `gate.run` threw « not a function », and every poll stopped after ingestion
  // for 23 minutes. No unit test runs this file, so the name is checked here.
  const declarations = SOURCE.match(/\b(?:const|let|var)\s+(?:\{[^}]*\bchangeGate\b[^}]*\}|changeGate\b)/g) ?? [];
  assert.equal(declarations.length, 1, 'declared once, in main');
  assert.ok(!/\bgate\.run\(/.test(SOURCE), 'nothing calls the ambiguous `gate.run`');
});
