const NAVIGATION_AREAS = ['header', 'footer', 'manual'];

export function buildNavigationIndex(menus) {
  const byResourceId = new Map();

  for (const menu of menus) {
    const area = classifyNavigationArea(menu);
    for (const item of flattenMenuItems(menu.items || [])) {
      if (!item.resourceId || !isKnowledgeResourceType(item.type)) {
        continue;
      }

      const entries = byResourceId.get(item.resourceId) || [];
      entries.push({
        menu_id: menu.id,
        menu_handle: menu.handle,
        menu_title: menu.title,
        menu_area: area,
        item_id: item.id,
        item_title: item.title,
        item_type: item.type,
        item_url: item.url,
        depth: item.depth
      });
      byResourceId.set(item.resourceId, entries);
    }
  }

  return byResourceId;
}

export function resolveNavigationArea(entries, fallback = 'manual') {
  const areas = (entries || []).map((entry) => entry.menu_area).filter((area) => NAVIGATION_AREAS.includes(area));
  if (areas.includes('header')) {
    return 'header';
  }
  if (areas.includes('footer')) {
    return 'footer';
  }
  return fallback;
}

function classifyNavigationArea(menu) {
  const label = normalize(`${menu.handle || ''} ${menu.title || ''}`);

  if (/(footer|pied|bas|legal|polic)/.test(label)) {
    return 'footer';
  }
  if (/(header|main|principal|menu)/.test(label)) {
    return 'header';
  }

  return 'manual';
}

function flattenMenuItems(items, depth = 0) {
  return items.flatMap((item) => [
    { ...item, depth },
    ...flattenMenuItems(item.items || [], depth + 1)
  ]);
}

function isKnowledgeResourceType(type) {
  return type === 'PAGE' || type === 'SHOP_POLICY';
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
