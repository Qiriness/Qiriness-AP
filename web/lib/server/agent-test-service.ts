/**
 * Server-only service behind the Agent Setup test chat.
 *
 * WHAT IT IS. A rehearsal: a message an operator typed, put through the real
 * pipeline — the gate, identity, categorisation, investigation with real tools,
 * order resolution and context, drafting — with every decision recorded. The
 * passes are the worker's own (`agent/src/testing/run-rehearsal.mjs`); this
 * module only assembles what they need and stores what happened.
 *
 * IT WRITES NO TICKET. The harness substitutes an in-memory database under
 * `ticket-record.mjs` and `draft-record.mjs`, so a run touches no ticket, no
 * case file, no draft and no Insights view. The single row it does write is
 * `agent_test_runs`, which nothing downstream reads.
 *
 * IT SPENDS REAL MONEY. Five or six model calls per run, two of them on the
 * investigation and drafting tier. The cost is reported on the run and
 * deliberately kept out of `llm_usage` — see DECISIONS.md § Agent test chat.
 *
 * Uses the service-role key like every other server module here: every table has
 * RLS on with no policies. Never import this from a client component.
 */

import { loadAgentConfig } from "../../../agent/src/config.mjs";
import { logger } from "../../../agent/src/lib/logger.mjs";
import { createBrandVoiceStore } from "../../../agent/src/drafting/brand-voice.mjs";
import { articleReadiness as articleReadinessJs } from "../../../agent/src/testing/article-check.mjs";
import { runRehearsal as runRehearsalJs } from "../../../agent/src/testing/run-rehearsal.mjs";
import { maskEmail } from "../../../scripts/lib/compliance-audit.mjs";
import { estimateCost } from "../../../scripts/lib/llm-rates.mjs";
import { COLUMNS, T } from "../../../scripts/lib/tables.mjs";
import {
  createSupabaseClient,
  supabaseDelete,
  supabaseInsert,
  supabaseSelect,
  supabaseUpdateById,
} from "../../../scripts/lib/supabase-rest-client.mjs";

import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";

// The imported .mjs modules carry no declarations, so `allowJs` infers their
// signatures from the parameter defaults — which makes every option that
// defaults to `null` infer as `null` and reject a real argument. Re-declaring
// the two entry points here is the boundary: `any` stops at these two lines, and
// the shapes below keep the rest of the file type-safe.
const articleReadiness = articleReadinessJs as unknown as (input: {
  document: unknown;
  chunks: { category?: string; embedded: boolean }[];
}) => { ready: boolean; reason: string | null; message: string | null };

const runRehearsal = runRehearsalJs as unknown as (
  options: Record<string, unknown>
) => Promise<any>;

export interface RehearsalInput {
  name?: string | null;
  email?: string | null;
  subject?: string | null;
  body: string;
  orderNumber?: string | null;
}

export interface TestRunSummary {
  id: string;
  ranAt: string;
  status: "complete" | "gated" | "failed";
  subject: string | null;
  body: string;
  requesterMasked: string | null;
  orderNumber: string | null;
  expectDocumentId: string | null;
  articleVerdict: string | null;
  gateOutcome: string | null;
  category: string | null;
  requestKind: string | null;
  level: number | null;
  language: string | null;
  verdict: string | null;
  draftSkippedReason: string | null;
  draftChecksPassed: boolean | null;
  hasIdealAnswer: boolean;
  totalTokens: number;
}

/** What a run cost, priced at read time. `rated: false` means partly unpriced. */
export interface RunCost {
  usd: number;
  rated: boolean;
  models: string[];
}

export interface TestRunDetail extends TestRunSummary {
  requesterName: string | null;
  draftBody: string | null;
  draftDisposition: string | null;
  idealBody: string | null;
  idealSavedAt: string | null;
  trace: unknown[];
  tokens: { input: number; output: number; total: number; calls: number };
  failedPass: string | null;
  errorMessage: string | null;
}

let cachedConfig: ReturnType<typeof loadAgentConfig> | null = null;
let cachedClient: ReturnType<typeof createSupabaseClient> | null = null;

function getConfig() {
  if (!cachedConfig) cachedConfig = loadAgentConfig();
  return cachedConfig;
}

