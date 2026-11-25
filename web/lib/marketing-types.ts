/**
 * Contracts of the redesigned Marketing & funnel panel: the Marketing
 * Performance tab and the Funnel & Website tab. The figures are computed in
 * scripts/lib/{marketing-channels,marketing-metrics,storefront-marketing,
 * website-opportunities}.mjs; these types are what crosses into the views.
 */

import type { Compared, KlaviyoPerformance, LivePart, NewsletterActivity } from "./types";
import type { PaidKind } from "./social-types";

export type MarketingTab = "marketing" | "funnel";

export type AttributionModel = "lndc" | "last" | "first" | "linear";

export type ChannelGroup =
  | "paid_search"
  | "paid_social"
  | "email"
  | "organic_search"
  | "organic_social"
  | "direct"
  | "referral"
  | "affiliate"
  | "other"
  | "unknown";

export type ProviderId = "google_ads" | "meta_ads" | "klaviyo";

/** See scripts/lib/marketing-metrics.mjs for what each state means. */
export type FigureState = "measured" | "estimated" | "unavailable" | "insufficient" | "not_configured" | "not_tracked";

export interface Figure {
  value: number | null;
  state: FigureState;
  /** A message key saying why there is no value. */
  reason: string | null;
}

export type ExecutiveKey =
  | "adSpend"
  | "marketingCosts"
  | "websiteNet"
  | "providerRevenue"
  | "shopifyPaidNet"
  | "providerRoas"
  | "shopifyRoas"
  | "mer"
  | "emer"
  | "newCustomerMer"
  | "newCustomers"
  | "cac"
  | "cpa"
  | "newCustomerNet"
  | "returningNet"
  | "revenueAfterAds"
  | "contribution"
  | "ltvCac"
  | "ltgpCac";

export type ExecutiveFigures = Record<ExecutiveKey, Figure>;

export interface FunnelCounts {
  sessions: number;
  cartSessions: number;
  checkoutSessions: number;
  convertedSessions: number;
}

export interface ChannelRow {
  group: ChannelGroup;
  sessions: number;
  convertedSessions: number;
  conversionRate: number | null;
  orders: number;
  netSales: number;
  newCustomers: number;
  aov: number | null;
  revenuePerSession: number | null;
  newCustomerShare: number | null;
  revenueShare: number | null;
  sessionShare: number | null;
  /** Null when no connected provider carries spend for this group. */
  spend: number | null;
  spendShare: number | null;
  roas: number | null;
  cac: number | null;
  cpa: number | null;
}

export interface ProviderSide {
  revenue: number;
  conversions: number;
  roas: number | null;
  cpa: number | null;
}

export interface ShopifySide {
  netSales: number;
  totalSales: number;
  orders: number;
  newCustomers: number;
  roas: number | null;
  roasTotal: number | null;
  cpa: number | null;
  cac: number | null;
  aov: number | null;
  newCustomerShare: number | null;
}

export interface Difference {
  abs: number;
  pct: number | null;
}

/** One campaign: the provider's figures beside Shopify's for the UTM campaign of the same name. */
export interface ProviderCampaignRow {
  key: string;
  name: string | null;
  /** The provider's own campaign type (Google's advertising channel type, Meta's objective). */
  objective: string | null;
  status: string | null;
  url: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  conversions: number;
  conversionValue: number;
  roas: number | null;
  /** Null when no UTM campaign in Shopify carries this campaign's name. */
  shopify: { sessions: number; orders: number; netSales: number; newCustomers: number; conversionRate: number | null } | null;
}

export interface ProviderComparison {
  id: ProviderId;
  /** The account kind spend is stored under; null for an owned channel. */
  kind: PaidKind | null;
  connected: boolean;
  /** Why nothing of the provider's own is shown (not connected, mixed currency, not synced). */
  blockedReason: string | null;
  lastSyncAt: string | null;
  currency: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  provider: ProviderSide | null;
  shopify: ShopifySide;
  sessions: number | null;
  conversionRate: number | null;
  revenuePerSession: number | null;
  difference: { revenue: Difference | null; orders: Difference | null } | null;
  campaigns: ProviderCampaignRow[];
  /** UTM campaigns Shopify credits to this provider that match no provider campaign by name. */
  unmatchedCampaigns: { name: string; orders: number; netSales: number; sessions: number }[];
}

export interface MarketingPerformanceData {
  model: AttributionModel;
  currency: string | null;
  kpis: Compared<ExecutiveFigures>;
  channels: ChannelRow[];
  coverage: { orders: number; unknownOrders: number; knownShare: number | null };
  providers: ProviderComparison[];
  /** Shopify's email figures beside Klaviyo's own. */
  email: { shopify: ShopifySide; sessions: number | null; conversionRate: number | null };
}

/** The Klaviyo section: the existing card's read, with campaign / flow totals. */
export interface KlaviyoSection extends KlaviyoPerformance {
  byKind: Record<"campaign" | "flow", { recipients: number; delivered: number; opens: number; clicks: number; conversions: number; revenue: number }> | null;
  conversions: number | null;
}

export interface MarketingPerformancePanel {
  tab: "marketing";
  model: AttributionModel;
  /** ShopifyQL + ads: streamed. */
  performance: Promise<LivePart<MarketingPerformanceData | null>>;
  klaviyo: KlaviyoSection;
  newsletter: NewsletterActivity;
}

/** One row of the traffic cut the funnel filters fold (compact: the client folds it). */
export interface TrafficRow extends FunnelCounts {
  device: string;
  landingType: string;
  group: ChannelGroup;
  provider: ProviderId | null;
  campaign: string | null;
}

export interface LandingPage extends FunnelCounts {
  path: string;
  type: string;
  title: string | null;
  /** Collections: their category; null for other pages. */
  category: string | null;
  /** Products: their price band; null for other pages. */
  priceBand: string | null;
  visitors: number | null;
  bounceRate: number | null;
  cartRate: number | null;
  checkoutRate: number | null;
  conversionRate: number | null;
  checkoutCompletion: number | null;
  previous: FunnelCounts | null;
  byGroup: { key: ChannelGroup; counts: FunnelCounts }[];
  byDevice: { key: string; counts: FunnelCounts }[];
}

export interface Opportunity {
  path: string;
  title: string | null;
  type: string;
  segment: string | null;
  sessions: number;
  conversionRate: number;
  benchmarkRate: number | null;
  addToCartRate: number;
  benchmarkAddToCart: number | null;
  peers: number;
  potentialConversions: number;
  potentialRevenue: number | null;
  confidence: "ok" | "low";
  flags: ("lowAddToCart" | "paidBelowOrganic" | "mobileBelowDesktop")[];
}

export interface WebsitePerformanceData {
  country: string | null;
  countries: string[];
  traffic: TrafficRow[];
  previousTraffic: TrafficRow[] | null;
  pages: LandingPage[];
  /** The shop's storefront, for « open the page » links; null when unknown. */
  storefrontUrl: string | null;
  aov: number | null;
  opportunities: Opportunity[];
}

export interface WebsitePerformancePanel {
  tab: "funnel";
  performance: Promise<LivePart<WebsitePerformanceData | null>>;
}

export type MarketingFunnelPanel = MarketingPerformancePanel | WebsitePerformancePanel;
