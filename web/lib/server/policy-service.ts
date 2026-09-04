/**
 * Server-only reader and writer for the policy rules — `support_answers`.
 *
 * THE VOCABULARY IS NOT DEFINED HERE, and that is the whole point of the file.
 * Which states a rule may branch on, which facts it may ask for, and where it may
 * route are owned by `agent/src/investigation/*` and imported. A second list in
 * `web/` would let the dashboard offer a state the agent cannot score — a rule
 * that saves, reads correctly, and can never fire.
 *
 * VALIDATION IS THE AGENT'S OWN FUNCTIONS. `normaliseConditions` drops a need or
 * a finding the vocabulary does not know, and comparing what it kept against what
 * was sent is how a typo becomes a rejected save rather than a dead branch.
 * `auditAnswerSet` is the same check the worker would apply, run before the row
 * exists instead of after.
 *
 * Uses the SERVICE ROLE key, like every other service here. Never import from a
 * client component.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseDelete,
  supabaseSelect,
  supabaseUpdate,
  supabaseUpsert,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../scripts/lib/tables.mjs";
import {
  auditAnswerSet,
  normaliseConditions as normaliseConditionsRaw,
} from "../../../agent/src/investigation/answer-selection.mjs";
import {
  NEED_KEYS,
  findingValues,
  needRequires,
} from "../../../agent/src/investigation/evidence-rules.mjs";
import { MISSING_FIELDS, VERDICTS } from "../../../agent/src/investigation/case-file.mjs";
import { PARAMETERS } from "../../../scripts/lib/parameters.mjs";

import { listPinnableArticles } from "./knowledge-service";
import { listOfferableCodes } from "./promotions-service";
import { listParameters } from "./parameters-service";

import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";

/**
 * The shared normaliser, retyped at the boundary.
 *
 * `answer-selection.mjs` declares its `warn` option through a JSDoc default, so
 * TypeScript reads the parameter as taking nothing and rejects a handler that
 * wants the message. Narrowing here rather than casting at the call site keeps
 * the one place the two languages meet visible, and keeps the .mjs the single
 * definition of what a condition is.
 */
const normaliseConditions = normaliseConditionsRaw as (
  raw: unknown,
  options?: { warn?: (message: string) => void },
) => Record<string, string[]>;
import type { PolicyRule, PolicyVocabulary } from "../types";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

export async function getShopId(): Promise<string> {
  const config = loadConfig(process.env as Record<string, string | undefined>);
  const rows = await supabaseSelect(
    getSupabaseClient(),
    "shops",
    { shop_domain: config.shopDomain },
    "id",
  );
  const id = rows?.[0]?.id;
  if (!id) {
    throw new KnowledgeNotFoundError(`No shop record found for ${config.shopDomain}.`);
  }
  return id;
}

/**
 * Everything the rule editor needs to offer only valid choices, derived from the
 * agent's own tables at request time.
 *
 * NEEDS WITH NO FINDINGS ARE EXCLUDED, not listed as empty. `return_eligibility`
 * and `refund_state` exist as needs and have no states yet, so a rule cannot
 * branch on them — offering them would be offering a branch that never fires.
 * The count of what is missing is worth showing somewhere; a dropdown is not it.
 *
 * `answerable` is absent from `routes` for the reason the check constraint gives:
 * a rule may hand a ticket to a person, never declare one safe.
 */
/**
 * The two closed lists, as constants.
 *
 * SEPARATE FROM `policyVocabulary` because saving a rule has to check them and
 * saving is not the place to read the parameter table — validation must not
 * depend on a query that can fail.
 */
const ROUTES: string[] = VERDICTS.filter((verdict: string) => verdict !== "answerable");
const ASKS: string[] = Object.keys(MISSING_FIELDS);

export async function policyVocabulary(shopId?: string): Promise<PolicyVocabulary> {
  const needs = NEED_KEYS.map((need: string) => ({
    need,
    findings: (findingValues(need) as string[] | null) ?? [],
    requires: needRequires(need),
    // Which parameter this state is computed from, when it is computed from one.
    // The editor does not offer it as a CONDITION — you pick the state, not the
    // number behind it — but it must say so when the number is missing, because
    // a rule branching on a state nothing can compute is a rule that never fires.
    poweredBy: (POWERED_BY as Record<string, string | undefined>)[need] ?? null,
  })).filter((entry: { findings: string[] }) => entry.findings.length > 0);

  // Which of those parameters are actually set, so the editor can warn rather
  // than let somebody write a dead rule and find out from a transcript.
  const parameters = shopId ? await listParameters(shopId) : [];
  const unsetParameters = parameters.filter((p) => p.value === null).map((p) => p.key);

  // The codes an operator has cleared for customers, so the editor can offer a
  // choice rather than a free text box. A rule naming a code nobody cleared would
  // be dropped at drafting time and look, from the rulebook, as though it worked.
  const offerableCodes = shopId ? await listOfferableCodes(shopId) : [];

  // The approved articles a rule may answer from. Same reasoning as the codes:
  // a picker rather than an id typed by hand, and only what is approved, so the
  // rulebook cannot offer a pin that drafting will drop.
  const articles = shopId ? await listPinnableArticles(shopId) : [];

  return {
    needs,
    routes: ROUTES,
    asks: ASKS,
    offerableCodes,
    articles,
    // For the skeleton box: a parameter is inserted as a placeholder, which is
    // the one place a rule names one directly.
    parameters: Object.entries(PARAMETERS).map(([key, meta]) => ({
      key,
      label: (meta as { label: string }).label,
      set: !unsetParameters.includes(key),
    })),
  };
}

