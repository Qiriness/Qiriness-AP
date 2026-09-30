import type { MessageKey } from "./en";

import { fr as shared } from "./messages/shared";
import { fr as tickets } from "./messages/tickets";
import { fr as insights } from "./messages/insights";
import { fr as setup } from "./messages/setup";
import { fr as pages } from "./messages/pages";

/** Typed against `en.ts`: a missing key fails `tsc`. */
export const fr: Record<MessageKey, string> = {
  "common.language": "Langue",
  "common.signOut": "Se déconnecter",
  "common.signingOut": "Déconnexion…",
  "nav.home": "Accueil",
  "nav.insights": "Analyses",
  "nav.tickets": "Tickets",
  "nav.orders": "Commandes",
  "nav.agentSetup": "Config Agent",
  "nav.conversations": "Conversations",
  "nav.settings": "Paramètres",
  "nav.primary": "Principale",
  "nav.beta": "Bêta",
  "nav.soon": "Bientôt",
  "nav.availableSoon": "Bientôt disponible",
  "nav.collapse": "Réduire",
  "nav.openStore": "Ouvrir la boutique Qiriness",
  "nav.shopifyStore": "Boutique Shopify",
  "nav.closeNavigation": "Fermer la navigation",
  "nav.openNavigation": "Ouvrir la navigation",
  "nav.help": "Aide",
  "nav.loading": "Chargement de {label}…",
  "badge.tickets_one": "{count} ticket encore ouvert",
  "badge.tickets_other": "{count} tickets encore ouverts",
  "badge.conversations_one": "{count} conversation encore ouverte",
  "badge.conversations_other": "{count} conversations encore ouvertes",
  "badge.orders_one": "{count} commande en attente d'expédition",
  "badge.orders_other": "{count} commandes en attente d'expédition",
  "lang.fr": "Français",
  "lang.en": "English",
  "lang.switching": "Changement de langue…",
  "lang.switchFailed": "Impossible d'enregistrer la langue.",
  ...shared,
  ...tickets,
  ...insights,
  ...setup,
  ...pages,
};
