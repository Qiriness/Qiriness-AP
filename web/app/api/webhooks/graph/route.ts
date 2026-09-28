import { loadConfig } from "../../../../../scripts/lib/sync-config.mjs";
import { createSupabaseClient } from "../../../../../scripts/lib/supabase-rest-client.mjs";
import { handleGraphNotification } from "../../../../../scripts/lib/graph-notifications.mjs";
import { createMailJobRecord } from "../../../../../scripts/lib/mail-job-record.mjs";
import { createMailSubscriptionRecord } from "../../../../../scripts/lib/mail-subscription-record.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * WHERE MICROSOFT GRAPH SAYS "SOMETHING CHANGED IN THIS FOLDER".
 *
 * A TRIGGER, NOT INGESTION. It believes a notification only when its
 * clientState matches the subscription we created, then queues one
 * `sync_mailbox` job per folder and answers 202. No mail is read here; the
 * worker's delta read decides what is new (scripts/lib/graph-notifications.mjs).
 *
 * DORMANT UNTIL DEPLOYED. The worker creates subscriptions only when
 * MAIL_WEBHOOK_URL names this route on a public HTTPS host. Until then nothing
 * calls it, and the timed poll does all the work.
 *
 * PUBLIC, like the Shopify webhook: Graph holds no session cookie. The
 * clientState is its proof. Graph also sends the subscription handshake here
 * (`?validationToken=`), which must be echoed as plain text.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  const rawBody = validationToken === null ? await request.text() : "";

  let supabase;
  try {
    supabase = createSupabaseClient(loadConfig(process.env));
  } catch (error) {
    console.error("graph webhook: configuration error", (error as Error).message);
    return new Response("Webhook endpoint is not configured.", { status: 500 });
  }

  try {
    const result = await handleGraphNotification({
      validationToken,
      rawBody,
      subscriptions: createMailSubscriptionRecord(supabase),
      jobsFor: (shopId: string) => createMailJobRecord(supabase, { shopId }),
      logger: { warn: (event: string, data: unknown) => console.warn(event, data) },
    });
    return new Response(result.body, { status: result.status, headers: { "Content-Type": result.contentType } });
  } catch (error) {
    // Queueing failed (the database, not the notification). A 500 makes Graph
    // retry, which is what we want; the timed poll covers it meanwhile.
    console.error("graph webhook: could not queue a sync", (error as Error).message);
    return new Response("", { status: 500 });
  }
}
