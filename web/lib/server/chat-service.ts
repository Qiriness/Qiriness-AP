/**
 * The management chat on Home: asks the agent loop a question and keeps the
 * record of it.
 *
 * Server-only. The pieces it wires together live in scripts/lib, where they are
 * tested: chat-agent-loop (the loop), chat-sql-executor (the read-only role),
 * chat-sql-guard (what may run), chat-system-prompt (the rules). This file owns
 * only the conversation log and who may read it.
 *
 * TWO CONNECTIONS, ON PURPOSE. The model's SQL goes through `CHAT_DB_URL` as
 * `mgmt_chat_ro`, which can read the `chat` views and nothing else. The log is
 * written over the service-role REST client like every other table — the model
 * never reaches it, and the read-only role could not write it.
 *
 * LOGGED BEFORE IT IS SPENT. The turn row is inserted before the first model
 * call, so a request that dies mid-run still leaves a `running` row with its
 * question; queries are collected as they finish, so a turn that throws still
 * logs the SQL it ran.
 */

import { createOpenAIClient } from "../../../agent/src/llm/openai-client.mjs";
import { buildHistory, runChatTurn } from "../../../scripts/lib/chat-agent-loop.mjs";
import {
  LOG_PREVIEW_ROWS,
  createChatPool,
  createSqlExecutor,
  loadSchemaText,
} from "../../../scripts/lib/chat-sql-executor.mjs";
import { buildSystemPrompt } from "../../../scripts/lib/chat-system-prompt.mjs";
import { estimateCost } from "../../../scripts/lib/llm-rates.mjs";
import {
  createSupabaseClient,
  supabaseInsert,
  supabaseSelect,
  supabaseSelectAll,
  supabaseUpdate,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { CHAT_T } from "../../../scripts/lib/tables.mjs";
import type {
  ChatConversationDetail,
  ChatConversationSummary,
  ChatQueryView,
  ChatReadiness,
  ChatStepEvent,
  ChatTurnStatus,
  ChatTurnView,
} from "../chat-types";
import type { CurrentUser } from "./auth";
import { getShopId } from "./knowledge-service";

/** A reasoning model: questions are one-off and worth the larger model (the owner's call, 2026-09-14). */
const DEFAULT_CHAT_MODEL = "gpt-5.2";

/** Rows per query sent to the browser while a turn streams. The log keeps LOG_PREVIEW_ROWS. */
const UI_PREVIEW_ROWS = 200;

/** How long the schema text and timezone are reused before being read again. */
const SCHEMA_TTL_MS = 10 * 60_000;

const TITLE_CHARS = 80;
const CONVERSATION_LIST_LIMIT = 50;

const TURN_COLUMNS =
  "id,conversation_id,question,answer,status,error,model,steps,input_tokens,cached_input_tokens,output_tokens,duration_ms,created_at";
const QUERY_COLUMNS = "turn_id,step,sql,ok,row_count,truncated,duration_ms,error,columns,rows_preview,created_at";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ChatNotFoundError extends Error {}

export function chatModel(): string {
  return process.env.CHAT_MODEL || DEFAULT_CHAT_MODEL;
}

export function chatReadiness(): ChatReadiness {
  const problems: string[] = [];
  if (!process.env.CHAT_DB_URL) {
    problems.push(
      "CHAT_DB_URL is not set, so there is no read-only database connection for the chat. See DECISIONS.md § Management chat for the one-time setup."
    );
  }
  if (!process.env.OPENAI_API_KEY) problems.push("OPENAI_API_KEY is not set.");
  return { ready: problems.length === 0, model: chatModel(), problems };
}

// --- connections -----------------------------------------------------------------

let cachedRest: ReturnType<typeof createSupabaseClient> | null = null;
function rest() {
  if (!cachedRest) cachedRest = createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
  return cachedRest;
}

interface ChatState {
  url: string;
  pool: ReturnType<typeof createChatPool>;
  schema?: { text: string; timezone: string; at: number };
}

/**
 * The pool and the schema, kept on globalThis so a dev-server reload does not
 * open a new pool per edit against a role limited to five connections.
 */
const holder = globalThis as unknown as { __qirinessManagementChat?: ChatState };

async function chatContext() {
  const url = process.env.CHAT_DB_URL as string;
  let state = holder.__qirinessManagementChat;
  if (!state || state.url !== url) {
    state = { url, pool: createChatPool(url) };
    holder.__qirinessManagementChat = state;
  }
  if (!state.schema || Date.now() - state.schema.at > SCHEMA_TTL_MS) {
    const text = await loadSchemaText(state.pool);
    const shop = await state.pool.query("select iana_timezone from chat.shop where iana_timezone is not null limit 1");
    state.schema = { text, timezone: shop.rows[0]?.iana_timezone ?? "UTC", at: Date.now() };
  }
  return { pool: state.pool, schemaText: state.schema.text, timezone: state.schema.timezone };
}

function todayIn(timezone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

// --- reading the log --------------------------------------------------------------

export async function listConversations(user: CurrentUser): Promise<ChatConversationSummary[]> {
  const shopId = await getShopId();
  const rows = await supabaseSelect(
    rest(),
    CHAT_T.CONVERSATIONS,
    { shop_id: shopId, user_id: user.sub },
    "id,title,updated_at",
    { order: "updated_at.desc", limit: CONVERSATION_LIST_LIMIT }
  );
  return (rows ?? []).map((row: any) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }));
}