function getSupabaseClient() {
  if (!cachedClient) cachedClient = createSupabaseClient(getConfig());
  return cachedClient;
}

export async function getShopId(): Promise<string> {
  const config = getConfig();
  const rows = await supabaseSelect(getSupabaseClient(), T.SHOPS, { shop_domain: config.shopDomain }, "id");
  const id = rows?.[0]?.id;
  if (!id) {
    throw new KnowledgeNotFoundError(
      `No shop record found for ${config.shopDomain}. Run a Shopify sync at least once before testing the agent.`
    );
  }
  return id;
}

/**
 * What a run needs before it is worth paying for.
 *
 * Checked in the route before the first model call, because both answers are
 * free and both are the common case: no OpenAI key, or a brand voice nobody has
 * approved — and without the second the drafting pass refuses anyway, so the
 * operator would pay for four passes to be told at the end.
 */
export async function checkReadiness(shopId: string): Promise<{
  ready: boolean;
  problems: string[];
  brandVoiceApproved: boolean;
}> {
  const config = getConfig();
  const problems: string[] = [];
  if (!config.openaiApiKey) {
    problems.push("OPENAI_API_KEY is not set — every pass in a rehearsal is a model call.");
  }
  const brandVoice = await createBrandVoiceStore(getSupabaseClient()).load(shopId);
  const approved = brandVoice?.approvalStatus === "approved";
  if (!approved) {
    problems.push(
      "The Brand voice article is not approved, so the drafting pass will not write a reply. Everything before it still runs."
    );
  }
  // Only the missing key blocks. The brand voice is a warning: the
  // categorisation and the investigation are most of what this tool is for, and
  // they run perfectly well without an approved voice — only the reply does not.
  return { ready: Boolean(config.openaiApiKey), problems, brandVoiceApproved: approved };
}

/**
 * The article being tested, with the facts that decide whether retrieval could
 * reach it at all — approval, chunk count, embedded chunk count, categories.
 */
export async function loadExpectedArticle(shopId: string, documentId: string) {
  const supabase = getSupabaseClient();
  const [document] = await supabaseSelect(
    supabase,
    T.KNOWLEDGE_DOCUMENTS,
    { id: documentId, shop_id: shopId, deleted_at: { operator: "is", value: "null" } },
    "id,title,approval_status,core_topic,category",
    { limit: 1 }
  );
  if (!document) {
    throw new KnowledgeNotFoundError("That article no longer exists.");
  }
  const chunkRows = await supabaseSelect(
    supabase,
    T.KNOWLEDGE_CHUNKS,
    { knowledge_document_id: documentId },
    "id,category,embedding"
  );
  const chunks = chunkRows.map((row: any) => ({
    category: row.category,
    // The vector itself is never carried into this process — 1536 floats per
    // chunk to answer a boolean. Only whether one is there.
    embedded: row.embedding !== null && row.embedding !== undefined,
  }));
  return {
    document: { id: document.id, title: document.title, ...document },
    readiness: articleReadiness({ document, chunks }),
  };
}

/**
 * Run one rehearsal, streaming its steps, and store what happened.
 *
 * `onStep` is called with each trace event as it lands so the Route Handler can
 * stream the run: a rehearsal is tens of seconds across six model calls, and
 * watching the decisions arrive is most of the point.
 */
export async function rehearse({
  shopId,
  input,
  expectDocumentId = null,
  pastGate = false,
  onStep,
}: {
  shopId: string;
  input: RehearsalInput;
  expectDocumentId?: string | null;
  pastGate?: boolean;
  onStep?: (event: unknown) => void;
}): Promise<{ runId: string | null; result: any; cost: RunCost | null }> {
  if (!input?.body || input.body.trim() === "") {
    throw new KnowledgeValidationError("A test needs a message.");
  }
  const config = getConfig();
  if (!config.openaiApiKey) {
    throw new KnowledgeValidationError(
      "OPENAI_API_KEY is not set — every pass in a rehearsal is a model call."
    );
  }

  const supabase = getSupabaseClient();
  const expected = expectDocumentId ? await loadExpectedArticle(shopId, expectDocumentId) : null;
  const brandVoice = await createBrandVoiceStore(supabase).load(shopId);

  const result = await runRehearsal({
    supabase,
    shopId,
    config,
    logger,
    brandVoice,
    input,
    expectDocument: expected?.document ?? null,
    pastGate,
    onStep,
  });

  const runId = await storeRun({ shopId, input, expectDocumentId, result });
  return {
    runId,
    result,
    // Priced at read time from the rate card, exactly as the Insights panels do
    // it — the tokens are the durable fact, the euro figure is not.
    cost: estimateCostOf(result.trace, result.tokens),
  };
}

