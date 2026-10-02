import { supabaseSelect } from './supabase-rest-client.mjs';
import { T } from './tables.mjs';
import { text, toParameterMap } from './parameters.mjs';

// WHO THE COMPANY IS, for every runtime text that names it.
//
// These were literals: « le service client de Qiriness, une marque de soin de
// la peau » in three agent prompts, « Qiriness management » in the chat,
// « Deret » in the priority reasons, « Qiriness » as the label on our own
// replies. Deployed for another shop, every one of them would have named the
// wrong company. The name is Shopify's (`shops.shop_name`); the rest is the
// merchant's, as parameters.

/**
 * @param shopName   `shops.shop_name`
 * @param parameters the `support_parameters` map (`toParameterMap`)
 * @returns {{ name: string|null, description: string|null, logisticsProvider: string|null }}
 */
export function companyFrom({ shopName = null, parameters = new Map() } = {}) {
  const name = String(shopName ?? '').trim();
  return {
    name: name || null,
    description: text(parameters, 'company_description'),
    logisticsProvider: text(parameters, 'logistics_provider_name')
  };
}

/** Reads the shop row and the parameters, once per caller. */
export async function loadCompany(supabase, shopId) {
  const [shops, rows] = await Promise.all([
    supabaseSelect(supabase, T.SHOPS, { id: shopId }, 'shop_name'),
    supabaseSelect(supabase, T.SUPPORT_PARAMETERS, { shop_id: shopId }, 'parameter_key,value')
  ]);
  return companyFrom({ shopName: shops[0]?.shop_name, parameters: toParameterMap(rows) });
}

/**
 * « service client de Qiriness, une marque de soin de la peau », after « du »
 * in the first line of an agent's instructions. Without a name: « service client
 * d'une boutique en ligne ».
 */
export function serviceClientOf(company = {}) {
  if (!company?.name) return 'service client d’une boutique en ligne';
  return company.description
    ? `service client de ${company.name}, ${company.description}`
    : `service client de ${company.name}`;
}
