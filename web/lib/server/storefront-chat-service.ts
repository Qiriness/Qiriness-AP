/**
 * The storefront advisor's conversation: one customer message in, one reply
 * out, both kept.
 *
 * Server-only. The route has already proved the shop (app proxy signature +
 * allow-list) and validated the body; this file owns the session, the caps and
 * the log. What answers is `storefront_sales_agent` (scripts/lib/storefront-chat
 * /agent.mjs) — the mock today — and it is handed the message, the page context
 * and this session's own history. Nothing else: no customer, no order, no SQL.
 *
 * THE TOKEN IS MINTED HERE. A token the browser sends is used only if it names
 * a session of the same shop; anything else opens a new session with a token
 * Postgres generated, which the reply hands back.
 *
 * CAPS BEFORE SPEND. Per-session turns and per-shop daily customer messages are
 * checked before the agent runs, so the model sits behind a door that already
 * has a limit.
 *
 * WHICH AGENT ANSWERS is `STOREFRONT_CHAT_AGENT`: `mock` (the default) or `llm`.
 * Opt-in on purpose — the production dashboard carries this route too, and a
 * deploy must never start spending because a key happens to be set.
 */

import { createOpenAIClient } from "../../../agent/src/llm/openai-client.mjs";
import { loadCompany } from "../../../scripts/lib/company.mjs";
import { createMockAgent } from "../../../scripts/lib/storefront-chat/agent.mjs";
import { loadCatalogue } from "../../../scripts/lib/storefront-chat/product-repository.mjs";
import { loadKnowledge, createProductPolicyReader, KNOWLEDGE_TTL_MS } from "../../../scripts/lib/storefront-chat/knowledge-repository.mjs";
import { createShoppingReader, createPublicPromotionReader } from "../../../scripts/lib/storefront-chat/shopping-repository.mjs";
import { parseAllowedShops } from "../../../scripts/lib/storefront-chat/app-proxy-signature.mjs";
import { refsFromHistory } from "../../../scripts/lib/storefront-chat/conversation-refs.mjs";
import { advisorStateFromHistory } from "../../../scripts/lib/storefront-chat/advisor-state.mjs";
import { loadAdvisoryConfig } from "../../../scripts/lib/advisory/advisory-repository.mjs";
import { createAdvisor } from "../../../scripts/lib/advisory/recommend.mjs";
import {
  DEFAULT_STOREFRONT_MODEL,
  DEFAULT_TIMEOUT_MS,
  StorefrontAgentError,
  createLlmAgent,
  noRetryWait,
  storefrontFetch,
} from "../../../scripts/lib/storefront-chat/llm-agent.mjs";
import { ADVISOR_T, STOREFRONT_CHAT_RPC, STOREFRONT_CHAT_T } from "../../../scripts/lib/tables.mjs";
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseInsert,
  supabaseRpc,
  supabaseSelect,
  supabaseSelectAll,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { getShop } from "./shop";

export interface StorefrontChatContext {
  pageType: string | null;
  productHandle: string | null;
  collectionHandle: string | null;
  locale: string | null;
  country?: string | null;
  currency?: string | null;
  market?: string | null;
  variantId?: string | null;
  loggedIn?: boolean;
  path: string | null;
}

export interface StorefrontChatRequest {
  sessionToken: string | null;
  message: string;
  action: string | null;
  /** A clarification chip's value: a product id or a care type. */
  choice: string | null;
  context: StorefrontChatContext;
  /** Ephemeral whitelist; never persisted in the session/message log. */
  cart?: object | null;
}

export interface StorefrontChoice {
  label: string;
  value: string;
}

export interface StorefrontProductCard {
  title: string;
  url: string;
  image: string | null;
  price: string | null;
  rationale: string;
}

export type StorefrontChatResult =
  | { ok: true; sessionId: string; reply: { text: string; products: StorefrontProductCard[]; choices: StorefrontChoice[] } }
  | { ok: false; status: 429; code: "session_limit" | "daily_limit" }
  | { ok: false; status: 503; code: "unavailable" };

interface SessionRow {
  id: string;
  session_token: string;
  turn_count: number;
}

