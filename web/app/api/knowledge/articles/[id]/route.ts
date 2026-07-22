import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { deleteArticle, getShopId, updateArticle } from "@/lib/server/knowledge-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";
import type { VoiceProfile } from "@/lib/types";

function parseVoiceProfile(value: unknown): VoiceProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const strings = (arr: unknown) => (Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  return {
    tone: strings(v.tone),
    voice: typeof v.voice === "string" ? v.voice : "",
    dos: strings(v.dos),
    donts: strings(v.donts),
  };
}

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * Saves title/content/category/core topic/approval-status edits from the
 * article workspace. With `sourceId` on an article that has never had a
 * Shopify source, attaches and imports it instead (see UpdateArticleInput).
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const shopId = await getShopId();
    const article = await updateArticle(shopId, params.id, {
      title: typeof body.title === "string" ? body.title : undefined,
      content: typeof body.content === "string" ? body.content : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      coreTopic: body.coreTopic === null ? null : typeof body.coreTopic === "string" ? body.coreTopic : undefined,
      approvalStatus: typeof body.approvalStatus === "string" ? body.approvalStatus : undefined,
      sourceId: typeof body.sourceId === "string" ? body.sourceId : undefined,
      voiceProfile: parseVoiceProfile(body.voiceProfile),
    });
    return NextResponse.json({ article });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** Deletes the article. The Shopify page it may have been imported from stays in the catalog. */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const shopId = await getShopId();
    await deleteArticle(shopId, params.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
