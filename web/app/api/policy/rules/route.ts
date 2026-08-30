import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  getShopId,
  listRules,
  listSituations,
  policyVocabulary,
  saveRule,
} from "@/lib/server/policy-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Every rule, plus what the editor may offer.
 *
 * The vocabulary travels WITH the rules rather than from a second endpoint: the
 * editor cannot render a condition without knowing which states exist, so
 * fetching them separately would only introduce a state where it has one and not
 * the other.
 */
export async function GET(request: NextRequest) {
  try {
    const shopId = await getShopId();
    const answerSet = request.nextUrl.searchParams.get("answerSet") ?? undefined;
    const [rules, situations, vocabulary] = await Promise.all([
      listRules(shopId, answerSet),
      listSituations(shopId),
      policyVocabulary(shopId),
    ]);
    return NextResponse.json({ rules, situations, vocabulary });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** Creates or rewrites a rule, keyed on (answer set, key). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const shopId = await getShopId();
    const rule = await saveRule(shopId, {
      answerSet: String(body.answerSet ?? ""),
      answerKey: String(body.answerKey ?? ""),
      situationKey: body.situationKey ? String(body.situationKey) : null,
      conditions: (body.conditions ?? {}) as Record<string, string[]>,
      answerSkeleton: body.answerSkeleton ? String(body.answerSkeleton) : null,
      route: body.route ? String(body.route) : null,
      ask: body.ask ? String(body.ask) : null,
      priority: Number(body.priority ?? 0),
      isFallback: body.isFallback === true,
      // NEVER APPROVED BY A SAVE. A rule reaches live mail only through the
      // approval endpoint, so editing one can never be the thing that switches
      // it on — the same split `import-exemplars.mjs` keeps for the same reason.
      approvalStatus: "draft",
    });
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