/** History the agent sees. Plenty for a sales conversation; bounded for Phase 2 cost. */
const HISTORY_MESSAGES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function limits() {
  return {
    sessionTurns: positiveInt(process.env.STOREFRONT_CHAT_SESSION_TURN_CAP, 40),
    shopDaily: positiveInt(process.env.STOREFRONT_CHAT_SHOP_DAILY_CAP, 500),
    retentionDays: positiveInt(process.env.STOREFRONT_CHAT_RETENTION_DAYS, 30),
  };
}

function client() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

type Agent = ReturnType<typeof createMockAgent> | ReturnType<typeof createLlmAgent>;

const AGENT_TTL_MS = KNOWLEDGE_TTL_MS;
const AGENT_REFRESH_AHEAD_MS = 60 * 1000;
let remembered: { at: number; key: string; agent: Agent } | null = null;
let rebuilding: Promise<Agent> | null = null;

/**
 * The agent for this request. The LLM agent is rebuilt at most every five
 * minutes, so an edited company description, a new model or a nightly product
 * sync reaches it without a restart, and is never rebuilt per message.
 *
 * THE CATALOGUE IS LOADED HERE, WHOLE, and handed to the agent: about 100 live
 * products, whitelisted by product-repository.mjs. Its tools then answer from
 * memory, so a tool round costs the model's time and no database round trip.
 * `STOREFRONT_CHAT_TOOLS=off` withholds it, which is Phase 2 again.
 */
async function currentAgent(db: ReturnType<typeof client>): Promise<Agent> {
  if (process.env.STOREFRONT_CHAT_AGENT !== "llm") return createMockAgent();

  const model = process.env.STOREFRONT_CHAT_MODEL || DEFAULT_STOREFRONT_MODEL;
  const key = `${model}|${process.env.STOREFRONT_CHAT_CATALOGUE_SHOP_DOMAIN || ""}`;
  if (remembered && remembered.key === key) {
    // STALE WHILE IT REFRESHES. Loading the catalogue takes about a second; the
    // customer who happens to arrive as the copy expires is answered from it
    // while the next one loads, instead of paying that second.
    //
    // REFRESHED AHEAD, NEVER SERVED EXPIRED. The agent's policies and FAQs
    // expire at KNOWLEDGE_TTL_MS (the same five minutes): an agent served stale
    // after a pause answered every policy question « unavailable » — « do you
    // allow payments in three times? » with an active payment policy (dev
    // store, 2026-10-06). So the refresh starts a minute early, and an agent
    // past its lifetime is waited for, not served.
    const age = Date.now() - remembered.at;
    if (age >= AGENT_TTL_MS - AGENT_REFRESH_AHEAD_MS && !rebuilding) {
      rebuilding = buildAgent(db, model, key).finally(() => {
        rebuilding = null;
      });
      rebuilding.catch((error) => console.warn("[storefront chat] catalogue refresh failed", error instanceof Error ? error.message : error));
    }
    if (age >= AGENT_TTL_MS && rebuilding) return rebuilding.catch(() => remembered!.agent);
    return remembered.agent;
  }
  return rebuilding ?? buildAgent(db, model, key);
}

/**
 * DEV ONLY — `STOREFRONT_CHAT_CATALOGUE_SHOP_DOMAIN`. The dev store holds its
 * own small set of products; once `npm run dev-store:sync` has copied them into
 * Supabase under their own shop row, this points the advisor's CATALOGUE
 * (products, collections, product cards) at them, so a dev cart and the
 * advisor talk about the same products. Brand, policies and FAQ stay the
 * dashboard shop's. Unset — production — this returns null and nothing changes.
 * Removing the dev setup: unset it (docs/storefront-chatbot.md § Dev store).
 */
async function devCatalogueShopId(db: ReturnType<typeof client>): Promise<string | null> {
  const domain = process.env.STOREFRONT_CHAT_CATALOGUE_SHOP_DOMAIN;
  if (!domain) return null;
  const rows = (await supabaseSelect(db, "shops", { shop_domain: domain, environment: "development" }, "id", { limit: 1 })) as { id: string }[];
  if (!rows[0]) console.warn(`[storefront chat] ${domain} is not synced as a development shop; using the dashboard catalogue`);
  return rows[0]?.id ?? null;
}

