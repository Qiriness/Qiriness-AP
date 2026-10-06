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
import { refsFromHistory } from "../../../scripts/lib/storefront-chat/conversation-refs.mjs";
import {
  DEFAULT_STOREFRONT_MODEL,
  DEFAULT_TIMEOUT_MS,
  StorefrontAgentError,
  createLlmAgent,
  noRetryWait,
  storefrontFetch,
} from "../../../scripts/lib/storefront-chat/llm-agent.mjs";
import { STOREFRONT_CHAT_RPC, STOREFRONT_CHAT_T } from "../../../scripts/lib/tables.mjs";
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
  path: string | null;
}

export interface StorefrontChatRequest {
  sessionToken: string | null;
  message: string;
  action: string | null;
  /** A clarification chip's value: a product id or a care type. */
  choice: string | null;
  context: StorefrontChatContext;
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

const AGENT_TTL_MS = 5 * 60 * 1000;
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
  if (remembered && remembered.key === model) {
    // STALE WHILE IT REFRESHES. Loading the catalogue takes about a second; the
    // customer who happens to arrive as the copy expires is answered from it
    // while the next one loads, instead of paying that second.
    if (Date.now() - remembered.at >= AGENT_TTL_MS && !rebuilding) {
      rebuilding = buildAgent(db, model).finally(() => {
        rebuilding = null;
      });
      rebuilding.catch((error) => console.warn("[storefront chat] catalogue refresh failed", error instanceof Error ? error.message : error));
    }
    return remembered.agent;
  }
  return rebuilding ?? buildAgent(db, model);
}

async function buildAgent(db: ReturnType<typeof client>, model: string): Promise<Agent> {
  // The brand the advisor speaks for is the catalogue's shop — the one this
  // dashboard syncs — not the dev store hosting the widget.
  const shop = await getShop();
  const toolsOn = process.env.STOREFRONT_CHAT_TOOLS !== "off";
  const [company, catalogue] = shop
    ? await Promise.all([
        loadCompany(db, shop.id),
        toolsOn
          ? loadCatalogue(
              { selectAll: (table: string, filters: object, columns: string) => supabaseSelectAll(db, table, filters, columns) },
              shop.id
            )
          : null,
      ])
    : [{}, null];
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
    currency: process.env.STOREFRONT_CHAT_CURRENCY || "EUR",
    // Dev only: the dev store lacks the catalogue, so cards link to the store
    // that has it. Unset in production, where links stay on the widget's store.
    productBaseUrl: process.env.STOREFRONT_CHAT_PRODUCT_BASE_URL || null,
  });
  remembered = { at: Date.now(), key: model, agent };
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
        ...("trace" in reply && reply.trace ? { trace: reply.trace } : {}),
      },
      model: reply.model,
      input_tokens: reply.usage?.inputTokens ?? null,
      output_tokens: reply.usage?.outputTokens ?? null,
    },
  ]);

  const choices = ("choices" in reply && Array.isArray(reply.choices) ? reply.choices : []) as StorefrontChoice[];
  return { ok: true, sessionId: session.session_token, reply: { text: reply.text, products: reply.products, choices } };
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