/** One conversation, or null when it does not exist or belongs to someone else. */
export async function getConversation(user: CurrentUser, id: string): Promise<ChatConversationDetail | null> {
  const conversation = await ownedConversation(user, id);
  if (!conversation) return null;
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updated_at,
    turns: await loadTurns(conversation.id),
  };
}

async function ownedConversation(user: CurrentUser, id: string) {
  if (!UUID.test(id)) return null;
  const shopId = await getShopId();
  const rows = await supabaseSelect(
    rest(),
    CHAT_T.CONVERSATIONS,
    { id, shop_id: shopId, user_id: user.sub },
    "id,title,updated_at"
  );
  return rows?.[0] ?? null;
}

async function loadTurns(conversationId: string): Promise<ChatTurnView[]> {
  const turns = await supabaseSelectAll(rest(), CHAT_T.TURNS, { conversation_id: conversationId }, TURN_COLUMNS, {
    order: "created_at.asc",
  });
  if (turns.length === 0) return [];
  const queries = await supabaseSelectAll(
    rest(),
    CHAT_T.QUERIES,
    { turn_id: { operator: "in", value: `(${turns.map((turn: any) => turn.id).join(",")})` } },
    QUERY_COLUMNS,
    { order: "created_at.asc" }
  );
  return turns.map((turn: any) =>
    toTurnView(
      turn,
      queries.filter((query: any) => query.turn_id === turn.id).map(queryRowToView)
    )
  );
}

function queryRowToView(row: any): ChatQueryView {
  return {
    step: row.step,
    sql: row.sql,
    ok: row.ok,
    rowCount: row.row_count,
    truncated: row.truncated,
    durationMs: row.duration_ms,
    error: row.error,
    columns: row.columns ?? [],
    rows: Array.isArray(row.rows_preview) ? row.rows_preview : [],
  };
}

function toTurnView(row: any, queries: ChatQueryView[]): ChatTurnView {
  const cost = estimateCost({
    model: row.model,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
  });
  return {
    id: row.id,
    question: row.question,
    answer: row.answer ?? null,
    status: row.status as ChatTurnStatus,
    error: row.error ?? null,
    model: row.model,
    steps: row.steps ?? 0,
    inputTokens: row.input_tokens ?? 0,
    cachedInputTokens: row.cached_input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    durationMs: row.duration_ms ?? null,
    costUsd: cost.rated ? cost.totalUsd : null,
    createdAt: row.created_at,
    queries,
  };
}

// --- asking -------------------------------------------------------------------------

interface AskOptions {
  user: CurrentUser;
  conversationId: string | null;
  question: string;
  onConversation: (conversationId: string) => void;
  onEvent: (event: ChatStepEvent) => void;
}