/**
 * DEV ONLY — product FAQs belong to the dashboard shop's products, and a dev
 * catalogue's products have their own ids, so « comment utiliser le masque LED
 * avec la télécommande ? » found no FAQ on the dev store although one exists
 * (2026-10-07). Under a dev catalogue a dev product's FAQ lookup goes to the
 * dashboard product with the same handle. Without a dev catalogue — production
 * — the reader is the plain one.
 */
async function productPolicyReader(
  reader: { selectAll: (table: string, filters: object, columns: string) => Promise<unknown> },
  shopId: string,
  devCatalogue: string | null,
  catalogue: unknown,
) {
  const read = createProductPolicyReader(reader, shopId);
  const devProducts = (catalogue as { products?: { id: string; handle?: string }[] } | null)?.products ?? [];
  if (!devCatalogue || !devProducts.length) return read;
  const rows = (await reader.selectAll("products", { shop_id: shopId }, "id,handle").catch(() => [])) as { id: string; handle: string }[];
  const byHandle = new Map(rows.map((r) => [r.handle, r.id]));
  const toDashboard = new Map<string, string>();
  for (const p of devProducts) {
    const id = p.handle ? byHandle.get(p.handle) : undefined;
    if (id) toDashboard.set(p.id, id);
  }
  // The records are re-labelled with the dev id too: get_product_policy keeps
  // only records whose product_ids include the product it was asked about.
  return async (productId: string) => {
    const dashboardId = toDashboard.get(productId);
    if (!dashboardId) return read(productId);
    const records = (await read(dashboardId)) as { product_ids: string[] }[];
    return records.map((r) => ({ ...r, product_ids: [...r.product_ids, productId] }));
  };
}

/**
 * The beauty consultation engine: the brand's playbooks (advisor_* tables,
 * loaded by `npm run advisor:load`) over the advisor's catalogue. No playbook
 * loaded, or a config that does not validate: null, and the advisor advises
 * from search as before.
 *
 * DEV ONLY — under a dev catalogue the dev products sit in no curated
 * collection, so a playbook's slots and families (« serums-visage », the
 * « Temps Sublime » range) would match nothing. The engine reads each dev
 * product with the dashboard product's collections (same handle); ids, stock
 * and cards stay the dev store's.
 */
async function buildAdvisor(
  reader: { selectAll: (table: string, filters: object, columns: string) => Promise<unknown> },
  shopId: string,
  catalogue: { products: { handle: string; collections: string[] }[]; collections: unknown[] } | null,
  devCatalogue: string | null,
) {
  if (!catalogue) return null;
  try {
    const raw = await loadAdvisoryConfig(reader as never, shopId);
    if (!raw) return null;
    let advisorCatalogue = catalogue;
    if (devCatalogue) {
      const dashboard = (await loadCatalogue(reader as never, shopId)) as typeof catalogue;
      const collectionsOf = new Map(dashboard.products.map((p) => [p.handle, p.collections]));
      advisorCatalogue = {
        products: catalogue.products.map((p) => ({ ...p, collections: collectionsOf.get(p.handle) ?? p.collections })),
        collections: dashboard.collections,
      };
    }
    return createAdvisor(raw, advisorCatalogue);
  } catch (error) {
    console.warn("[storefront chat] advisor unavailable", error instanceof Error ? error.message : error);
    return null;
  }
}

