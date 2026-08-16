import { pathToFileURL } from 'node:url';

import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import {
  clusterByAverageLink,
  dedupeNearIdentical,
  parseVector,
  cosine
} from './lib/cluster-messages.mjs';
import { partitionBy } from './lib/message-audience.mjs';
import { createClusterStore } from './lib/cluster-store.mjs';
import {
  createSenderDirectoryStore,
  emptySenderDirectory
} from '../agent/src/ingestion/sender-directory.mjs';
import { resolveShopId } from '../agent/src/lib/shop.mjs';

// Turns the embedded support inbox into a ranked list of recurring topics, per
// subject — a decision aid for "what should the knowledge library cover first?"
// and "which threads should become exemplars?".
//
// READ-ONLY BY DEFAULT. Selects vectors that ingestion already stored and prints
// a report; nothing is written, no model is called, and it costs nothing to
// re-run. `--save` additionally persists the run to cluster_runs +
// ticket_clusters for the dashboard to read — opt-in precisely because the
// no-side-effects promise above is what makes this safe to run while tuning the
// threshold, and a flag that defaulted to on would quietly spend a rebuild of
// the stored map on every experiment.
//
// Clusters WITHIN a subject, not globally: clustering globally would mostly
// rediscover the categories the taxonomy already assigns. The value is the
// sub-topic resolution inside a subject — `order` splits into checkout failures,
// dispatch delays and free-gift problems, which are three different articles
// that no label distinguishes.
//
// AUDIENCE. Reports on customer mail only. `direction` records which way a
// message crossed the mailbox, not who wrote it, so a colleague writing to the
// support address counts as `inbound` — and 30% of the corpus is exactly that.
// Mail from our own domain is excluded by default; `--internal` reports on it
// instead, and `--all-senders` restores the old undifferentiated behaviour.
//
//   npm run cluster:tickets
//   npm run cluster:tickets -- --subject=order
//   npm run cluster:tickets -- --threshold=0.74     # tighter, more groups
//   npm run cluster:tickets -- --min-size=3 --show=4
//   npm run cluster:tickets -- --internal           # our own recurring threads
//   npm run cluster:tickets:save                    # same report, and store it
//
// THRESHOLD. 0.68 by default, tuned by eye on this corpus. French support mail
// shares so much boilerplate ("Bonjour ... Cordialement") that two unrelated
// emails already sit near 0.55, so the useful band is narrow: below ~0.6
// everything merges into one blob, above ~0.74 it fragments into singletons.
// That floor is corpus-specific — re-tune if the mail changes character.

const DEFAULTS = {
  threshold: 0.68,
  minSize: 2,
  dedupe: 0.97,
  show: 3 // example messages printed per group, besides the representative
};

const EXCERPT = 96;

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  // Local rather than the shared parseArgs: that one has a fixed shape
  // (dry-run/limit/page-size) and would silently drop these flags.
  const args = parseFlags(process.argv.slice(2));
  const options = {
    threshold: numberArg(args.threshold, DEFAULTS.threshold),
    minSize: numberArg(args['min-size'], DEFAULTS.minSize),
    dedupe: numberArg(args.dedupe, DEFAULTS.dedupe),
    show: numberArg(args.show, DEFAULTS.show),
    subject: args.subject || null,
    audience: args['all-senders'] ? 'all' : args.internal ? 'internal' : 'customer',
    save: Boolean(args.save)
  };

  const config = loadConfig(loadEnv());
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  // WHO COUNTS AS A CUSTOMER comes from sender_directory, not from
  // INTERNAL_EMAIL_DOMAINS. The env var could not express the distinction this
  // report needs — Deret is operational noise, Nocibé is a customer who happens
  // to be a shop — and, having lived in a file rather than the database, it did
  // not survive a project move: 43 internal messages were ranked as customer
  // demand until somebody noticed. See 04_support.sql.
  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.supportMailbox
  });

  if (senderDirectory.size === 0 && options.audience !== 'all') {
    console.log(
      'Warning: sender_directory is empty and SUPPORT_MAILBOX is unset, so our own\n' +
        'mail cannot be told from customer mail. Reporting on every sender — the\n' +
        'writing order below will rank internal threads as customer demand.\n'
    );
  }

  const result = await report({ supabase, options, senderDirectory });

  // Saving is deliberately downstream of the report and never changes it: the
  // terminal output is identical with and without the flag, so nobody has to
  // choose between seeing the answer and storing it.
  if (options.save && result) {
    const saved = await createClusterStore(supabase).saveRun(
      { shopId, ...result.facts },
      result.clusters
    );
    console.log(
      `Saved run ${saved.runId} — ${saved.clusterCount} topic(s)` +
        (saved.prunedRuns > 0 ? `, ${saved.prunedRuns} older run(s) pruned` : '') +
        '\n'
    );
  }
}

