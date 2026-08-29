/**
 * The shapes the test chat renders.
 *
 * Isomorphic and server-free, like `lib/types.ts`: the trace is written by
 * `agent/src/testing/trace.mjs` (untyped `.mjs`, reached through `allowJs`) and
 * read here, so this file is where that boundary is given a type. Every field is
 * optional-by-step rather than one union per step — a stored trace outlives the
 * code that wrote it, and a renderer that throws on an older run's missing field
 * would make the history unreadable the first time a step gains one.
 */

export type TraceStep =
  | "input"
  | "gate"
  | "identity"
  | "categorise"
  | "decompose"
  | "tool"
  | "case_file"
  | "order_resolution"
  | "order_context"
  | "draft"
  | "article"
  | "error";

/** One model call, as the decorator recorded it. */
export interface ModelCall {
  pass: string;
  model: string | null;
  system: string | null;
  messages: { role: string; content: string | null; toolCalls?: string[] }[];
  tools: string[];
  toolChoice?: string;
  response: string | null;
  ms: number;
  failed: boolean;
  error?: string;
}

/**
 * The parcels a run's order carries, read out of its own trace.
 *
 * THE TRACE IS THE ONLY SOURCE HERE. A rehearsal writes no ticket, so there is
 * no `resolved_context` to project and no row to join — `summariseOrder` in
 * run-rehearsal.mjs puts number, carrier and URL on the `order_context` step for
 * exactly this reason.
 *
 * IT TOLERATES THE OLD SHAPE. Runs recorded before parcels were carried hold a
 * COUNT in `tracking` and a `fulfilments` key beside it; those come back as no
 * parcels rather than as a crash, so opening an old run still works and simply
 * shows what it always showed.
 */
export function parcelsFromTrace(events: TraceEvent[]): TrackingParcel[] {
  const step = events.find((event) => event.type === "order_context");
  const tracking = (step?.order as { tracking?: unknown } | null | undefined)?.tracking;
  if (!Array.isArray(tracking)) {
    return [];
  }
  return tracking
    .map((parcel) => ({
      number: String((parcel as any)?.number ?? ""),
      carrier: ((parcel as any)?.carrier ?? null) as string | null,
      url: ((parcel as any)?.url ?? null) as string | null,
    }))
    .filter((parcel) => parcel.number.length > 0);
}

/** One parcel on the run's order. Mirrors `TicketTracking` in lib/types. */
export interface TrackingParcel {
  number: string;
  carrier: string | null;
  url: string | null;
}

export interface TraceEvent {
  type: TraceStep;
  at: string;
  /** Every model call the pass at this step made. */
  calls?: ModelCall[];
  [key: string]: unknown;
}

export type ArticleVerdict =
  | "used"
  | "retrieved_withheld"
  | "outranked"
  | "not_retrieved"
  | "not_searched";

export interface ArticleResult {
  verdict: ArticleVerdict;
  searched: boolean;
  offered: boolean;
  best: {
    chunkId: string;
    title: string | null;
    heading: string | null;
    similarity: number;
    band: "answerable" | "weak" | "none";
  } | null;
  rank: number | null;
  chunksRanked: number;
  poolSize: number;
  bands: { answerable: number; weak: number };
  documentId?: string;
  title?: string;
}

export interface RunSummary {
  id: string;
  ranAt: string;
  status: "complete" | "gated" | "failed";
  subject: string | null;
  body: string;
  requesterMasked: string | null;
  orderNumber: string | null;
  expectDocumentId: string | null;
  articleVerdict: ArticleVerdict | null;
  gateOutcome: string | null;
  category: string | null;
  requestKind: string | null;
  level: number | null;
  language: string | null;
  verdict: string | null;
  draftSkippedReason: string | null;
  draftChecksPassed: boolean | null;
  hasIdealAnswer: boolean;
  totalTokens: number;
}

export interface RunDetail extends RunSummary {
  requesterName: string | null;
  draftBody: string | null;
  draftDisposition: string | null;
  idealBody: string | null;
  idealSavedAt: string | null;
  trace: TraceEvent[];
  tokens: { input: number; output: number; total: number; calls: number };
  failedPass: string | null;
  errorMessage: string | null;
}

export interface RunCost {
  usd: number;
  rated: boolean;
  models: string[];
}

export interface Readiness {
  ready: boolean;
  problems: string[];
  brandVoiceApproved: boolean;
}

/** What the operator types. Identity is fields because on a real email it is the envelope. */
export interface RehearsalInput {
  name: string;
  email: string;
  subject: string;
  body: string;
  orderNumber: string;
}

export const EMPTY_INPUT: RehearsalInput = {
  name: "",
  email: "",
  subject: "",
  body: "",
  orderNumber: "",
};

/** What each article verdict means, and what it points at. */
export const ARTICLE_VERDICT_LABELS: Record<ArticleVerdict, { label: string; tone: "good" | "warn" | "bad"; hint: string }> = {
  used: {
    label: "Used",
    tone: "good",
    hint: "A chunk of this article reached the drafting model.",
  },
  retrieved_withheld: {
    label: "Found but withheld",
    tone: "warn",
    hint: "Retrieval found it, but its score fell below the answerable bar, so the agent was never shown it. Fix the wording, or revisit the bands.",
  },
  outranked: {
    label: "Outranked",
    tone: "warn",
    hint: "It cleared the bar, but other chunks took the places available. A competing article is scoring higher on this question.",
  },
  not_retrieved: {
    label: "Not retrieved",
    tone: "bad",
    hint: "The search ran and this article was not in the results at all. Check its category, whether it is embedded, and whether it really answers this question.",
  },
  not_searched: {
    label: "Never searched",
    tone: "bad",
    hint: "The knowledge tool never ran for this ticket — this subject may not have it at all. That is a categorisation problem, not a knowledge one.",
  },
};
