import { supabaseInsert, supabaseSelect, supabaseUpdateById } from './supabase-rest-client.mjs';

export async function mergeKnowledgeDocuments(supabase, documents) {
  const merged = [];

  for (const document of documents) {
    const existing = await findExistingKnowledgeDocument(supabase, document);
    if (existing) {
      merged.push(await supabaseUpdateById(supabase, 'knowledge_documents', existing.id, document));
      continue;
    }

    const inserted = await supabaseInsert(supabase, 'knowledge_documents', [document]);
    merged.push(inserted[0]);
  }

  return merged;
}

async function findExistingKnowledgeDocument(supabase, document) {
  if (document.shopify_source_id) {
    const rows = await supabaseSelect(
      supabase,
      'knowledge_documents',
      {
        shop_id: document.shop_id,
        source_type: document.source_type,
        shopify_source_id: document.shopify_source_id
      },
      'id'
    );
    return rows[0] || null;
  }

  if (document.handle) {
    const rows = await supabaseSelect(
      supabase,
      'knowledge_documents',
      {
        shop_id: document.shop_id,
        source_type: document.source_type,
        handle: document.handle
      },
      'id'
    );
    return rows[0] || null;
  }

  return null;
}
