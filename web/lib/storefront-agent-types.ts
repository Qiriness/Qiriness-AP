/**
 * The Storefront Agent dashboard's contract: what the service hands the page.
 * Isomorphic. A null figure is « not measured » (rendered as a dash with its
 * reason), never zero.
 */
import type { InsightsRange, SeriesPoint } from "./types";

/** Mirrors TURN_INTENTS in scripts/lib/storefront-chat/turn-metrics.mjs. */
export type AgentIntent = "routine_building" | "product_discovery" | "reordering" | "faq" | "customer_service" | "other";
/** Mirrors TURN_ROUTES. */
export type AgentRoute = "llm" | "rules" | "mock";

/** A figure for this period and the one before; `previous` is null when there is no fair comparison. */
export interface PeriodFigure {
  current: number | null;
  previous: number | null;
}

export interface FunnelStage {
  key: "visits" | "opens" | "conversations" | "shown" | "clicked" | "carted" | "purchased";
  /** Null: not tracked (see `reason`). */
  value: number | null;
  /** An i18n key saying why a stage is not tracked. */
  reason?: string;
}

export interface AgentProductRow {
  productId: string;
  title: string | null;
  handle: string | null;
  /** Conversations in which it was shown / clicked / added to cart. */
  shown: number;
  clicked: number;
  carted: number;
  /** In assisted orders; null when purchases are not tracked. */
  units: number | null;
  sales: number | null;
}

export interface AgentRouteRow {
  route: AgentRoute;
  turns: number;
  p50: number | null;
  p95: number | null;
  resolution: number | null;
  clickRate: number | null;
  cartRate: number | null;
  errorRate: number | null;
  costUsd: number | null;
}

export interface AgentIntentRow {
  intent: AgentIntent;
  conversations: number;
  resolution: number | null;
  cartRate: number | null;
  /** Null when purchases are not tracked. */
  conversion: number | null;
  revenue: number | null;
  p50: number | null;
  p95: number | null;
}

export interface StorefrontAgentDashboard {
  /** The advisor's shops (STOREFRONT_CHAT_ALLOWED_SHOPS). Empty: the advisor is not set up here. */
  shops: string[];
  range: InsightsRange;
  coverage: {
    /** First turn recorded (backfilled or live), ISO. */
    turnsFrom: string | null;
    /** First turn recorded live with exact latency, ISO. */
    liveTurnsFrom: string | null;
    opensFrom: string | null;
    /** The advisor's shop has its orders synced, so a purchase can be seen at all. */
    purchasesTracked: boolean;
    /** The previous window lies inside the recorded history. */
    previousCovered: boolean;
  };
  kpis: {
    conversations: PeriodFigure;
    revenue: PeriodFigure;
    orders: PeriodFigure;
    conversion: PeriodFigure;
    resolution: PeriodFigure;
    p95: PeriodFigure;
  };
  funnel: FunnelStage[];
  sales: {
    revenue: SeriesPoint[];
    conversations: SeriesPoint[];
    aov: PeriodFigure;
    products: AgentProductRow[];
    byIntent: { intent: AgentIntent; revenue: number | null; conversations: number }[];
  };
  quality: {
    resolution: PeriodFigure;
    escalation: PeriodFigure;
    unanswered: { turns: number; rate: number | null; previousRate: number | null };
    errorRate: PeriodFigure;
  };
  technical: {
    p50: PeriodFigure;
    p95: PeriodFigure;
    modelP50: number | null;
    modelP95: number | null;
    turns: number;
    failedTurns: number;
    errors: { code: string; turns: number }[];
    toolCalls: number;
    toolFailures: number;
    fallbackRate: PeriodFigure;
    fallbacks: { kind: string; turns: number }[];
    inputTokens: number;
    outputTokens: number;
    costUsd: PeriodFigure;
    costPerConversation: PeriodFigure;
    /** Some model ran without a rate in llm-rates.mjs: cost is a floor. */
    unpriced: boolean;
  };
  routes: AgentRouteRow[];
  intents: AgentIntentRow[];
}