/**
 * The run, written down.
 *
 * ONE INSERT AT THE END rather than a row opened at the start and patched as it
 * goes: a rehearsal that crashed halfway would otherwise leave a half-run in the
 * history, and the trace is what makes a run readable — a row without one is
 * worse than no row.
 *
 * A failure to store must not lose the run the operator just watched, so this
 * returns null rather than throwing: they still have the transcript on screen.
 */
async function storeRun({
  shopId,
  input,
  expectDocumentId,
  result,
}: {
  shopId: string;
  input: RehearsalInput;
  expectDocumentId: string | null;
  result: any;
}): Promise<string | null> {
  try {
    const failure = result.trace.find((event: any) => event.type === "error");
    const [row] = await supabaseInsert(getSupabaseClient(), T.AGENT_TEST_RUNS, [
      {
        shop_id: shopId,
        // The mask and nothing else. The address the operator typed is usually a
        // real customer's, and a second plaintext copy of one is exactly what
        // SHOPIFY_PERSONAL_DATA_PROTECTION.md exists to prevent. The hash is not
        // stored either: nothing here matches on it, so it would be a bare
        // identifier with no reader.
        requester_name: input.name || null,
        requester_email_masked: maskEmail(input.email || null),
        subject: input.subject || null,
        body_text: input.body,
        order_number: input.orderNumber || null,
        expect_document_id: expectDocumentId,
        article_verdict: result.article?.verdict ?? null,
        status: result.status,
        gate_outcome: result.summary.gateOutcome,
        category: result.summary.category,
        request_kind: result.summary.requestKind,
        level: result.summary.level,
        language: result.summary.language,
        verdict: result.summary.verdict,
        draft_body_text: result.summary.draftBody,
        draft_skipped_reason: result.summary.draftSkippedReason,
        draft_checks_passed: result.summary.draftChecksPassed,
        draft_disposition: result.summary.draftDisposition,
        trace: result.trace,
        input_tokens: result.tokens.input,
        output_tokens: result.tokens.output,
        total_tokens: result.tokens.total,
        call_count: result.tokens.calls,
        failed_pass: failure ? lastPassBefore(result.trace) : null,
        error_message: result.error ?? null,
      },
    ]);
    return row?.id ?? null;
  } catch (error) {
    console.error("[agent-test] the run finished but could not be stored", error);
    return null;
  }
}

/** The history pane: this shop's runs, newest first, without their traces. */
export async function listRuns(shopId: string, { limit = 40 } = {}): Promise<TestRunSummary[]> {
  const rows = await supabaseSelect(
    getSupabaseClient(),
    T.AGENT_TEST_RUNS,
    { shop_id: shopId },
    COLUMNS.testRunForList,
    { order: "ran_at.desc", limit }
  );
  return rows.map(toSummary);
}

/** One run, opened. */
export async function getRun(shopId: string, id: string): Promise<TestRunDetail> {
  const [row] = await supabaseSelect(
    getSupabaseClient(),
    T.AGENT_TEST_RUNS,
    { id, shop_id: shopId },
    COLUMNS.testRunForDetail,
    { limit: 1 }
  );
  if (!row) {
    throw new KnowledgeNotFoundError("That test run no longer exists.");
  }
  return {
    ...toSummary(row),
    requesterName: row.requester_name ?? null,
    draftBody: row.draft_body_text ?? null,
    draftDisposition: row.draft_disposition ?? null,
    idealBody: row.ideal_body_text ?? null,
    idealSavedAt: row.ideal_saved_at ?? null,
    trace: Array.isArray(row.trace) ? row.trace : [],
    tokens: {
      input: row.input_tokens ?? 0,
      output: row.output_tokens ?? 0,
      total: row.total_tokens ?? 0,
      calls: row.call_count ?? 0,
    },
    failedPass: row.failed_pass ?? null,
    errorMessage: row.error_message ?? null,
  };
}

