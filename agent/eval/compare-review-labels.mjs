// Scores the categoriser against the human labels in categorisation_review.
//
// Runs AFTER labelling, on purpose: the agent's answer is computed here and
// written back, so the reviewer never sees it while deciding. Only rows with a
// human_category are scored — unlabelled rows are reported as pending, never
// counted as agreement.
//
// Touches the mailbox not at all. Reads categorisation_review, calls the real
// categoriser, writes the agent_* columns back to the same rows.
//
//   npm run review:compare
//   npm run review:compare -- --recategorise   # re-run the model on rows already scored
//   npm run review:compare -- --show-body      # include body excerpts in disagreements

import {
  createSupabaseClient,
  supabaseSelect,
  supabaseUpdateById
} from '../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { createOpenAIClient } from '../src/llm/openai-client.mjs';
import { createCategoriser } from '../src/pipeline/categorise.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';
import { defaultLevel } from '../../scripts/lib/support-taxonomy.mjs';
import { pct } from './score-categorisation.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadAgentConfig();
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const rows = await supabaseSelect(
    supabase,
    'categorisation_review',
    { shop_id: shopId },
    'id,subject,body_text,from_domain,received_at,blocklist_would_drop,' +
      'human_category,human_request_kind,human_level,human_notes,' +
      'agent_category,agent_request_kind,agent_level,categorised_at',
    { order: 'received_at.asc' }
  );

  const labelled = rows.filter((row) => row.human_category);
  const pending = rows.length - labelled.length;

  console.log(`\ncategorisation_review: ${rows.length} rows · ${labelled.length} labelled · ${pending} still to label`);
  if (labelled.length === 0) {
    console.log('\nNothing to score yet. Fill in human_category (and human_request_kind) first.\n');
    return;
  }

  const model = args.model || config.categoriserModel;
  const { categorise } = createCategoriser(
    createOpenAIClient({ apiKey: config.openaiApiKey }),
    { model }
  );

  const results = [];
  const failed = [];
  for (const row of labelled) {
    if (row.agent_category && !args.recategorise) {
      // Already scored: reuse the stored answer so a re-run is free and stable.
      results.push({
        row,
        agent: {
          category: row.agent_category,
          request_kind: row.agent_request_kind,
          level: row.agent_level
        }
      });
      continue;
    }

    try {
      // Only the subject and body reach the model. The human_* columns are read
      // for scoring and never enter the prompt.
      const result = await categorise({
        subject: row.subject,
        messages: [{ subject: row.subject, body_text: row.body_text }]
      });
      await supabaseUpdateById(supabase, 'categorisation_review', row.id, {
        agent_category: result.category,
        agent_request_kind: result.request_kind,
        agent_secondary_category: result.secondary_category,
        agent_secondary_request_kind: result.secondary_request_kind,
        agent_level: result.level,
        agent_reason: result.reason,
        agent_model: model,
        categorised_at: new Date().toISOString()
      });
      results.push({ row, agent: result });
      process.stdout.write('.');
    } catch (error) {
      // A transient network blip must not discard a whole run's work. Each row is
      // written as it completes, so a re-run resumes from the stored answers.
      failed.push({ id: row.id, message: error.message });
      process.stdout.write('!');
    }
  }
  process.stdout.write('\n');

  if (failed.length > 0) {
    console.log(`\n${failed.length} row(s) failed and were skipped — re-run to retry them:`);
    for (const f of failed.slice(0, 5)) console.log(`  ${f.id}: ${f.message}`);
  }

  report(results, args);
}

function report(results, args) {
  const total = results.length;
  let subjectOk = 0;
  let kindOk = 0;
  let levelOk = 0;
  let levelScored = 0;
  const confusions = new Map();

  for (const { row, agent } of results) {
    const subject = agent.category === row.human_category;
    const kind = !row.human_request_kind || agent.request_kind === row.human_request_kind;
    // A blank human_level means "whatever the pair derives" — score against that
    // rather than skipping, so an over-escalation still shows up.
    const expectedLevel = row.human_level
      ?? (row.human_request_kind ? defaultLevel(row.human_category, row.human_request_kind) : null);
    const level = expectedLevel === null ? null : agent.level === expectedLevel;

    if (subject) subjectOk += 1;
    if (kind) kindOk += 1;
    if (level !== null) {
      levelScored += 1;
      if (level) levelOk += 1;
    }
    if (!subject) {
      const key = `${row.human_category} -> ${agent.category}`;
      confusions.set(key, (confusions.get(key) || 0) + 1);
    }

    if (subject && kind && level !== false) continue;

    console.log(`\nX  ${row.received_at?.slice(0, 10)}  @${row.from_domain || '?'}` +
      `${row.blocklist_would_drop ? '  [blocklist would drop]' : ''}`);
    console.log(`   subject: ${row.subject || '(none)'}`);
    console.log(`   you   ${row.human_category}/${row.human_request_kind || '-'} L${expectedLevel ?? '-'}`);
    console.log(`   agent ${agent.category}/${agent.request_kind} L${agent.level}`);
    if (agent.reason) console.log(`   why   ${agent.reason}`);
    if (row.human_notes) console.log(`   note  ${row.human_notes}`);
    if (args.showBody) {
      console.log(`   body  ${(row.body_text || '').slice(0, 240).replace(/\s+/g, ' ')}...`);
    }
  }

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`subject  ${subjectOk}/${total} (${pct(subjectOk, total)})`);
  console.log(`kind     ${kindOk}/${total} (${pct(kindOk, total)})`);
  console.log(`level    ${levelOk}/${levelScored} (${pct(levelOk, levelScored)})`);
  if (confusions.size > 0) {
    const sorted = [...confusions.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\nconfusions: ${sorted.map(([k, n]) => `${k} (${n})`).join(', ')}`);
  }
  console.log();
}

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    model: get('model'),
    recategorise: argv.includes('--recategorise'),
    showBody: argv.includes('--show-body')
  };
}

main().catch((error) => {
  console.error(`\ncomparison failed: ${error.message}\n`);
  process.exitCode = 1;
});
