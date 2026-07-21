import type { AgentContext, Article, ShopifyPage } from "./types";

/**
 * Static demo data for the first Agent Setup implementation.
 *
 * DATA BOUNDARY: dummy content only. No real customer personal data. Shopify
 * pages are represented as illustrative titles/handles until backend APIs exist.
 */

export const SHOPIFY_PAGES: ShopifyPage[] = [
  { id: "page-refund", title: "Refund Policy", handle: "/policies/refund-policy" },
  { id: "page-shipping", title: "Shipping Policy", handle: "/policies/shipping-policy" },
  { id: "page-faq", title: "FAQ", handle: "/pages/faq" },
  { id: "page-about", title: "Notre histoire", handle: "/pages/notre-histoire" },
  { id: "page-contact", title: "Contact", handle: "/pages/contact" },
  { id: "page-returns", title: "Returns & Exchanges", handle: "/pages/returns" },
];

export const DEMO_ARTICLES: Article[] = [
  {
    id: "art-brand-voice",
    title: "Brand voice",
    status: "approved",
    category: "brand_story",
    sourcePageId: null,
    syncState: "none",
    updatedLabel: "4h ago",
    content: `<p>Qiriness writes the way a trusted skincare advisor speaks: warm, precise, and never pushy. Replies should feel personal and calm, even when resolving a problem.</p>
<p><strong>Principles</strong></p>
<ul>
<li>Lead with empathy, then give a clear next step.</li>
<li>Use plain language. Explain actives and routines without jargon.</li>
<li>Stay honest about what a product can and cannot do.</li>
<li>Match the customer's language (French or English) and keep sentences short.</li>
</ul>
<p>Avoid superlatives, pressure, and medical claims. When unsure, offer to connect the customer with the care team.</p>`,
  },
  {
    id: "art-refund",
    title: "Refund policy",
    status: "approved",
    category: "returns_refunds",
    sourcePageId: "page-refund",
    syncState: "synced",
    updatedLabel: "2h ago",
    lastSyncedLabel: "2h ago",
    content: `<p>We want you to love every Qiriness product you order. If something isn't right, we're here to help.</p>
<p>You may request a refund within <strong>30 days of delivery</strong>. Items must be unused, in their original condition, and returned in the original packaging.</p>
<ul>
<li>Start a return from your account, or reply to the confirmation email.</li>
<li>Once we receive and inspect your return, we issue the refund to the original payment method.</li>
<li>Shipping fees are non-refundable unless the return is due to our error.</li>
</ul>
<p>Please allow up to 5 business days for the refund to appear after it has been processed.</p>`,
  },
  {
    id: "art-faq",
    title: "FAQ",
    status: "approved",
    category: "support",
    sourcePageId: "page-faq",
    syncState: "synced",
    updatedLabel: "1d ago",
    lastSyncedLabel: "1d ago",
    content: `<p>Short, reliable answers to the questions customers ask most often.</p>
<p><strong>How do I choose the right routine?</strong></p>
<p>Share your skin type and main concern and we'll suggest a simple morning and evening routine.</p>
<p><strong>Are the products suitable for sensitive skin?</strong></p>
<p>Most formulas are fragrance-light and dermatologically tested. Always patch test a new active.</p>`,
  },
  {
    id: "art-shipping",
    title: "Shipping policy",
    status: "in_review",
    category: "shipping_delivery",
    sourcePageId: "page-shipping",
    syncState: "synced",
    updatedLabel: "3d ago",
    lastSyncedLabel: "3d ago",
    content: `<p>Orders are prepared within 1–2 business days. Standard delivery in France takes 2–4 business days; Europe 4–7 business days.</p>
<ul>
<li>Free standard shipping over €49.</li>
<li>Tracking is sent by email as soon as the parcel leaves our warehouse.</li>
</ul>
<p>This draft still needs the updated carrier cut-off times before approval.</p>`,
  },
  {
    id: "art-brand-history",
    title: "Brand history",
    status: "needs_optimization",
    category: "brand_story",
    sourcePageId: "page-about",
    syncState: "error",
    updatedLabel: "5d ago",
    content: `<p>Qiriness was founded in Paris around a simple idea: effective skincare should feel like a moment of calm, not a chore.</p>
<p>This article was imported from the Shopify page but the sync did not complete. Retry the import, then optimize the copy for the agent's tone.</p>`,
  },
];

export const DEMO_CONTEXT: AgentContext = {
  brandVoiceArticleId: "art-brand-voice",
  tone: ["Warm", "Precise", "Helpful"],
};

export const TEAM_MEMBER = {
  name: "Support team",
  initials: "QS",
  store: "Qiriness",
};