/**
 * State → the parameter it is computed from.
 *
 * DECLARED HERE RATHER THAN DERIVED, because the wiring lives inside a deriver
 * and nothing exposes it. Small and worth the duplication: without it the editor
 * cannot explain why a state it offers will never resolve, which is the one
 * question somebody writing a returns rule today would ask.
 */
const POWERED_BY: Record<string, string> = {
  return_eligibility: "returns_window_days",
};

export async function listRules(shopId: string, answerSet?: string): Promise<PolicyRule[]> {
  const rows = (await supabaseSelect(
    getSupabaseClient(),
    T.SUPPORT_ANSWERS,
    {
      shop_id: shopId,
      ...(answerSet ? { answer_set: answerSet } : {}),
      deleted_at: { operator: "is", value: "null" },
    },
    "id,answer_set,answer_key,situation_key,when_conditions,answer_skeleton,route,ask,offer_code,knowledge_document_id,priority,is_fallback,approval_status,updated_at",
  )) as Record<string, unknown>[];

  return rows.map(mapRule).sort(byAnswerSetThenKey);
}

/** The situations a rule may be keyed to, so the editor offers keys that exist. */
export async function listSituations(
  shopId: string,
): Promise<
  { key: string; question: string; category: string | null; answerSet: string | null; collectionMode: string }[]
