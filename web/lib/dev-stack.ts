/**
 * The app's architecture and paid services, as drawn on Settings → Dev info.
 *
 * Hand-kept data, not read from anywhere: when a service is added, moved or
 * its plan changes, edit this file. `plan` and `monthly` stay null until
 * someone records the real figure — the page shows "—", never a guess.
 * Words that translate live under `settings.dev.*`; product names do not.
 */

export type StackStatus = "live" | "partial" | "planned";

/** Columns of the diagram, left to right. Words: `settings.dev.lane.<id>`. */
export type StackLane = "people" | "app" | "data" | "services";

export interface StackLink {
  to: string;
  /** Defaults to the node's own status. */
  status?: StackStatus;
  /** Short tag on the link — a protocol or a job, never a sentence. */
  via?: string;
}

export interface StackNode {
  id: string;
  /** A product name; null for people, whose name is `settings.dev.name.<id>`. */
  name: string | null;
  lane: StackLane;
  /** `settings.dev.role.<role>` — what it does here, in two or three words. */
  role: string;
  status: StackStatus;
  tech: string[];
  host?: string;
  links?: StackLink[];
}

export interface Subscription {
  /** A `StackNode` id, so the table and the diagram agree on the name. */
  node: string;
  /** `settings.dev.billing.<billing>`. */
  billing: "usage" | "flat" | "free" | "shop";
  plan: string | null;
  /** Monthly cost as the invoice states it, e.g. "€20". */
  monthly: string | null;
}

export const LANES: StackLane[] = ["people", "app", "data", "services"];

export const STACK: StackNode[] = [
  { id: "team", name: null, lane: "people", role: "team", status: "live", tech: ["Browser"], links: [{ to: "vercel", via: "HTTPS" }] },
  { id: "customers", name: null, lane: "people", role: "customers", status: "live", tech: ["Email", "Contact form"], links: [{ to: "m365", via: "Email" }] },

  {
    id: "vercel",
    name: "Vercel",
    lane: "app",
    role: "dashboard",
    status: "live",
    tech: ["Next.js 14", "React 18", "TypeScript"],
    host: "qiriness-ap.vercel.app",
    links: [
      { to: "supabase", via: "SQL" },
      { to: "openai", via: "Chat" },
      { to: "shopify", via: "ShopifyQL" },
      { to: "klaviyo", via: "Key check" },
    ],
  },
  {
    id: "render",
    name: "Render",
    lane: "app",
    role: "worker",
    status: "live",
    tech: ["Node.js", "Poll loop"],
    links: [
      { to: "supabase", via: "SQL" },
      { to: "m365", via: "Graph" },
      { to: "openai", via: "LLM" },
    ],
  },
  {
    id: "github",
    name: "GitHub Actions",
    lane: "app",
    role: "nightly",
    status: "live",
    tech: ["Cron 02:00 UTC", "Repo"],
    links: [
      { to: "shopify", via: "Admin API" },
      { to: "klaviyo", via: "REST" },
      { to: "supabase", via: "Upsert" },
    ],
  },

  { id: "supabase", name: "Supabase", lane: "data", role: "database", status: "live", tech: ["PostgreSQL", "pgvector", "Vault"] },

  {
    id: "shopify",
    name: "Shopify",
    lane: "services",
    role: "shop",
    status: "live",
    tech: ["Admin API", "ShopifyQL", "Webhooks"],
    links: [{ to: "vercel", via: "Webhooks", status: "planned" }],
  },
  { id: "m365", name: "Microsoft 365", lane: "services", role: "mailbox", status: "live", tech: ["Outlook", "Graph API", "Entra app"] },
  { id: "openai", name: "OpenAI", lane: "services", role: "llm", status: "live", tech: ["LLM", "Embeddings"] },
  { id: "klaviyo", name: "Klaviyo", lane: "services", role: "marketing", status: "live", tech: ["Flows", "Campaigns"] },
  { id: "deret", name: "DERET", lane: "services", role: "delivery", status: "planned", tech: ["Delivery API"] },
];

export const SUBSCRIPTIONS: Subscription[] = [
  { node: "vercel", billing: "flat", plan: null, monthly: null },
  { node: "render", billing: "flat", plan: null, monthly: null },
  { node: "supabase", billing: "flat", plan: null, monthly: null },
  { node: "openai", billing: "usage", plan: null, monthly: null },
  { node: "github", billing: "free", plan: null, monthly: null },
  { node: "shopify", billing: "shop", plan: null, monthly: null },
  { node: "m365", billing: "shop", plan: null, monthly: null },
  { node: "klaviyo", billing: "shop", plan: null, monthly: null },
];
