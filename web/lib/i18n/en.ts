/** The source dictionary: it owns the keys. `fr.ts` must define every one. */
import { en as shared } from "./messages/shared";
import { en as tickets } from "./messages/tickets";
import { en as insights } from "./messages/insights";
import { en as setup } from "./messages/setup";
import { en as pages } from "./messages/pages";

export const en = {
  "common.language": "Language",
  "common.signOut": "Sign out",
  "common.signingOut": "Signing out…",
  "nav.home": "Home",
  "nav.insights": "Insights",
  "nav.tickets": "Tickets",
  "nav.orders": "Orders",
  "nav.agentSetup": "Agent Setup",
  "nav.conversations": "Conversations",
  "nav.settings": "Settings",
  "nav.primary": "Primary",
  "nav.beta": "Beta",
  "nav.soon": "Soon",
  "nav.availableSoon": "Available soon",
  "nav.collapse": "Collapse",
  "nav.openStore": "Open the Qiriness store",
  "nav.shopifyStore": "Shopify store",
  "nav.closeNavigation": "Close navigation",
  "nav.openNavigation": "Open navigation",
  "nav.help": "Help",
  "nav.loading": "Loading {label}…",
  "badge.tickets_one": "{count} ticket still open",
  "badge.tickets_other": "{count} tickets still open",
  "badge.conversations_one": "{count} conversation still open",
  "badge.conversations_other": "{count} conversations still open",
  "badge.orders_one": "{count} order waiting to ship",
  "badge.orders_other": "{count} orders waiting to ship",
  "lang.fr": "Français",
  "lang.en": "English",
  "lang.switching": "Changing language…",
  "lang.switchFailed": "Could not save the language.",
  ...shared,
  ...tickets,
  ...insights,
  ...setup,
  ...pages,
} as const;

export type MessageKey = keyof typeof en;