async function buildAgent(db: ReturnType<typeof client>, model: string, key: string): Promise<Agent> {
  // The brand the advisor speaks for is the catalogue's shop — the one this
  // dashboard syncs — not the dev store hosting the widget.
  const shop = await getShop();
  const devCatalogue = await devCatalogueShopId(db);
  const toolsOn = process.env.STOREFRONT_CHAT_TOOLS !== "off";
  const reader = { selectAll: (table: string, filters: object, columns: string) => supabaseSelectAll(db, table, filters, columns) };
  const [company, catalogue, knowledge] = shop
    ? await Promise.all([
        loadCompany(db, shop.id),
        toolsOn
          ? loadCatalogue(
              reader,
              devCatalogue ?? shop.id
            )
          : null,
        // Policy/FAQ failures degrade to explicit unavailable results, not guessed facts.
        toolsOn ? loadKnowledge(reader, shop.id).catch(() => { console.warn("[storefront chat] knowledge load failed"); return null; }) : null,
      ])
    : [{}, null, null];
  const llm = createOpenAIClient({
    apiKey: process.env.OPENAI_API_KEY,
    fetchImpl: storefrontFetch(positiveInt(process.env.STOREFRONT_CHAT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)),
    sleepImpl: noRetryWait,
  });
  const agent = createLlmAgent({
    client: llm,
    model,
    company,
    catalogue,
    knowledge,
    readProductPolicies: toolsOn && shop ? await productPolicyReader(reader, shop.id, devCatalogue, catalogue) : null,
    readShopping: toolsOn ? createShoppingReader(reader) : null,
    readPublicPromotions: toolsOn && shop ? createPublicPromotionReader(reader, { shopId: shop.id, catalogueShopDomain: loadConfig(process.env as Record<string, string | undefined>).shopDomain, allowedShops: parseAllowedShops(process.env.STOREFRONT_CHAT_ALLOWED_SHOPS) }) : null,
    // The shop whose prices the catalogue holds, so its currency is known:
    // Buy X Get Y spend thresholds carry none of their own. Left at the
    // dashboard shop under a dev catalogue, every such offer was « unknown »
    // (threshold_currency_unknown_or_different, dev store, 2026-10-06).
    catalogueShopDomain: devCatalogue ? process.env.STOREFRONT_CHAT_CATALOGUE_SHOP_DOMAIN || null : loadConfig(process.env as Record<string, string | undefined>).shopDomain,
    currency: process.env.STOREFRONT_CHAT_CURRENCY || "EUR",
    // Dev only: the dev store lacks the catalogue, so cards link to the store
    // that has it. Unset in production, where links stay on the widget's store.
    productBaseUrl: process.env.STOREFRONT_CHAT_PRODUCT_BASE_URL || null,
    advisor: toolsOn && shop ? await buildAdvisor(reader, shop.id, catalogue as never, devCatalogue) : null,
  });
  remembered = { at: Date.now(), key, agent };
  return agent;
}

export async function handleStorefrontChat(shopDomain: string, request: StorefrontChatRequest): Promise<StorefrontChatResult> {
  const db = client();
  const cap = limits();

  // THE CUSTOMER IS WAITING, so nothing waits that need not. The agent (and on
  // a cold start, the catalogue) loads while the session is read; the count and
  // the history are one round trip together; the question is logged while the
  // model is already thinking.
  const agentReady = currentAgent(db);
  agentReady.catch(() => {}); // awaited below; never an unhandled rejection meanwhile

  const session = await findOrOpenSession(db, shopDomain, request, cap.retentionDays);
  if (session.turn_count >= cap.sessionTurns) return { ok: false, status: 429, code: "session_limit" };

  const since = new Date(Date.now() - DAY_MS).toISOString();
  const [today, recent] = await Promise.all([
    supabaseRpc(db, STOREFRONT_CHAT_RPC.USER_MESSAGES_SINCE, { p_shop_domain: shopDomain, p_since: since }),
    supabaseSelect(db, STOREFRONT_CHAT_T.MESSAGES, { session_id: session.id }, "role,content,context", {
      order: "created_at.desc",
      limit: HISTORY_MESSAGES,
    }) as Promise<{ role: "user" | "assistant"; content: string; context: Record<string, unknown> | null }[]>,
  ]);
  if (Number(today) >= cap.shopDaily) return { ok: false, status: 429, code: "daily_limit" };
  const history = recent.reverse();
  // « les deux », « l'autre », a clarification just asked: folded from the log.
  const refs = refsFromHistory(history);
  // The consultation so far: profile, mode, questions already asked.
  const advisorState = advisorStateFromHistory(history);

  // Logged whatever happens to the reply, so a failed turn still leaves the question.
  const logged = Promise.all([
    supabaseInsert(db, STOREFRONT_CHAT_T.MESSAGES, [
      { session_id: session.id, role: "user", content: request.message, action: request.action, context: request.context },
    ]),
    supabaseRpc(db, STOREFRONT_CHAT_RPC.RECORD_TURN, { p_session: session.id }),
  ]);
  logged.catch(() => {}); // awaited below

  let reply;
  try {
    const agent = await agentReady;
    reply = await agent.respond({
      message: request.message,
      action: request.action,
      context: request.context,
      history,
      refs,
      choice: request.choice,
      cart: request.cart ?? null,
      shopDomain,
      advisorState,
      conversationRef: session.id,
    });
  } catch (error) {
    await logged;
    if (!(error instanceof StorefrontAgentError)) throw error;
    // The question is logged; the widget offers « Réessayer ».
    console.warn("[storefront chat] agent unavailable", error.message);
    return { ok: false, status: 503, code: "unavailable" };
  }
  await logged;

  await supabaseInsert(db, STOREFRONT_CHAT_T.MESSAGES, [
    {
      session_id: session.id,
      role: "assistant",
      content: reply.text,
      // What it showed, and how long each model call and which tool calls took
      // it there: enough to see where a slow reply spent its time.
      context: {
        products: reply.products.map((p: StorefrontProductCard) => p.url),
        // The conversation memory: what this answer recommended and mentioned,
        // and how the question it answered was resolved (incl. a pending
        // clarification). The next turn's « les deux » reads these.
        ...("refs" in reply && reply.refs ? { refs: reply.refs } : {}),
        ...("resolution" in reply && reply.resolution ? { resolution: reply.resolution } : {}),
        // The consultation's memory: profile (value, source, confidence), mode,
        // questions asked, last advice. The next turn folds it back.
        ...("advisor" in reply && reply.advisor ? { advisor: reply.advisor } : {}),
        ...("trace" in reply && reply.trace ? { trace: reply.trace } : {}),
        ...("replyLanguage" in reply && reply.replyLanguage ? { replyLanguage: reply.replyLanguage } : {}),
      },
      model: reply.model,
      input_tokens: reply.usage?.inputTokens ?? null,
      output_tokens: reply.usage?.outputTokens ?? null,
    },
  ]);

  recordAdvisoryEvents(db, shopDomain, "events" in reply && Array.isArray(reply.events) ? reply.events : []);

  const choices = ("choices" in reply && Array.isArray(reply.choices) ? reply.choices : []) as StorefrontChoice[];
  return { ok: true, sessionId: session.session_token, reply: { text: reply.text, products: reply.products, choices } };
}

