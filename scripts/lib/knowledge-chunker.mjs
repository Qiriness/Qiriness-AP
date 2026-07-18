import { hashJson } from './hash.mjs';

const DEFAULT_MAX_TOKENS = 450;

export function buildKnowledgeChunks(documentRow, options = {}) {
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const chunks = [];
  const sections = Array.isArray(documentRow.sections) && documentRow.sections.length > 0
    ? documentRow.sections
    : [{ heading: documentRow.title, text: documentRow.content_text, order: 0 }];

  for (const section of sections) {
    const sectionText = section.text || '';
    for (const chunkText of splitText(sectionText, maxTokens)) {
      chunks.push({
        knowledge_document_id: documentRow.id,
        chunk_index: chunks.length,
        section_index: Number.isInteger(section.order) ? section.order : null,
        section_heading: section.heading || null,
        category: documentRow.category,
        chunk_text: chunkText,
        token_count: approximateTokenCount(chunkText),
        content_hash: hashJson({
          source: documentRow.shopify_source_id || documentRow.handle,
          section_index: section.order ?? null,
          text: chunkText
        })
      });
    }
  }

  return chunks;
}

function splitText(text, maxTokens) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs.flatMap((item) => splitLongParagraph(item, maxTokens))) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (approximateTokenCount(candidate) <= maxTokens) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }
    current = paragraph;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitLongParagraph(paragraph, maxTokens) {
  if (approximateTokenCount(paragraph) <= maxTokens) {
    return [paragraph];
  }

  const sentences = paragraph
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    return splitWords(paragraph, maxTokens);
  }

  return splitText(sentences.join('\n\n'), maxTokens);
}

function splitWords(text, maxTokens) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = [];

  for (const word of words) {
    const candidate = [...current, word].join(' ');
    if (approximateTokenCount(candidate) <= maxTokens) {
      current.push(word);
      continue;
    }

    if (current.length > 0) {
      chunks.push(current.join(' '));
    }
    current = [word];
  }

  if (current.length > 0) {
    chunks.push(current.join(' '));
  }

  return chunks;
}

export function approximateTokenCount(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}
