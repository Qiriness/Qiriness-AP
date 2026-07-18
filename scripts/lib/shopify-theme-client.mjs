export function createShopifyThemeClient(config, shopify) {
  return {
    baseUrl: `https://${config.shopDomain}/admin/api/${config.shopifyApiVersion}`,
    token: shopify.token,
    mainTheme: null,
    unavailableReason: null,
    assetCache: new Map()
  };
}

export async function fetchMainTheme(themeClient) {
  if (themeClient.mainTheme || themeClient.unavailableReason) {
    return themeClient.mainTheme;
  }

  try {
    const payload = await shopifyRest(themeClient, '/themes.json');
    themeClient.mainTheme = payload.themes.find((theme) => theme.role === 'main') || payload.themes[0] || null;
    return themeClient.mainTheme;
  } catch (error) {
    themeClient.unavailableReason = error.message;
    return null;
  }
}

export async function fetchThemeAsset(themeClient, key) {
  if (themeClient.assetCache.has(key)) {
    return themeClient.assetCache.get(key);
  }

  const theme = await fetchMainTheme(themeClient);
  if (!theme) {
    return null;
  }

  try {
    const searchParams = new URLSearchParams();
    searchParams.set('asset[key]', key);
    const payload = await shopifyRest(themeClient, `/themes/${theme.id}/assets.json?${searchParams.toString()}`);
    const asset = payload.asset || null;
    themeClient.assetCache.set(key, asset);
    return asset;
  } catch (error) {
    themeClient.assetCache.set(key, null);
    return null;
  }
}

async function shopifyRest(themeClient, path) {
  const response = await fetch(`${themeClient.baseUrl}${path}`, {
    headers: {
      'X-Shopify-Access-Token': themeClient.token,
      Accept: 'application/json'
    }
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.errors || payload?.error || `HTTP ${response.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  return payload;
}
