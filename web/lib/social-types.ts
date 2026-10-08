/**
 * Isomorphic: the Social media panel's shapes, and the Connections dialog's.
 * Services fill them; components render them. Codes, not sentences — the
 * screens pick the words (lib/i18n/messages/insights-social.ts).
 */

import type { SeriesPoint } from "./types";

export type SocialProvider = "meta" | "google";
export type SocialKind = "instagram" | "facebook" | "meta_ads" | "google_ads";
export type OrganicKind = "instagram" | "facebook";
export type PaidKind = "meta_ads" | "google_ads";
export type SocialMode = "organic" | "paid";
export type OrganicView = "profile" | "content" | "posts";

export interface SocialAccount {
  id: string;
  kind: SocialKind;
  name: string | null;
  handle: string | null;
  currency: string | null;
  enabled: boolean;
}

export interface ProviderStatus {
  provider: SocialProvider;
  /** The app's credentials are set, so Connect can work. */
  configured: boolean;
  /** The env vars that are not set, when not configured. */
  missing: string[];
  connected: boolean;
  connectedAt: string | null;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: "ok" | "failed" | "needs_reconnect" | null;
  lastSyncError: string | null;
  syncQueued: boolean;
  accounts: SocialAccount[];
}

export interface SocialConnectionsStatus {
  providers: ProviderStatus[];
  /** Networks drawn as « Coming soon ». */
  upcoming: string[];
}

export interface OrganicTotals {
  views: number | null;
  engagement: number | null;
  profileVisits: number | null;
  linkTaps: number | null;
  posts: number | null;
  /** Percent: Σ engagement / Σ reach over the posts carrying both. */
  engagementRate: number | null;
  followers: number | null;
  growth: number | null;
}

export interface Compared<T> {
  current: T;
  /** Null when the previous period is outside what was synced. */
  previous: T | null;
}

/** Unique people over the range, read live; null with a reason when it cannot be. */
export interface LiveReach {
  reach: number | null;
  accountsEngaged: number | null;
  /** A message key, when the figures could not be read. */
  blockedReason: string | null;
}

export interface SocialDriver {
  key: "views" | "engagement" | "growth" | "engagementRate";
  change: number | null;
  points: boolean;
  share: number | null;
}

export interface AudienceBucket {
  key: string;
  value: number;
  /** Percent of the dimension's total. */
  share: number;
}

export interface SocialAudience {
  capturedOn: string | null;
  gender: AudienceBucket[];
  age: AudienceBucket[];
  country: AudienceBucket[];
  city: AudienceBucket[];
}

/** What interactions are divided by for a platform's engagement rate (82). */
export type EngagementBasis = "followers" | "reach" | "views";

export interface SocialPost {
  id: string;
  /** The `social_accounts` row; with `id`, what a tag is put on. */
  accountId: string;
  kind: OrganicKind;
  publishedAt: string;
  mediaType: string | null;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  views: number | null;
  reach: number | null;
  engagement: number | null;
  /** Percent, under `engagementBasis`: this post's platform's choice. */
  engagementRate: number | null;
  engagementBasis: EngagementBasis;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  follows: number | null;
}

export interface OrganicPanel {
  /** Organic kinds with at least one tracked account. */
  kinds: OrganicKind[];
  totals: Compared<OrganicTotals>;
  byKind: { kind: OrganicKind; totals: Compared<OrganicTotals> }[];
  reach: LiveReach;
  /** Null when the range is hourly: figures are stored per day. */
  series: { views: SeriesPoint[]; engagement: SeriesPoint[]; growth: SeriesPoint[]; posts: SeriesPoint[] } | null;
  drivers: SocialDriver[];
  driverSummary: string;
  audience: SocialAudience | null;
  posts: SocialPost[];
  /** True when more posts were published than the table lists. */
  postsCapped: boolean;
  /** Each tracked platform's engagement-rate basis (82), read live, never cached. */
  engagementBases: Partial<Record<OrganicKind, EngagementBasis>>;
  /** The team's own tags (81), read live, never cached. */
  postTags: SocialTag[];
  postTagLinks: SocialTagLink[];
  /** The listed posts' mix and timing (`postActivity`); null in the all-platforms overview. */
  activity: PostActivity | null;
}

export interface PostActivity {
  total: number;
  byType: { key: string; posts: number }[];
  byTag: { id: string; name: string; posts: number }[];
  untagged: number;
  /** Hour 0-23 in the shop's timezone. */
  peakHours: { slot: number; average: number; posts: number }[];
  /** 0 = Monday. */
  peakDays: { slot: number; average: number; posts: number }[];
}

/** A label a person made for posts (« launch », « UGC »…). */
export interface SocialTag {
  id: string;
  name: string;
}

export interface SocialTagLink {
  tagId: string;
  accountId: string;
  postId: string;
}

export interface PaidTotals {
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
}

/** One campaign on the Paid view: the platform's figures, the rates rebuilt, and where it opens. */
export interface PaidCampaign {
  key: string;
  kind: PaidKind;
  accountName: string | null;
  campaignId: string;
  name: string | null;
  status: string | null;
  objective: string | null;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
  /** Ads Manager / Google Ads; null when the ids it needs are missing. */
  url: string | null;
}

export interface PaidPanel {
  kinds: PaidKind[];
  /** The one currency every selected account reports in; null when they differ. */
  currency: string | null;
  /** Per currency when they differ; one entry otherwise. */
  totals: Compared<PaidTotals[]>;
  byKind: { kind: PaidKind; totals: Compared<PaidTotals[]> }[];
  /** Null when currencies differ (no honest sum) or the range is hourly. */
  series: { spend: SeriesPoint[]; revenue: SeriesPoint[]; roas: SeriesPoint[]; conversions: SeriesPoint[] } | null;
  seriesBlockedReason: string | null;
  campaigns: PaidCampaign[];
  /** True when more campaigns delivered than the table lists. */
  campaignsCapped: boolean;
  /** A message key when the campaign cut could not be read. */
  campaignsBlockedReason: string | null;
}

export interface SocialPanel {
  mode: SocialMode;
  network: "all" | SocialKind;
  view: OrganicView;
  connections: SocialConnectionsStatus;
  /** Null in paid mode. */
  organic: OrganicPanel | null;
  /** Null in organic mode. */
  paid: PaidPanel | null;
}

/**
 * The Marketing panel's Paid and Social tabs: the same sums as the Social
 * panel, current range only, no live reach. `connected` false keeps the tab's
 * reason; a total is null when there is nothing honest to sum (no spend, or
 * several currencies).
 */
export interface MarketingSocial {
  paid: { connected: boolean; total: PaidTotals | null; rows: { kind: PaidKind; totals: PaidTotals[] }[] };
  organic: { connected: boolean; total: OrganicTotals | null; rows: { kind: OrganicKind; totals: OrganicTotals }[] };
}
