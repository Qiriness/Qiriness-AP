/**
 * Insights → Social media → Connections: connecting Meta and Google Ads through
 * OAuth, which accounts are tracked, and asking for a sync.
 *
 * THE TOKEN GOES ONE WAY, as Klaviyo's key does (integrations-service.ts): the
 * callback exchanges the provider's code, the token is handed to Vault
 * (`social_save_token`), and nothing here ever reads it back. The browser sees
 * which accounts were found, when the token expires and how the last sync went.
 *
 * CONNECTING QUEUES A SYNC. The first backfill takes minutes, longer than a
 * request may, so the callback queues a `sync_social` job and the worker runs
 * it (agent/src/social/social-job-runner.mjs); « Sync now » queues the same job.
 *
 * EVERY CALL NAMES ITS SHOP. A connection belongs to one shop: the routes
 * resolve it from `?shop=` (integration-shop.ts), the OAuth state carries it to
 * the callback signed, and nothing here falls back to the support desk's shop.
 *
 * Server-only.
 */

import { createMailJobRecord } from "../../../scripts/lib/mail-job-record.mjs";
import { tiktokAuthorizeUrl } from "../../../scripts/lib/tiktok-client.mjs";
import { supabaseSelect, supabaseUpdate } from "../../../scripts/lib/supabase-rest-client.mjs";
import { SOCIAL_T, T } from "../../../scripts/lib/tables.mjs";
import { ENGAGEMENT_BASES, ORGANIC_KINDS, UPCOMING_NETWORKS } from "../../../scripts/lib/social-model.mjs";
import {
  STATE_COOKIE,
  createState,
  googleAuthorizeUrl,
  metaAuthorizeUrl,
  redirectUri,
  socialAppConfig,
  verifyState,
} from "../../../scripts/lib/social-oauth.mjs";
import {
  connectGoogle,
  connectMeta,
  connectTikTok,
  disconnectSocial,
  readSocialStatus,
  setAccountEnabled,
} from "../../../scripts/lib/social-sync.mjs";
import { getSupabaseClient } from "./insights/shared";
import { servedShopById } from "./integration-shop";
import type { SocialConnectionsStatus, SocialProvider } from "../social-types";

export { STATE_COOKIE };

export const PROVIDERS: SocialProvider[] = ["meta", "google", "tiktok"];

export function isProvider(value: unknown): value is SocialProvider {
  return typeof value === "string" && (PROVIDERS as string[]).includes(value);
}

/** The origin the provider sends people back to. PUBLIC_APP_URL wins over the request's. */
export function appOrigin(requestOrigin: string): string {
  return socialAppConfig(process.env).publicUrl ?? requestOrigin;
}

export async function getSocialConnections(shopId: string): Promise<SocialConnectionsStatus> {
  const config = socialAppConfig(process.env);
  const { connections, accounts } = await readSocialStatus(getSupabaseClient(), shopId);
  const queued = await queuedProviders(shopId);

  return {
    providers: PROVIDERS.map((provider) => {
      const row = connections.find((c: { provider: string }) => c.provider === provider) ?? null;
      const app = config[provider];
      return {
        provider,
        configured: app.canConnect,
        missing: app.connectMissing,
        connected: Boolean(row),
        connectedAt: row?.connected_at ?? null,
        tokenExpiresAt: row?.token_expires_at ?? null,
        lastSyncAt: row?.last_sync_at ?? null,
        lastSyncStatus: row?.last_sync_status ?? null,
        lastSyncError: row?.last_sync_error ?? null,
        syncQueued: queued.has(provider),
        accounts: accounts
          .filter((a: { provider: string }) => a.provider === provider)
          .map((a: { id: string; kind: string; name: string | null; handle: string | null; currency: string | null; enabled: boolean }) => ({
            id: a.id,
            kind: a.kind as never,
            name: a.name,
            handle: a.handle,
            currency: a.currency,
            enabled: a.enabled,
          })),
      };
    }),
    upcoming: [...UPCOMING_NETWORKS],
  };
}

/** The consent URL to send the person to, and the nonce for their browser's cookie. */
export async function startConnect(provider: SocialProvider, shopId: string, origin: string, userId: string | null) {
  const config = socialAppConfig(process.env);
  const app = config[provider];
  if (!app.canConnect || !config.stateSecret) {
    return { ok: false as const, error: "not_configured" };
  }
  const { state, nonce } = createState({ provider, shopId, userId, secret: config.stateSecret });
  const redirect = redirectUri(appOrigin(origin), provider);
  const url =
    provider === "meta"
      ? metaAuthorizeUrl({
          appId: config.meta.appId!,
          graphVersion: config.meta.graphVersion,
          redirect,
          state,
          loginConfigId: config.meta.loginConfigId,
        })
      : provider === "tiktok"
        ? tiktokAuthorizeUrl({ clientKey: config.tiktok.clientKey!, redirect, state })
        : googleAuthorizeUrl({ clientId: config.google.clientId!, redirect, state });
  return { ok: true as const, url, nonce };
}

