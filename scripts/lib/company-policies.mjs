import { fillParameters } from './parameters.mjs';
import { supabaseDelete, supabaseInsert, supabaseSelect, supabaseSelectAll, supabaseUpdate } from './supabase-rest-client.mjs';
import { T } from './tables.mjs';

/**
 * Company policies: the company's rules (delivery times, where we deliver,
 * returns, refunds), each written once and read by reference.
 *
 * NOT THE RULEBOOK. The rulebook is already called « policy » in this codebase
 * (policy-service.ts, PolicyRule, exemplar_match.policy): it decides what
 * happens in a case. A company policy only says what the company's rule is. It
 * never sets a verdict, a need or a status, and nothing derives one from it.
 *
 * HOW A POLICY REACHES THE AGENT, three ways, all recorded on the case file:
 *   situation — linked to the matched situation: fetched before the model's
 *               first turn, no model call;
 *   rule      — linked to the selected rule: attached after selection;
 *   agent     — any other active policy the model chose to fetch with the one
 *               tool, getPolicy(policy_key), for a second question.
 *
 * REFERENCES, NEVER COPIES. A link names the policy; drafting reads its current
 * text by key, so editing a policy changes every situation and rule that uses
 * it from the next reply on. Each version's text is kept for the record.
 *
 * The only writer of company_policies, company_policy_versions and
 * company_policy_links, shared by the dashboard, the worker and the rehearsal.
 */

export const POLICY_KEY_SHAPE = /^[a-z][a-z0-9_]*$/;

/** Why a policy reached a case. Mirrors the comment on ticket_investigations.company_policies. */
export const POLICY_SOURCES = ['situation', 'rule', 'agent'];

/** The standing instruction the drafting prompt gives once, above the policies. */
export const POLICY_INSTRUCTION =
  'Utilise les passages de ces politiques qui répondent à la demande du client. ' +
  "N'inclus que ce qui concerne ce qu'il a demandé. N'invente rien, n'étends pas et ne contredis pas une politique. " +
  "Si une politique ne suffit pas à répondre, ne déduis pas de réponse : suis la conduite prévue par la situation et la règle. " +
  // 35e0afd9 (2026-10-05): « peut ne pas s'appliquer notamment… » became three
  // firm conditions of one code, one of them false.
  "Une politique énonce des règles générales, pas les faits de ce cas : ce qu'elle présente comme possible " +
  "(« peut », « notamment », « certains ») se dit au client comme une possibilité, jamais comme une certitude " +
  "sur sa commande, son code ou son offre.";

export const POLICY_COLUMNS = 'id,policy_key,name,purpose,content,active,version,updated_at,updated_by';
export const LINK_COLUMNS = 'id,policy_id,situation_key,answer_id,created_at';

/**
 * What is wrong with a policy a person is saving, or []. Pure.
 * A placeholder naming a parameter that does not exist is refused here, as the
 * rule editor refuses it: it could never be filled.
 */
export function policyProblems({ key, name, content }, { isNew = false } = {}) {
  const problems = [];
  if (isNew && !POLICY_KEY_SHAPE.test(String(key ?? ''))) problems.push('bad_key');
  if (!String(name ?? '').trim()) problems.push('no_name');
  if (!String(content ?? '').trim()) problems.push('no_content');
  const { unknown } = fillParameters(content, new Map());
  if (unknown.length > 0) problems.push(`unknown_parameter:${unknown.join(',')}`);
  return problems;
}

/**
 * The policy's text as the agent reads it: placeholders filled from the shop's
 * parameters. An unset parameter stays visible as {name} and is reported,
 * never guessed.
 */
export function renderPolicy(policy, parameters = new Map()) {
  const { text, unset, unknown } = fillParameters(policy?.content ?? '', parameters);
  return { text, unset, unknown };
}

/**
 * The policies a situation and its selected rules make available, situation
 * first, each once. Pure: `library` is `{ policies, links }` as loaded.
 *
 * @param {{ policies: any[], links: any[] }} library
 * @param {{ situationKey?: string | null, answerIds?: string[] }} scope
 * @returns {{ policy: any, source: 'situation' | 'rule' }[]}
 */
export function policiesFor(library, { situationKey = null, answerIds = [] } = {}) {
  const active = new Map((library?.policies ?? []).filter((p) => p.active).map((p) => [p.id, p]));
  const seen = new Set();
  const out = [];
  const add = (link, source) => {
    const policy = active.get(link.policy_id);
    if (!policy || seen.has(policy.id)) return;
    seen.add(policy.id);
    out.push({ policy, source });
  };
  const links = library?.links ?? [];
  if (situationKey) for (const link of links) if (link.situation_key === situationKey) add(link, 'situation');
  const rules = new Set((answerIds ?? []).filter(Boolean));
  for (const link of links) if (link.answer_id && rules.has(link.answer_id)) add(link, 'rule');
  return out;
}

/** What the model is told the one policy tool can fetch: each active key with its purpose. */
export function policyCatalogue(policies = []) {
  return policies
    .filter((p) => p.active)
    .map((p) => `- ${p.policy_key} — ${p.name}${p.purpose ? ` : ${p.purpose}` : ''}`)
    .join('\n');
}

export const REST_TRANSPORT = {
  select: supabaseSelect,
  selectAll: supabaseSelectAll,
  insert: supabaseInsert,
  update: supabaseUpdate,
  remove: supabaseDelete
};

