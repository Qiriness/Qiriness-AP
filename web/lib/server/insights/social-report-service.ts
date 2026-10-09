import { supabaseSelectAll } from "../../../../scripts/lib/supabase-rest-client.mjs";
import { SOCIAL_T } from "../../../../scripts/lib/tables.mjs";
import { adaptSocialReport, dateInZone, shiftMonth, endOfMonth, socialReportVersion } from "../../../../scripts/lib/social-report-data.mjs";
import { renderSocialReport, socialReportState } from "../../../../scripts/lib/social-report.mjs";
import { getShop } from "../shop";
import { readBandRows } from "../social-bands-service";
import { readSocialTags } from "../social-tags-service";
import { getSocialReportReach } from "./social-service";
import { getSupabaseClient } from "./shared";

export class SocialReportInputError extends Error {}

export async function buildSocialReport(params: URLSearchParams, locale: "fr" | "en") {
  const shop = await getShop();
  if (!shop) throw new Error("No shop record.");
  const timezone = shop.ianaTimezone ?? "UTC";
  const asOf = dateInZone(new Date(), timezone);
  const defaultMonth = shiftMonth(asOf.slice(0, 7), -1);
  const endMonth = params.get("month") ?? defaultMonth;
  const months = Number(params.get("months") ?? "1");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(endMonth) || endMonth < "2000-01" || endMonth > asOf.slice(0, 7) || ![1, 6, 12].includes(months)) {
    throw new SocialReportInputError("Choose a valid calendar month and a 1, 6 or 12 month report.");
  }
  const client = getSupabaseClient();
  const accounts = await supabaseSelectAll(client, SOCIAL_T.ACCOUNTS, { shop_id: shop.id, enabled: true }, "id,kind,enabled,engagement_basis", { order: "id.asc" });
  const kinds = [...new Set(accounts.filter((a: { kind: string }) => ["instagram", "facebook", "tiktok"].includes(a.kind)).map((a: { kind: string }) => a.kind))];
  const platforms = params.has("platforms") ? [...new Set((params.get("platforms") ?? "").split(","))] : kinds;
  if (!platforms.length || platforms.some(id => !kinds.includes(id))) throw new SocialReportInputError("Choose at least one connected social platform.");
  // One additional boundary day is needed for the first comparison month's starting followers.
  const firstMonth = shiftMonth(endMonth, -23);
  const firstDay = endOfMonth(shiftMonth(firstMonth, -1));
  const [days, posts, audience, tags, bands] = await Promise.all([
    supabaseSelectAll(client, SOCIAL_T.ACCOUNT_DAYS, { shop_id: shop.id, day: { operator: "gte", value: firstDay } }, "account_id,day,followers,follows,unfollows,views,engagement,profile_visits,link_taps,posts", { order: "account_id.asc,day.asc" }),
    supabaseSelectAll(client, SOCIAL_T.POSTS, { shop_id: shop.id, published_at: { operator: "gte", value: firstMonth + "-01T00:00:00Z" } }, "account_id,external_id,published_at,media_type,caption_excerpt,views,reach,likes,comments,shares,saves,follows,engagement,non_followers_pct,fetched_at,insights_at", { order: "account_id.asc,external_id.asc" }),
    supabaseSelectAll(client, SOCIAL_T.AUDIENCE, { shop_id: shop.id, captured_on: { operator: "lte", value: asOf } }, "account_id,captured_on,dimension,key,value", { order: "account_id.asc,captured_on.asc,dimension.asc,key.asc" }),
    readSocialTags(shop.id),
    readBandRows(shop.id),
  ]);
  const data = adaptSocialReport({ companyId: shop.id, timezone, endMonth, asOf, accounts,
    days, posts, audience, bands, ...tags });
  // Never pool unique audiences across accounts. Meta only answers <=30-day windows.
  const instagram = data.platforms.find(p => p.id === "instagram");
  if (instagram && platforms.includes("instagram") && accounts.filter((a: { kind: string }) => a.kind === "instagram").length === 1) {
    const windows = [0, -months].map(offset => {
      const last = shiftMonth(endMonth, offset);
      return { start: shiftMonth(last, 1 - months) + "-01", end: endOfMonth(last), to: shiftMonth(last, 1) + "-01T00:00:00" };
    });
    const unique = await Promise.all(windows.map(async window => {
      if (window.end >= asOf) return null;
      if (Date.parse(window.to + "Z") - Date.parse(window.start + "T00:00:00Z") > 30 * 86400000) return null;
      const result = await getSocialReportReach(shop.id, window.start + "T00:00:00", window.to);
      return { start: window.start, end: window.end, reach: result.reach, accountsEngaged: result.accountsEngaged, nonFollowerShare: null, nonFollowerBasis: null, provenance: "Meta native exact-period unique count" };
    }));
    instagram.nativePeriodMetrics = unique.filter((value): value is NonNullable<typeof value> => value !== null);
  }
  data.datasetVersion = socialReportVersion(data);
  const state = socialReportState(data, { name: shop.shopName ?? "Company", locale: locale === "fr" ? "fr-FR" : "en-GB", endMonth, months, platforms });
  return { html: renderSocialReport(state), filename: "social-report-" + endMonth + "-" + months + "m.html" };
}
