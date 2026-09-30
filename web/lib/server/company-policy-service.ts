/**
 * Server-only reader and writer for company policies: the library, its links
 * to situations and rules, and its versions. Every write goes through
 * scripts/lib/company-policies.mjs, the one writer the worker and the
 * rehearsal share. DECISIONS.md § Company policies.
 *
 * Uses the SERVICE ROLE key. Never import from a client component.
 */
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { createSupabaseClient, supabaseSelect } from "../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../scripts/lib/tables.mjs";
import {
  PolicyConflictError,
  createCompanyPolicyRecord,
  policyProblems,
} from "../../../scripts/lib/company-policies.mjs";

import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type { CompanyPolicy, CompanyPolicyLink, CompanyPolicyTargets } from "../types";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

function record(shopId: string) {
  return createCompanyPolicyRecord(getSupabaseClient(), { shopId });
}

type PolicyRow = {
  id: string;
  policy_key: string;
  name: string;
  purpose: string | null;
  content: string;
  active: boolean;
  version: number;
  updated_at: string | null;
};
type LinkRow = { id: string; policy_id: string; situation_key: string | null; answer_id: string | null };

function mapLink(row: LinkRow): CompanyPolicyLink {
  return { id: row.id, policyId: row.policy_id, situationKey: row.situation_key, answerId: row.answer_id };
}

function mapPolicy(row: PolicyRow, links: LinkRow[]): CompanyPolicy {
  return {
    id: row.id,
    key: row.policy_key,
    name: row.name,
    purpose: row.purpose ?? "",
    content: row.content,
    active: row.active,
    version: row.version,
    updatedAt: row.updated_at,
    links: links.filter((link) => link.policy_id === row.id).map(mapLink),
  };
}

/** Every policy, active or not, each with its links. */
export async function listCompanyPolicies(shopId: string): Promise<CompanyPolicy[]> {
  const { policies, links } = (await record(shopId).load()) as { policies: PolicyRow[]; links: LinkRow[] };
  return policies.map((row) => mapPolicy(row, links));
}

/** The situations and rules a link may point at, for naming them on screen. */
export async function listPolicyTargets(shopId: string): Promise<CompanyPolicyTargets> {
  const supabase = getSupabaseClient();
  const [situations, rules] = await Promise.all([
    supabaseSelect(supabase, T.SUPPORT_EXEMPLARS, { shop_id: shopId, deleted_at: { operator: "is", value: "null" } }, "exemplar_key,canonical_question", { order: "exemplar_key.asc" }),
    supabaseSelect(supabase, T.SUPPORT_ANSWERS, { shop_id: shopId, deleted_at: { operator: "is", value: "null" } }, "id,answer_key,situation_key,answer_set", { order: "answer_key.asc" }),
  ]);
  return {
    situations: (situations as { exemplar_key: string; canonical_question: string }[]).map((row) => ({
      key: row.exemplar_key,
      question: row.canonical_question,
    })),
    rules: (rules as { id: string; answer_key: string; situation_key: string | null; answer_set: string }[]).map((row) => ({
      id: row.id,
      answerKey: row.answer_key,
      situationKey: row.situation_key,
      answerSet: row.answer_set,
    })),
  };
}

const PROBLEMS: Record<string, string> = {
  bad_key: "The key is lower-case letters, digits and underscores, starting with a letter (delivery_time_policy).",
  no_name: "Give the policy a name.",
  no_content: "Write the policy's text.",
};

function refuse(problems: string[]): never {
  const [first] = problems;
  if (first.startsWith("unknown_parameter:")) {
    throw new KnowledgeValidationError(`No parameter is called {${first.slice("unknown_parameter:".length)}}. Use one from Parameters.`);
  }
  throw new KnowledgeValidationError(PROBLEMS[first] ?? `Cannot save: ${first}.`);
}

export interface PolicyInput {
  key?: string;
  name?: string;
  purpose?: string;
  content?: string;
  active?: boolean;
}

export async function createCompanyPolicy(shopId: string, input: PolicyInput, by: string | null): Promise<CompanyPolicy> {
  const problems = policyProblems({ key: input.key, name: input.name, content: input.content }, { isNew: true });
  if (problems.length > 0) refuse(problems);
  const policies = record(shopId);
  if (await policies.byKey(String(input.key))) {
    throw new KnowledgeValidationError(`A policy called ${input.key} already exists.`);
  }
  const row = (await policies.create(
    { key: String(input.key), name: String(input.name), purpose: input.purpose ?? "", content: String(input.content), active: input.active ?? true },
    { by }
  )) as PolicyRow;
  return mapPolicy(row, []);
}

/** Save a change. `expectedVersion` is the version the editor read: a stale save is refused. */
export async function saveCompanyPolicy(
  shopId: string,
  key: string,
  input: PolicyInput & { expectedVersion?: number },
  by: string | null
): Promise<CompanyPolicy> {
  const policies = record(shopId);
  const current = (await policies.byKey(key)) as PolicyRow | null;
  if (!current) throw new KnowledgeNotFoundError(`No policy called ${key}.`);
  const problems = policyProblems({
    key,
    name: input.name ?? current.name,
    content: input.content ?? current.content,
  });
  if (problems.length > 0) refuse(problems);
  try {
    const row = (await policies.save(
      key,
      { name: input.name, purpose: input.purpose, content: input.content, active: input.active },
      { expectedVersion: input.expectedVersion, by }
    )) as PolicyRow;
    const { links } = (await policies.load()) as { links: LinkRow[] };
    return mapPolicy(row, links);
  } catch (error) {
    if (error instanceof PolicyConflictError) throw new KnowledgeValidationError(error.message);
    throw error;
  }
}

/** Make a policy available to a situation or to one rule. Linking twice is a no-op. */
export async function linkCompanyPolicy(
  shopId: string,
  { policyKey, situationKey = null, answerId = null }: { policyKey: string; situationKey?: string | null; answerId?: string | null },
  by: string | null
): Promise<CompanyPolicyLink> {
  if (Boolean(situationKey) === Boolean(answerId)) {
    throw new KnowledgeValidationError("Link a policy to a situation or to a rule.");
  }
  const policies = record(shopId);
  const policy = (await policies.byKey(policyKey)) as PolicyRow | null;
  if (!policy) throw new KnowledgeNotFoundError(`No policy called ${policyKey}.`);
  const { link } = await policies.link(policy.id, { situationKey, answerId }, { by });
  if (!link) throw new KnowledgeValidationError("The link could not be read back.");
  return mapLink(link as LinkRow);
}

export async function unlinkCompanyPolicy(shopId: string, linkId: string): Promise<boolean> {
  return record(shopId).unlink(linkId);
}