/**
 * What the operator would have sent instead.
 *
 * THE MEMORY. Same capture `ticket_draft_edits` makes for real mail, with the
 * difference that a rehearsal's situation can be invented — so an ideal answer
 * can be written for a case no customer has hit yet. Nothing reads these rows;
 * they are the corpus a later phase learns from.
 *
 * Clearing it clears the stamp too, which the check constraint requires: a
 * timestamp with no text would mean the save path wrote half a row.
 */
export async function saveIdealAnswer(
  shopId: string,
  id: string,
  body: string | null
): Promise<TestRunDetail> {
  const run = await getRun(shopId, id);
  const text = (body ?? "").trim();
  await supabaseUpdateById(getSupabaseClient(), T.AGENT_TEST_RUNS, run.id, {
    ideal_body_text: text === "" ? null : text,
    ideal_saved_at: text === "" ? null : new Date().toISOString(),
  });
  return getRun(shopId, id);
}

/** A run is an operator's note. Deleting one is theirs to do. */
export async function deleteRun(shopId: string, id: string): Promise<void> {
  await getRun(shopId, id);
  await supabaseDelete(getSupabaseClient(), T.AGENT_TEST_RUNS, { id, shop_id: shopId });
}

function toSummary(row: any): TestRunSummary {
  return {
    id: row.id,
    ranAt: row.ran_at,
    status: row.status,
    subject: row.subject ?? null,
    body: row.body_text ?? "",
    requesterMasked: row.requester_email_masked ?? null,
    orderNumber: row.order_number ?? null,
    expectDocumentId: row.expect_document_id ?? null,
    articleVerdict: row.article_verdict ?? null,
    gateOutcome: row.gate_outcome ?? null,
    category: row.category ?? null,
    requestKind: row.request_kind ?? null,
    level: row.level ?? null,
    language: row.language ?? null,
    verdict: row.verdict ?? null,
    draftSkippedReason: row.draft_skipped_reason ?? null,
    draftChecksPassed: row.draft_checks_passed ?? null,
    hasIdealAnswer: Boolean(row.ideal_body_text),
    totalTokens: row.total_tokens ?? 0,
  };
}

/**
 * What the run cost, priced per model.
 *
 * The trace records each call's model; `estimateCost` prices tokens against the
 * rate card in `llm-rates.mjs`. Null when no call carried a model, rather than
 * zero — on a cost figure a zero is a claim.
 */
function estimateCostOf(
  trace: any[],
  tokens: { input: number; output: number }
): { usd: number; rated: boolean; models: string[] } | null {
  const calls = trace.flatMap((event: any) => event.calls || []).filter((call: any) => call.model);
  if (calls.length === 0) return null;

  // Tokens are totalled per RUN rather than per call — the OpenAI client hands
  // the usage object to its sink, and the trace separately knows which model
  // each call used — so the per-model split is apportioned by call count. An
  // estimate of an estimate, and the UI says so.
  const byModel = new Map<string, number>();
  for (const call of calls) {
    byModel.set(call.model, (byModel.get(call.model) ?? 0) + 1);
  }

  let usd = 0;
  let rated = true;
  for (const [model, count] of byModel) {
    const share = count / calls.length;
    const priced = estimateCost({
      model,
      inputTokens: Math.round(tokens.input * share),
      outputTokens: Math.round(tokens.output * share),
    });
    // A model the rate card does not know contributes nothing and says so, so a
    // total is never presented as complete when part of it is unpriced.
    if (!priced.rated) rated = false;
    usd += priced.totalUsd;
  }
  return { usd, rated, models: [...byModel.keys()] };
}

/** Which pass was running when the run threw. */
function lastPassBefore(trace: any[]): string | null {
  const before = trace.filter((event: any) => event.type !== "error");
  return before.length > 0 ? before[before.length - 1].type : null;
}
