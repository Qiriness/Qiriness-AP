import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { toParameterMap } from '../../../scripts/lib/parameters.mjs';

// What a drafting run reads once, before any ticket: the numbers a skeleton may
// quote, the codes still offerable, the articles rules pin. Shared by the CLI
// (`npm run draft`) and the worker's draft stage (stage 6), so the two cannot
// load them differently. Each loader degrades to empty rather than failing a run.

/** The three together, for one run. */
export async function loadDraftingContext(supabase, shopId, logger) {
  const [parameters, offerableCodes, pinnedArticles] = await Promise.all([
    loadParametersFor(supabase, shopId, logger),
    loadOfferableCodesFor(supabase, shopId, logger),
    loadPinnedArticlesFor(supabase, shopId, logger)
  ]);
  return { parameters, offerableCodes, pinnedArticles };
}

/**
 * The numbers a skeleton may quote.
 *
 * Loaded here rather than taken from the investigation stack, which this CLI
 * does not build: drafting reads stored case files and needs no tools. A failure
 * degrades to no parameters, which drops any skeleton quoting one — the
 * behaviour before skeletons existed.
 */
/**
 * The codes a rule is still allowed to hand out, as a set of the code strings.
 *
 * TWO CONDITIONS, BOTH REQUIRED. The promotion must be ACTIVE in Shopify, and an
 * operator must have marked it offerable — a code that expired and a code that
 * was never meant for customers are different mistakes and this is the one place
 * that can catch either.
 *
 * A FAILURE RETURNS AN EMPTY SET, which drops every offer rather than sending a
 * code nobody checked. That is the safe direction for the one field in a reply
 * that is a key rather than prose: a reply missing an offer is incomplete, a
 * reply carrying a dead code is a customer typing it in and writing back.
 */
export async function loadOfferableCodesFor(supabase, shopId, logger) {
  try {
    const rows = await supabaseSelect(
      supabase,
      T.PROMOTIONS,
      { shop_id: shopId, status: 'ACTIVE', offerable_in_replies: true },
      'codes'
    );
    const codes = new Set();
    for (const row of rows || []) {
      for (const entry of Array.isArray(row.codes) ? row.codes : []) {
        const code = String(entry?.code ?? '').trim();
        if (code) codes.add(code);
      }
    }
    return codes;
  } catch (error) {
    logger?.warn?.('draft.offerable_codes_load_failed', { reason: error.message });
    return new Set();
  }
}

/**
 * The articles approved rules pin, by document id.
 *
 * TWO READS RATHER THAN A JOIN, because PostgREST embeds are a different shape
 * per relationship and the id list here is tiny — at most one per rule, and
 * there are 107 rules. Approved rules only, matching `loadAnswers`: a draft
 * rule is not one the agent can be steered by, so its article is not one worth
 * loading.
 *
 * APPROVAL IS RE-CHECKED HERE and not trusted from the rule, which is the whole
 * point of resolving at drafting time — an operator can unapprove an article
 * without touching the rule that cites it.
 *
 * NEVER FAILS A DRAFT. An empty map drops every pin, which degrades to the
 * behaviour before pinning existed.
 */
export async function loadPinnedArticlesFor(supabase, shopId, logger) {
  try {
    const rules = await supabaseSelect(
      supabase,
      T.SUPPORT_ANSWERS,
      { shop_id: shopId, approval_status: 'approved' },
      'knowledge_document_id'
    );
    const ids = [...new Set((rules || []).map((row) => row.knowledge_document_id).filter(Boolean))];
    if (ids.length === 0) {
      return new Map();
    }
    const documents = await supabaseSelect(
      supabase,
      T.KNOWLEDGE_DOCUMENTS,
      { shop_id: shopId, approval_status: 'approved' },
      'id,title,content_text,deleted_at'
    );
    const wanted = new Set(ids);
    const map = new Map();
    for (const doc of documents || []) {
      if (!wanted.has(doc.id) || doc.deleted_at) continue;
      map.set(doc.id, { title: doc.title ?? null, text: doc.content_text ?? '' });
    }
    return map;
  } catch (error) {
    logger?.warn?.('draft.pinned_articles_load_failed', { reason: error.message });
    return new Map();
  }
}

export async function loadParametersFor(supabase, shopId, logger) {
  try {
    return toParameterMap(
      await supabaseSelect(supabase, T.SUPPORT_PARAMETERS, { shop_id: shopId }, 'parameter_key,value')
    );
  } catch (error) {
    logger?.warn?.('draft.parameters_load_failed', { reason: error.message });
    return new Map();
  }
}