export class PolicyConflictError extends Error {}

export function createCompanyPolicyRecord(supabase, { shopId, transport = REST_TRANSPORT }) {
  if (!shopId) {
    throw new Error('createCompanyPolicyRecord requires a shopId: every read and write here is shop-scoped.');
  }
  const { select, selectAll = select, insert, update, remove } = transport;

  async function byKey(key) {
    const rows = await select(supabase, T.COMPANY_POLICIES, { shop_id: shopId, policy_key: key }, POLICY_COLUMNS, { limit: 1 });
    return rows[0] ?? null;
  }

  return {
    byKey,

    /** Every policy (active or not) and every link: the library screen, and the runtime. */
    async load() {
      const [policies, links] = await Promise.all([
        selectAll(supabase, T.COMPANY_POLICIES, { shop_id: shopId }, POLICY_COLUMNS, { order: 'name.asc' }),
        selectAll(supabase, T.COMPANY_POLICY_LINKS, { shop_id: shopId }, LINK_COLUMNS, { order: 'created_at.asc' })
      ]);
      return { policies, links };
    },

    /** Active policies by key, for drafting: the current text of what the case read. */
    async activeByKeys(keys = []) {
      const wanted = [...new Set(keys.filter(Boolean))];
      if (wanted.length === 0) return [];
      return select(
        supabase,
        T.COMPANY_POLICIES,
        { shop_id: shopId, active: true, policy_key: { operator: 'in', value: `(${wanted.join(',')})` } },
        POLICY_COLUMNS
      );
    },

    /**
     * A new policy, version 1, with its first version row.
     * @param {{ key: string, name: string, purpose?: string, content: string, active?: boolean }} input
     * @param {{ by?: string | null }} [options]
     */
    async create({ key, name, purpose = '', content, active = true }, { by = null } = {}) {
      const [row] = await insert(supabase, T.COMPANY_POLICIES, [
        { shop_id: shopId, policy_key: key, name: name.trim(), purpose: String(purpose ?? '').trim(), content, active, version: 1, updated_by: by }
      ]);
      await insert(supabase, T.COMPANY_POLICY_VERSIONS, [{ shop_id: shopId, policy_id: row.id, version: 1, content, saved_by: by }]);
      return row;
    },

    /**
     * Save a change. A change of content raises the version and keeps the new
     * text; the write is conditional on the version the editor read, so two
     * people saving at once cannot silently overwrite each other.
     * @param {string} key
     * @param {{ name?: string, purpose?: string, content?: string, active?: boolean }} changes
     * @param {{ expectedVersion?: number, by?: string | null }} [options]
     */
    async save(key, { name, purpose, content, active }, { expectedVersion, by = null } = {}) {
      const current = await byKey(key);
      if (!current) return null;
      if (Number.isInteger(expectedVersion) && expectedVersion !== current.version) {
        throw new PolicyConflictError('This policy was changed meanwhile. Reload it before saving.');
      }
      const contentChanged = typeof content === 'string' && content !== current.content;
      const version = contentChanged ? current.version + 1 : current.version;
      const patch = { updated_by: by, version };
      if (typeof name === 'string') patch.name = name.trim();
      if (typeof purpose === 'string') patch.purpose = purpose.trim();
      if (contentChanged) patch.content = content;
      if (typeof active === 'boolean') patch.active = active;
      const rows = await update(
        supabase,
        T.COMPANY_POLICIES,
        { id: current.id, shop_id: shopId, version: current.version },
        patch,
        { select: POLICY_COLUMNS }
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new PolicyConflictError('This policy was changed meanwhile. Reload it before saving.');
      }
      if (contentChanged) {
        await insert(supabase, T.COMPANY_POLICY_VERSIONS, [{ shop_id: shopId, policy_id: current.id, version, content, saved_by: by }]);
      }
      return rows[0];
    },

    /**
     * Link a policy to a situation or to one rule. Linking twice is a no-op:
     * the unique index decides, and the existing link comes back.
     * @param {string} policyId
     * @param {{ situationKey?: string | null, answerId?: string | null }} target
     * @param {{ by?: string | null }} [options]
     */
    async link(policyId, { situationKey = null, answerId = null } = {}, { by = null } = {}) {
      if (Boolean(situationKey) === Boolean(answerId)) throw new Error('A link names a situation or a rule, exactly one.');
      const target = situationKey ? { situation_key: situationKey } : { answer_id: answerId };
      try {
        const [row] = await insert(supabase, T.COMPANY_POLICY_LINKS, [{ shop_id: shopId, policy_id: policyId, ...target, created_by: by }]);
        return { created: true, link: row };
      } catch (error) {
        if (!/duplicate key|unique constraint|company_policy_links_/i.test(String(error?.message ?? ''))) throw error;
        const rows = await select(supabase, T.COMPANY_POLICY_LINKS, { shop_id: shopId, policy_id: policyId, ...target }, LINK_COLUMNS, { limit: 1 });
        return { created: false, link: rows[0] ?? null };
      }
    },

    /** Remove one link. The policy itself is untouched. */
    async unlink(linkId) {
      const rows = await remove(supabase, T.COMPANY_POLICY_LINKS, { id: linkId, shop_id: shopId });
      return Array.isArray(rows) && rows.length > 0;
    }
  };
}