export async function askQuestion({
  user,
  conversationId,
  question,
  onConversation,
  onEvent,
}: AskOptions): Promise<{ conversationId: string; turn: ChatTurnView }> {
  const readiness = chatReadiness();
  if (!readiness.ready) throw new Error(readiness.problems.join(" "));

  const db = rest();
  let conversation: any;
  if (conversationId) {
    conversation = await ownedConversation(user, conversationId);
    if (!conversation) throw new ChatNotFoundError("That conversation was not found.");
  } else {
    const shopId = await getShopId();
    [conversation] = await supabaseInsert(db, CHAT_T.CONVERSATIONS, [
      { shop_id: shopId, user_id: user.sub, title: titleFrom(question) },
    ]);
  }
  onConversation(conversation.id);

  // Earlier turns that produced an answer. A failed or unfinished turn has
  // nothing a follow-up could build on.
  const earlier = (await loadTurns(conversation.id)).filter((turn) => turn.answer && turn.status !== "error");

  const model = chatModel();
  const [turnRow] = await supabaseInsert(db, CHAT_T.TURNS, [
    { conversation_id: conversation.id, asked_by: user.sub, question, model, status: "running" },
  ]);

  const started = Date.now();
  const finished: ChatQueryView[] = [];
  let patch: Record<string, unknown>;

  try {
    const { pool, schemaText, timezone } = await chatContext();
    const result = await runChatTurn({
      client: createOpenAIClient({ apiKey: process.env.OPENAI_API_KEY }),
      model,
      system: buildSystemPrompt({ schemaText, today: todayIn(timezone), timezone }),
      history: buildHistory(
        earlier.map((turn) => ({ question: turn.question, answer: turn.answer ?? "", queries: turn.queries }))
      ),
      question,
      executeSql: createSqlExecutor({ pool }),
      onEvent: (event: any) => {
        if (event.type === "query_finished") {
          finished.push(event.query);
          onEvent({ type: "query_finished", query: { ...event.query, rows: event.query.rows.slice(0, UI_PREVIEW_ROWS) } });
        } else {
          onEvent(event);
        }
      },
    });
    patch = {
      answer: result.answer,
      status: result.status,
      steps: result.steps,
      input_tokens: result.usage.inputTokens,
      cached_input_tokens: result.usage.cachedInputTokens,
      output_tokens: result.usage.outputTokens,
    };
  } catch (error) {
    patch = {
      status: "error",
      error: error instanceof Error ? error.message.slice(0, 2000) : "The question could not be answered.",
      steps: finished.length ? Math.max(...finished.map((query) => query.step)) : 0,
    };
  }

  patch.duration_ms = Date.now() - started;
  patch.completed_at = new Date().toISOString();

  // The log is written even when the turn failed; a failure to write it is
  // reported but does not throw away an answer that was already paid for.
  await Promise.all([
    finished.length
      ? supabaseInsert(
          db,
          CHAT_T.QUERIES,
          finished.map((query) => ({
            turn_id: turnRow.id,
            step: query.step,
            sql: query.sql,
            ok: query.ok,
            row_count: query.rowCount,
            truncated: query.truncated,
            duration_ms: Math.round(query.durationMs),
            error: query.error,
            columns: query.columns,
            rows_preview: query.rows.slice(0, LOG_PREVIEW_ROWS),
          }))
        )
      : Promise.resolve(),
    supabaseUpdate(db, CHAT_T.TURNS, { id: turnRow.id }, patch),
    supabaseUpdate(db, CHAT_T.CONVERSATIONS, { id: conversation.id }, { updated_at: new Date().toISOString() }),
  ]).catch((error) => {
    console.error("[management-chat] could not write the log for a turn", {
      turnId: turnRow.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  if (patch.status === "error") throw new Error(String(patch.error));

  const shown = finished.map((query) => ({ ...query, rows: query.rows.slice(0, UI_PREVIEW_ROWS) }));
  return { conversationId: conversation.id, turn: toTurnView({ ...turnRow, ...patch }, shown) };
}

function titleFrom(question: string): string {
  const firstLine = question.split("\n")[0].trim();
  return firstLine.length > TITLE_CHARS ? `${firstLine.slice(0, TITLE_CHARS - 1)}…` : firstLine;
}
