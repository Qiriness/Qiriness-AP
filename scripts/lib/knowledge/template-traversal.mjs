/**
 * Generic Shopify Online Store 2.0 JSON template walker. Knows nothing about
 * section types, content, or Liquid — only the `order`/`block_order` and
 * `disabled` structure shared by every `templates/page.*.json` asset.
 */

export function getOrderedSections(template, { includeDisabled = false } = {}) {
  const sectionsMap = template.sections || {};
  const orderedKeys = orderedKeysFor(template.order, sectionsMap);

  return orderedKeys
    .map((sectionId, position) => ({ sectionId, position, raw: sectionsMap[sectionId] }))
    .filter(({ raw }) => raw && (includeDisabled || raw.disabled !== true))
    .map(({ sectionId, position, raw }) => ({
      sectionId,
      type: raw.type,
      position,
      settings: raw.settings || {},
      blocks: getOrderedBlocks(raw, { includeDisabled })
    }));
}

function getOrderedBlocks(section, { includeDisabled = false } = {}) {
  const blocksMap = section.blocks || {};
  const orderedKeys = orderedKeysFor(section.block_order, blocksMap);

  return orderedKeys
    .map((blockId, position) => ({ blockId, position, raw: blocksMap[blockId] }))
    .filter(({ raw }) => raw && (includeDisabled || raw.disabled !== true))
    .map(({ blockId, position, raw }) => ({
      blockId,
      type: raw.type,
      position,
      settings: raw.settings || {}
    }));
}

function orderedKeysFor(order, map) {
  return Array.isArray(order)
    ? [...order, ...Object.keys(map).filter((key) => !order.includes(key))]
    : Object.keys(map);
}