/**
 * Advisory analytics (advisory_events), written after the reply and never
 * waited for: a failed write costs a data point, not the customer's answer.
 */
export function recordAdvisoryEvents(db: ReturnType<typeof client>, shopDomain: string, events: object[]) {
  if (!events.length) return;
  supabaseInsert(db, ADVISOR_T.EVENTS, events.map((e) => ({ ...e, shop_domain: shopDomain }))).catch((error: unknown) => {
    console.warn("[storefront chat] advisory events not recorded", error instanceof Error ? error.message : error);
  });
}

/** A card click from the widget, through the signed event route. */
export async function recordProductClick(shopDomain: string, sessionToken: string, productId: string) {
  const db = client();
  const rows = (await supabaseSelect(db, STOREFRONT_CHAT_T.SESSIONS, { session_token: sessionToken, shop_domain: shopDomain }, "id", { limit: 1 })) as { id: string }[];
  if (!rows[0]) return false;
  recordAdvisoryEvents(db, shopDomain, [
    { channel: "storefront_chat", conversation_ref: rows[0].id, event_type: "product_clicked", playbook_key: null, product_ids: [productId], payload: {} },
  ]);
  return true;
}

async function findOrOpenSession(
  db: ReturnType<typeof client>,
  shopDomain: string,
  request: StorefrontChatRequest,
  retentionDays: number
): Promise<SessionRow> {
  if (request.sessionToken) {
    const rows = (await supabaseSelect(
      db,
      STOREFRONT_CHAT_T.SESSIONS,
      { session_token: request.sessionToken, shop_domain: shopDomain, status: "active" },
      "id,session_token,turn_count",
      { limit: 1 }
    )) as SessionRow[];
    if (rows[0]) return rows[0];
  }

  // A new session is the cheap moment to apply retention: once per conversation, not per message.
  await supabaseRpc(db, STOREFRONT_CHAT_RPC.PURGE, {
    p_before: new Date(Date.now() - retentionDays * DAY_MS).toISOString(),
  });

  const [created] = (await supabaseInsert(db, STOREFRONT_CHAT_T.SESSIONS, [
    { shop_domain: shopDomain, locale: request.context.locale },
  ])) as SessionRow[];
  return created;
}
