/**
 * The Segment Finder: one checked segment in, the customers it matches out.
 *
 * EVALUATED IN SQL. `customer_segment_find()` counts every match over the whole
 * customer base and returns the 25 highest lifetime spenders; nothing is paged
 * or filtered here (see ./shared.ts for why a table-sized read would be wrong).
 *
 * PEOPLE, SO NEVER MARKETPLACES: Amazon and Yves Rocher mint a customer per
 * order, and those records are left out of the base as well as the figures.
 *
 * PERSONAL DATA: the member list names customers, so a search that returns any
 * writes one `data_access_events` row — the same trail as the VIP call list,
 * with counts and never names.
 *
 * Server-only.
 */

import { RPC } from "../../../../scripts/lib/tables.mjs";
import { ALL_MARKETPLACE_HANDLES } from "../../../../scripts/lib/insights-range.mjs";
import {
  SEGMENT_MEMBER_LIMIT,
  describeSegment,
  segmentArgs,
} from "../../../../scripts/lib/segment-finder.mjs";
import type { SegmentDefinition, SegmentFinderResult, SegmentMember } from "../../types";
import { logDashboardAccess } from "../access-log";
import { callRpc, count } from "./shared";

export async function findSegment(shopId: string, segment: SegmentDefinition): Promise<SegmentFinderResult> {
  const rows = await callRpc<Record<string, unknown>>(
    RPC.CUSTOMER_SEGMENT_FIND,
    segmentArgs(shopId, segment, [...ALL_MARKETPLACE_HANDLES], SEGMENT_MEMBER_LIMIT)
  );
  const head = rows[0] ?? {};
  const members: SegmentMember[] = rows
    .filter((row) => row.customer_id !== null && row.customer_id !== undefined)
    .map((row) => ({
      customerId: String(row.customer_id),
      name: (row.customer_name as string | null) ?? null,
      orders: count(row.orders),
      spend: count(row.spend),
      lifetimeSpend: count(row.lifetime_spend),
      lastOrderAt: (row.last_order_at as string | null) ?? null,
      onMarketingList: row.on_marketing_list === true,
    }));

  const matched = count(head.matched_customers);
  if (members.length > 0) {
    await logDashboardAccess({
      shopId,
      action: "view",
      resourceType: "customers",
      purpose: "insights_segment_finder",
      metadata: { panel: "customers", customers: members.length, matched, conditions: segment.conditions.length },
    });
  }

  return {
    description: describeSegment(segment),
    windowMonths: segment.windowMonths,
    matched,
    matchedOnMarketingList: count(head.matched_on_marketing_list),
    matchedSpend: count(head.matched_spend),
    matchedLifetimeSpend: count(head.matched_lifetime_spend),
    baseCustomers: count(head.base_customers),
    baseBuyers: count(head.base_buyers),
    members,
    memberLimit: SEGMENT_MEMBER_LIMIT,
  };
}
