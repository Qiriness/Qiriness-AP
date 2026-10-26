import 'server-only';
import {supabaseSelectAll,supabaseSelect,supabaseUpsert,supabaseDelete} from '../../../scripts/lib/supabase-rest-client.mjs';
import {getSupabaseClient} from './insights/shared';
import {getShop} from './shop';
import {dateInZone} from '../../../scripts/lib/social-report-data.mjs';
import type {AudienceDimension,OrganicKind} from '../social-types';
export interface ManualAudienceRow {kind:OrganicKind;dimension:AudienceDimension;captured_on:string;entries:{key:string;value:number}[]}
const TABLE='social_audience_manual';
export async function readManualAudience(shopId:string):Promise<ManualAudienceRow[]> {
  return supabaseSelectAll(getSupabaseClient(),TABLE,{shop_id:shopId},'kind,dimension,captured_on,entries',{order:'kind.asc,dimension.asc'}) as Promise<ManualAudienceRow[]>;
}
/** `forShop`: the Insights shop's row; without it, the support desk's. */
export async function audienceWriteContext(forShop?: { id: string; ianaTimezone: string | null } | null) {
  const shop=forShop ?? (await getShop());
  if(!shop)throw new Error('No shop record.');
  return {shopId:shop.id as string,asOf:dateInZone(new Date(),(shop.ianaTimezone as string|null)??'UTC')};
}
export async function saveManualAudience(shopId:string,kind:OrganicKind,dimension:AudienceDimension,capturedOn:string,entries:{key:string;value:number}[]|null) {
  const client=getSupabaseClient();
  const accounts=await supabaseSelect(client,'social_accounts',{shop_id:shopId,kind,enabled:true},'id',{limit:1});
  if(!accounts.length)return false;
  const filters={shop_id:shopId,kind,dimension};
  if(entries===null)await supabaseDelete(client,TABLE,filters);
  else await supabaseUpsert(client,TABLE,[{...filters,captured_on:capturedOn,entries,updated_at:new Date().toISOString()}],'shop_id,kind,dimension');
  return true;
}
