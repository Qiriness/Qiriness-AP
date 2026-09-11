import { NextResponse } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { getSupabaseClient } from "@/lib/server/insights/shared";
import {
  describeVipRule,
  loadVipRule,
  saveVipRule,
  summariseVipRule,
  validateVipRule,
} from "../../../../../scripts/lib/vip-rule.mjs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET — the current rule, or with `?minSpend=&minOrders=&windowMonths=` a
 * preview of how many customers a rule WOULD admit, before anyone saves it.
 * Counting only: no customer is named.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const supabase = getSupabaseClient();
    const shopId = await getShopId();

    const asked = url.searchParams.has("minSpend");
    let rule;
    if (asked) {
      const checked = validateVipRule({
        minSpend: url.searchParams.get("minSpend"),
        minOrders: url.searchParams.get("minOrders"),
        windowMonths: url.searchParams.get("windowMonths"),
      });
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });
      rule = checked.rule;
    } else {
      rule = await loadVipRule(supabase, shopId);
    }

    const summary = await summariseVipRule(supabase, shopId, rule);
    return NextResponse.json({ rule, description: describeVipRule(rule), summary }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * PUT — save the rule: `{minSpend, minOrders, windowMonths}`, or `{clear: true}`
 * to remove it (nobody is then a VIP). Validated here and constrained again by
 * `shops_vip_rule_check`, so a half-rule cannot be stored either way.
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const supabase = getSupabaseClient();
    const shopId = await getShopId();

    if (body?.clear === true) {
      await saveVipRule(supabase, shopId, null);
      return NextResponse.json({ rule: null, description: describeVipRule(null), summary: null }, { headers: NO_STORE });
    }

    const checked = validateVipRule(body);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });

    await saveVipRule(supabase, shopId, checked.rule);
    const summary = await summariseVipRule(supabase, shopId, checked.rule);
    return NextResponse.json(
      { rule: checked.rule, description: describeVipRule(checked.rule), summary },
      { headers: NO_STORE }
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
