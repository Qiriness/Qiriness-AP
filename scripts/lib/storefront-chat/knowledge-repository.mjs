// The storefront's only reader of policies, parameters and approved FAQ sections.
// Read-only named columns; no chunks/vectors, customer records or support rules.
import { toParameterMap } from '../parameters.mjs';
import { faqRecords } from './faq-matcher.mjs';

export const KNOWLEDGE_TTL_MS = 5 * 60 * 1000;
export const POLICY_COLUMNS = 'policy_key,name,content,active,version,updated_at';
export const PARAMETER_COLUMNS = 'parameter_key,value,updated_at';
export const FAQ_COLUMNS = 'id,title,category,locale,sections,product_ids,approval_status,core_topic,deleted_at,updated_at';
const APPROVED = { approval_status: 'approved', deleted_at: { operator: 'is', value: 'null' }, core_topic: { operator: 'is', value: 'null' } };

export async function loadKnowledge(db, shopId) {
  if (!shopId) throw new Error('loadKnowledge needs the catalogue shop id.');
  const [policies, rows, documents] = await Promise.all([
    db.selectAll('company_policies', { shop_id: shopId, active: true }, POLICY_COLUMNS),
    db.selectAll('support_parameters', { shop_id: shopId }, PARAMETER_COLUMNS),
    db.selectAll('knowledge_documents', { shop_id: shopId, ...APPROVED, product_ids: { operator: 'eq', value: '{}' }, category: { operator: 'not.in', value: '(brand_story,product,product_stock,cosmetovigilance)' } }, FAQ_COLUMNS)
  ]);
  return buildKnowledge({ policies, parameters: rows, documents });
}

export function buildKnowledge({ policies = [], parameters = [], documents = [], loadedAt = Date.now() } = {}) {
  return { policies: policies.filter((p) => p.active), parameters: toParameterMap(parameters), parameterDates: new Map(parameters.map((p) => [p.parameter_key, p.updated_at ?? null])), faqs: faqRecords(documents).filter((r) => !r.product_ids.length), loadedAt };
}

/** Lazy product-only reader. No request is made until the product tool is needed. */
export function createProductPolicyReader(db, shopId, { now = Date.now } = {}) {
  if (!shopId) throw new Error('createProductPolicyReader needs the catalogue shop id.');
  const cache = new Map();
  const pending = new Map();
  return async (productId) => {
    if (typeof productId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId)) return [];
    const saved = cache.get(productId);
    if (saved && now() - saved.at < KNOWLEDGE_TTL_MS) return saved.records;
    if (pending.has(productId)) return pending.get(productId);
    const loading = db.selectAll('knowledge_documents', {
      shop_id: shopId, ...APPROVED, product_ids: { operator: 'cs', value: `{${productId}}` }
    }, FAQ_COLUMNS).then((documents) => {
      const records = faqRecords(documents).filter((r) => r.product_ids.includes(productId));
      cache.set(productId, { at: now(), records });
      return records;
    }).finally(() => pending.delete(productId));
    pending.set(productId, loading);
    return loading; // A failed refresh never returns stale controlled guidance.
  };
}