> {
  const rows = (await supabaseSelect(
    getSupabaseClient(),
    T.SUPPORT_EXEMPLARS,
    { shop_id: shopId, deleted_at: { operator: "is", value: "null" } },
    "exemplar_key,canonical_question,category,answer_set,collection_mode",
  )) as Record<string, unknown>[];

  return rows
    .map((row) => ({
      key: String(row.exemplar_key),
      question: String(row.canonical_question ?? ""),
      category: (row.category as string) ?? null,
      answerSet: (row.answer_set as string) ?? null,
      collectionMode: (row.collection_mode as string) ?? "model",
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export interface RuleInput {
  answerSet: string;
  answerKey: string;
  situationKey: string | null;
  conditions: Record<string, string[]>;
  answerSkeleton: string | null;
  route: string | null;
  /** MISSING_FIELDS keys. A list since one reply can need two facts. */
  ask: string[];
  /** A live discount code this rule hands the customer, or null. */
  offerCode: string | null;
  /** The approved article this rule answers from, or null. */
  knowledgeDocumentId: string | null;
  priority: number;
  isFallback: boolean;
  approvalStatus: string;
}

/**
 * Saves a rule, refusing anything the agent could not act on.
 *
 * THE CHECKS MIRROR THE SCHEMA RATHER THAN TRUSTING IT. Postgres would reject a
 * bad `route` or an `ask` without one, and a constraint violation surfaces as a
 * 500 with a Postgres string in it. These produce the same refusals as sentences
 * a person can act on — and the schema still stands behind them, which is what
 * makes it safe for this to be the friendly copy rather than the only copy.
 */
export async function saveRule(shopId: string, input: RuleInput): Promise<PolicyRule> {
  const answerSet = input.answerSet?.trim();
  const answerKey = input.answerKey?.trim();
  if (!answerSet || !answerKey) {
    throw new KnowledgeValidationError("A rule needs an answer set and a key.");
  }

  // A condition the vocabulary rejects is a branch that can never fire, so it is
  // refused rather than silently dropped — the failure hardest to see later.
  const dropped: string[] = [];
  const conditions = normaliseConditions(input.conditions, {
    warn: (message: string) => {
      dropped.push(message);
    },
  });
  if (dropped.length > 0) {
    throw new KnowledgeValidationError(dropped.join("; "));
  }

  if (input.route && !ROUTES.includes(input.route)) {
    throw new KnowledgeValidationError(
      `A rule may route to ${ROUTES.join(" or ")} — never to answerable.`,
    );
  }
  // De-duplicated, because two copies of a key would put the same question in a
  // reply twice — `buildCaseFile` already refuses to push a field `missing`
  // holds, but a rule carrying it twice is an authoring mistake worth naming.
  const asks = [...new Set((input.ask ?? []).map((key) => String(key ?? "").trim()).filter(Boolean))];
  const unknown = asks.filter((key) => !ASKS.includes(key));
  if (unknown.length > 0) {
    throw new KnowledgeValidationError(
      `There is no approved question for ${unknown.map((k) => `“${k}”`).join(", ")}.`,
    );
  }
  if (asks.length > 0 && input.route !== "needs_customer_input") {
    throw new KnowledgeValidationError(
      "A rule that asks the customer for something must also route to needs_customer_input.",
    );
  }

  const shaped = {
    answerKey,
    situationKey: input.situationKey || null,
    conditions,
    route: input.route || null,
    ask: asks,
    offerCode: input.offerCode?.trim() || null,
    knowledgeDocumentId: input.knowledgeDocumentId?.trim() || null,
    priority: input.priority ?? 0,
    isFallback: Boolean(input.isFallback),
  };
  const problems = auditAnswerSet([shaped]) as string[];
  if (problems.length > 0) {
    throw new KnowledgeValidationError(problems.join("; "));
  }

  const rows = (await supabaseUpsert(
    getSupabaseClient(),
    T.SUPPORT_ANSWERS,
    [
      {
        shop_id: shopId,
        answer_set: answerSet,
        answer_key: answerKey,
        situation_key: shaped.situationKey,
        when_conditions: conditions,
        answer_skeleton: input.answerSkeleton?.trim() || null,
        route: shaped.route,
        ask: shaped.ask,
        offer_code: shaped.offerCode,
        knowledge_document_id: shaped.knowledgeDocumentId,
        priority: shaped.priority,
        is_fallback: shaped.isFallback,
        approval_status: input.approvalStatus || "draft",
      },
    ],
    "shop_id,answer_set,answer_key",
  )) as Record<string, unknown>[];

  return mapRule(rows[0]);
}

/**
 * Approval, on its own endpoint.
 *
 * SEPARATE FROM SAVING BECAUSE IT IS A DIFFERENT DECISION. Editing a rule is
 * authoring; approving one is what lets it move somebody's mail. Folding the two
 * together would mean a typo fix silently re-approving a rule that had been
 * withdrawn.
 */
export async function setRuleApproval(
  shopId: string,
  id: string,
  approvalStatus: string,
): Promise<PolicyRule> {
  const rows = (await supabaseUpdate(
    getSupabaseClient(),
    T.SUPPORT_ANSWERS,
    { id, shop_id: shopId },
    { approval_status: approvalStatus },
  )) as Record<string, unknown>[];

  if (!rows?.[0]) {
    throw new KnowledgeNotFoundError(`Rule not found: ${id}`);
  }
  return mapRule(rows[0]);
}

export async function deleteRule(shopId: string, id: string): Promise<void> {
  await supabaseDelete(getSupabaseClient(), T.SUPPORT_ANSWERS, { id, shop_id: shopId });
}

/**
 * Turns rule-directed collection on or off for one situation.
 *
 * PER SITUATION, SET BY A PERSON, and never inferred from how many rules exist:
 * a set with three of eight rules approved converges FASTER than a complete one,
 * so readiness measured by rule count would rate it highest exactly when it is
 * least ready.
 */
export async function setCollectionMode(
  shopId: string,
  exemplarKey: string,
  mode: "model" | "rule_directed",
): Promise<void> {
  if (mode !== "model" && mode !== "rule_directed") {
    throw new KnowledgeValidationError("A situation collects either by model or by rule.");
  }
  await supabaseUpdate(
    getSupabaseClient(),
    T.SUPPORT_EXEMPLARS,
    { shop_id: shopId, exemplar_key: exemplarKey },
    { collection_mode: mode },
  );
}

function mapRule(row: Record<string, unknown>): PolicyRule {
  return {
    id: String(row.id),
    answerSet: String(row.answer_set),
    answerKey: String(row.answer_key),
    situationKey: (row.situation_key as string) ?? null,
    conditions: (row.when_conditions as Record<string, string[]>) ?? {},
    answerSkeleton: (row.answer_skeleton as string) ?? null,
    route: (row.route as string) ?? null,
    // Tolerates the singular column a row may predate the list change with.
    ask: Array.isArray(row.ask) ? (row.ask as string[]) : row.ask ? [String(row.ask)] : [],
    offerCode: (row.offer_code as string) ?? null,
    knowledgeDocumentId: (row.knowledge_document_id as string) ?? null,
    priority: Number(row.priority ?? 0),
    isFallback: Boolean(row.is_fallback),
    approvalStatus: String(row.approval_status ?? "draft"),
    updatedAt: (row.updated_at as string) ?? null,
  };
}

/** Shared rules first within a set, then by key — the order they are read in. */
function byAnswerSetThenKey(a: PolicyRule, b: PolicyRule): number {
  if (a.answerSet !== b.answerSet) return a.answerSet.localeCompare(b.answerSet);
  if (Boolean(a.situationKey) !== Boolean(b.situationKey)) return a.situationKey ? 1 : -1;
  return (a.situationKey ?? "").localeCompare(b.situationKey ?? "") || a.answerKey.localeCompare(b.answerKey);
}
