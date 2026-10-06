// Read-only source inventory. No customer/order reads, model calls or writes.
import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelect, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { placeholdersIn, PARAMETER_KEYS } from './lib/parameters.mjs';

const env = loadEnv();
const db = createSupabaseClient(loadConfig(env));
const [shop] = await supabaseSelect(db, 'shops', { shop_domain: env.SHOPIFY_STORE_DOMAIN }, 'id');
if (!shop) throw new Error('Catalogue shop not found.');
const [policies, documents, parameters] = await Promise.all([
  supabaseSelectAll(db, 'company_policies', { shop_id: shop.id, active: true }, 'policy_key,name,purpose,content,version'),
  supabaseSelectAll(db, 'knowledge_documents', { shop_id: shop.id, approval_status: 'approved', deleted_at: { operator: 'is', value: 'null' } }, 'id,title,category,locale,core_topic,sections,product_ids'),
  supabaseSelectAll(db, 'support_parameters', { shop_id: shop.id }, 'parameter_key,value')
]);
console.log(JSON.stringify({
  policies: policies.map((p) => ({ key: p.policy_key, name: p.name, purpose: p.purpose, version: p.version, parameters: placeholdersIn(p.content), paragraphs: p.content.split(/\n\s*\n/).length, ...(process.argv.includes('--policies') && /^(payment|return|shipping_cost|promotion_discount|dispatch_time|refund|delivery_location|order_cancellation|delivery_time)_policy$/.test(p.policy_key) ? { content: p.content } : {}) })),
  documents: documents.filter((d) => !d.core_topic).map((d) => ({ id: d.id, title: d.title, category: d.category, locale: d.locale, product_ids: d.product_ids, sections: d.sections.map((s) => ({ heading: s.heading, chars: s.text?.length ?? 0 })) })),
  parameters: parameters.filter((p) => PARAMETER_KEYS.includes(p.parameter_key)).map((p) => ({ key: p.parameter_key, set: p.value !== null && String(p.value).trim() !== '' }))
}, null, 2));
