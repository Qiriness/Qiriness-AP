import { NextResponse } from 'next/server';
import { requestShop } from "@/lib/server/insights/request-shop";
import { checkManualMetric, setManualPost } from '@/lib/server/social-post-manual-service';
import { isUuid } from '@/lib/server/social-tags-service';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!isUuid(body.accountId) || typeof body.postId !== 'string' || !body.postId || body.postId.length > 512)
      return NextResponse.json({ error: 'accountId and postId are required' }, { status: 400, headers });
    const checked = checkManualMetric(body.metric, body.value);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400, headers });
    if (!await setManualPost(body.accountId, body.postId, body.metric, checked.value, (await requestShop(request)).id))
      return NextResponse.json({ error: 'No such post' }, { status: 404, headers });
    return NextResponse.json({ ok: true, value: checked.value }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.message === 'The platform already reports this metric' ? error.message : 'Could not save this manual metric. Refresh and try again.' }, { status: 409, headers });
  }
}