/**
 * Prints the report and returns what `--save` needs to store it, or null when
 * there was nothing to report on.
 *
 * The return value is a by-product of printing rather than a second pass over
 * the data: a stored map that disagreed with the terminal it was printed
 * alongside would be worse than no stored map at all.
 */
export async function report({ supabase, options, senderDirectory = emptySenderDirectory }) {
  const loaded = await loadInboundMessages(supabase, options.subject);
  const { customer, internal } = partitionBy(loaded, (from) => senderDirectory.isNonDemand(from));
  const messages =
    options.audience === 'all' ? loaded : options.audience === 'internal' ? internal : customer;

  if (messages.length === 0) {
    console.log(
      options.subject
        ? `No embedded inbound messages for subject "${options.subject}".`
        : 'No embedded inbound messages. Run `npm run embed:tickets` first.'
    );
    return null;
  }

  // Knowledge coverage is reported alongside each topic: a cluster whose
  // representative already matches an approved chunk is answered, and a large
  // cluster with no match is precisely the gap worth writing.
  const chunks = await loadEmbeddedChunks(supabase);

  const bySubject = new Map();
  for (const message of messages) {
    if (!bySubject.has(message.subject_category)) {
      bySubject.set(message.subject_category, []);
    }
    bySubject.get(message.subject_category).push(message);
  }

  const audienceLabel =
    options.audience === 'internal'
      ? 'from our own domain — internal threads, not customer demand'
      : options.audience === 'all'
        ? 'from every sender, ours included'
        : `from customers · ${internal.length} internal message(s) excluded`;

  console.log(
    `\n${messages.length} embedded inbound message(s) ${audienceLabel}\n` +
      `across ${bySubject.size} subject(s) · threshold ${options.threshold} · ` +
      `${chunks.length} embedded knowledge chunk(s)\n`
  );

  const summaries = [];
  for (const [subject, items] of [...bySubject.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )) {
    summaries.push(reportSubject({ subject, items, chunks, options }));
  }

  console.log(`${'='.repeat(72)}`);
  console.log('Largest uncovered topics — the writing order suggested by real demand:\n');
  const uncovered = summaries
    .flatMap((s) => s.groups.map((g) => ({ subject: s.subject, ...g })))
    .filter((g) => !g.covered)
    .sort((a, b) => b.size - a.size)
    .slice(0, 8);
  for (const g of uncovered) {
    console.log(`  ${String(g.size).padStart(3)} msgs  [${g.subject}]  ${g.excerpt}`);
  }
  console.log();

  return {
    summaries,
    facts: {
      threshold: options.threshold,
      minSize: options.minSize,
      dedupe: options.dedupe,
      messageCount: messages.length,
      // What the sender directory kept OUT of this report. Zero on the other
      // two audiences by definition: `--internal` reports on our own mail and
      // `--all-senders` excludes nobody, so neither skipped anything for being
      // ours, and recording the other side of the split there would make the
      // column mean two different things depending on the flag.
      internalExcluded: options.audience === 'customer' ? internal.length : 0,
      subjectCount: bySubject.size,
      topicCount: summaries.reduce((n, s) => n + s.groups.length, 0)
    },
    clusters: toClusterRecords(summaries)
  };
}

/**
 * The per-subject summaries, flattened into one row per topic.
 *
 * `clusterIndex` is the topic's position within ITS subject, not within the
 * flat list: (run_id, subject, cluster_index) is the unique key, and the groups
 * arrive already ranked by size, so the position is the rank.
 */
export function toClusterRecords(summaries) {
  return summaries.flatMap((summary) =>
    summary.groups.map((group, clusterIndex) => ({
      subject: summary.subject,
      clusterIndex,
      size: group.size,
      cohesion: group.cohesion,
      representativeExcerpt: group.representativeExcerpt,
      memberMessageIds: group.memberMessageIds
    }))
  );
}