/**
 * The provider's answer. Returns a short code the dialog translates, never the
 * provider's own text — that is logged, because it may name the account.
 */
export async function completeConnect(
  provider: SocialProvider,
  input: { code: string | null; state: string | null; providerError: string | null; cookieNonce: string | undefined; origin: string; userId: string | null }
): Promise<{ ok: true; accounts: number; shopSlug: string } | { ok: false; code: string; shopSlug?: string }> {
  if (input.providerError) return { ok: false, code: "denied" };
  const config = socialAppConfig(process.env);
  const checked = verifyState({ state: input.state, cookieNonce: input.cookieNonce, provider, secret: config.stateSecret });
  if (!checked.ok) return { ok: false, code: "state" };

  // The shop the person was on when they pressed Connect, signed into the
  // state, and still one the dashboard serves.
  const shop = await servedShopById(checked.shopId);
  if (!shop || checked.userId !== input.userId) return { ok: false, code: "state" };
  const shopId = shop.id;
  if (!input.code) return { ok: false, code: "denied", shopSlug: shop.slug };

  const connect = provider === "meta" ? connectMeta : provider === "tiktok" ? connectTikTok : connectGoogle;
  let result: { ok: boolean; code?: string; error?: string; accounts?: number };
  try {
    result = await connect({
      supabase: getSupabaseClient(),
      shopId,
      code: input.code,
      redirect: redirectUri(appOrigin(input.origin), provider),
      userId: input.userId,
      env: process.env,
    });
  } catch (error) {
    console.error(`social connect ${provider} failed:`, error instanceof Error ? error.message : error);
    return { ok: false, code: "exchange_failed", shopSlug: shop.slug };
  }
  if (!result.ok) {
    console.warn(`social connect ${provider} refused:`, result.error);
    return { ok: false, code: result.code ?? "exchange_failed", shopSlug: shop.slug };
  }
  await queueSync(provider, shopId);
  return { ok: true, accounts: result.accounts ?? 0, shopSlug: shop.slug };
}

/** Queue a `sync_social` job. A burst of clicks collapses into the one already queued. */
export async function queueSync(provider: SocialProvider, shopId: string): Promise<void> {
  const jobs = createMailJobRecord(getSupabaseClient(), { shopId });
  await jobs.enqueue({ kind: "sync_social", dedupeKey: `social:${provider}`, payload: { provider } });
}

export async function disconnect(provider: SocialProvider, shopId: string): Promise<void> {
  await disconnectSocial({ supabase: getSupabaseClient(), shopId, provider });
}

/**
 * Track an account, or stop. `tracked_elsewhere`: another shop tracks it, and
 * one account counts for one shop (scripts/lib/social-account-claims.mjs).
 */
export async function setTracked(shopId: string, accountId: string, enabled: boolean): Promise<"ok" | "not_found" | "tracked_elsewhere"> {
  const row = await setAccountEnabled({ supabase: getSupabaseClient(), shopId, accountId, enabled });
  if (!row) return "not_found";
  return "refused" in row ? "tracked_elsewhere" : "ok";
}

/**
 * Sets which denominator a platform's engagement rate uses (82). One choice per
 * platform, so it is written on every account of that kind. False for a kind or
 * a basis the app does not offer.
 */
export async function setEngagementBasis(kind: unknown, basis: unknown, shopId: string): Promise<boolean> {
  if (!(ORGANIC_KINDS as string[]).includes(kind as string) || !(ENGAGEMENT_BASES as string[]).includes(basis as string)) return false;
  const rows = await supabaseUpdate(getSupabaseClient(), SOCIAL_T.ACCOUNTS, { shop_id: shopId, kind: kind as string }, { engagement_basis: basis }, { select: "id" });
  return rows.length > 0;
}

async function queuedProviders(shopId: string): Promise<Set<string>> {
  try {
    const rows = (await supabaseSelect(
      getSupabaseClient(),
      T.MAIL_JOBS,
      { shop_id: shopId, kind: "sync_social", state: { operator: "in", value: "(queued,running)" } },
      "dedupe_key",
      { limit: 10 }
    )) as { dedupe_key: string }[];
    return new Set(rows.map((r) => r.dedupe_key.replace(/^social:/, "")));
  } catch {
    return new Set();
  }
}