function reportSubject({ subject, items, chunks, options }) {
  const deduped = dedupeNearIdentical(items, { threshold: options.dedupe });
  const collapsed = items.length - deduped.length;
  const groups = clusterByAverageLink(deduped, {
    threshold: options.threshold,
    minSize: options.minSize
  });

  const grouped = groups.reduce((n, g) => n + g.size, 0);
  console.log(`${'-'.repeat(72)}`);
  console.log(
    `${subject.toUpperCase()} — ${items.length} message(s)` +
      (collapsed > 0 ? `, ${collapsed} near-duplicate(s) collapsed` : '') +
      ` · ${groups.length} topic(s) covering ${grouped}\n`
  );

  const reported = [];
  for (const group of groups) {
    const match = bestChunk(group.medoid, chunks);
    const coverage = classifyCoverage(match);
    console.log(
      `  [${group.size} msgs · cohesion ${group.weight.toFixed(2)}] ` +
        (match && coverage !== 'none'
          ? `${coverage === 'covered' ? 'covered by' : 'weak match:'} ${match.category} (${match.score.toFixed(2)})`
          : 'NO ARTICLE')
    );
    console.log(`     ${excerpt(group.medoid.body_text)}`);
    for (const member of group.members.filter((m) => m.id !== group.medoid.id).slice(0, options.show)) {
      console.log(`       · ${excerpt(member.body_text)}`);
    }
    console.log();
    reported.push({
      size: group.size,
      covered: coverage === 'covered',
      excerpt: excerpt(group.medoid.body_text, 58),
      // The rest is for `--save` only, and is taken from the same values the
      // lines above printed rather than recomputed.
      cohesion: group.weight,
      representativeExcerpt: condense(group.medoid.body_text),
      memberMessageIds: memberMessageIds(group)
    });
  }

  if (groups.length === 0) {
    console.log('  no repeated topic above the threshold — every message is its own case\n');
  }
  return { subject, total: items.length, groups: reported };
}

/**
 * Three bands, not a boolean, because the cut-off is not yet trustworthy.
 * Measured against the current 11 chunks, a genuinely correct match scored 0.62
 * while topics with no article at all still scored 0.38-0.48 — so anything in
 * between is reported as weak rather than claimed as covered. Re-calibrate once
 * the library is real; until then the honest answer is "probably not covered".
 */
function classifyCoverage(match) {
  if (!match || match.score < 0.45) return 'none';
  return match.score >= 0.6 ? 'covered' : 'weak';
}

/**
 * Best-matching approved chunk for a group's representative. Deliberately not
 * category-filtered: the point is to find whatever already answers this topic,
 * including a general FAQ chunk written under a different subject.
 */
function bestChunk(message, chunks) {
  let best = null;
  for (const chunk of chunks) {
    const score = cosine(message.vector, chunk.vector);
    if (!best || score > best.score) {
      best = { score, category: chunk.category };
    }
  }
  return best;
}

/**
 * Paged, not a single large `limit`. PostgREST silently caps a response at
 * `db-max-rows` (1000), so the previous `limit: 5000` was reading 1000 of 1111
 * embedded messages and reporting on the remainder as if it were the corpus.
 * See `supabaseSelectAll`.
 */
async function loadInboundMessages(supabase, subject) {
  const tickets = await supabaseSelectAll(
    supabase,
    'tickets',
    subject
      ? { category: subject, deleted_at: { operator: 'is', value: 'null' } }
      : {
          category: { operator: 'not.is', value: 'null' },
          deleted_at: { operator: 'is', value: 'null' }
        },
    'id,category'
  );
  const categoryByTicket = new Map(tickets.map((t) => [t.id, t.category]));

  const rows = await supabaseSelectAll(
    supabase,
    'ticket_messages',
    {
      direction: 'inbound',
      embedding: { operator: 'not.is', value: 'null' },
      deleted_at: { operator: 'is', value: 'null' }
    },
    'id,ticket_id,from_email,body_text,embedding'
  );

  return rows
    .filter((row) => categoryByTicket.has(row.ticket_id))
    .map((row) => ({
      id: row.id,
      from_email: row.from_email,
      body_text: row.body_text,
      subject_category: categoryByTicket.get(row.ticket_id),
      vector: parseVector(row.embedding)
    }));
}

async function loadEmbeddedChunks(supabase) {
  const rows = await supabaseSelectAll(
    supabase,
    'knowledge_chunks',
    { embedding: { operator: 'not.is', value: 'null' } },
    'id,category,embedding'
  );
  return rows.map((row) => ({ category: row.category, vector: parseVector(row.embedding) }));
}

/**
 * Every message the topic stands for, near-duplicates included.
 *
 * `dedupeNearIdentical` collapses a resent email into one survivor carrying the
 * ids it absorbed, and `size` counts them — so leaving them out here would give
 * a stored cluster fewer members than its own size claims, and "which cluster
 * is this message in?" (the GIN index on the column) would answer nothing for
 * every duplicate.
 */
function memberMessageIds(group) {
  return group.members.flatMap((member) => [member.id, ...(member.duplicateIds || [])]);
}

/** The printed form: the condensed text, quoted. */
function excerpt(text, length = EXCERPT) {
  return `"${condense(text, length)}"`;
}

/**
 * Whitespace collapsed, cut to `length`.
 *
 * Split out of `excerpt` so a saved run stores exactly what the report printed
 * minus the display quotes. One truncation rule, so the stored map and the
 * terminal cannot disagree about what a topic is about.
 */
function condense(text, length = EXCERPT) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, length);
}

/** `--key=value` flags into an object; unknown keys are simply carried through. */
function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (match) {
      flags[match[1]] = match[2] ?? true;
    }
  }
  return flags;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
