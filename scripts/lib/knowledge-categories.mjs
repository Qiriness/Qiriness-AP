import { KNOWLEDGE_CATEGORIES } from './support-taxonomy.mjs';

// Loose category inference for imported Shopify pages and policies. The vocabulary
// itself lives in support-taxonomy.mjs (shared with the ticket categoriser); this
// module only maps French/English page text onto it.
//
// Rule order matters — first match wins — so narrower categories are listed before
// the broader ones they would otherwise be swallowed by.

const CATEGORY_RULES = [
  ['cosmetovigilance', ['cosmetovigilance', 'effet indesirable', 'reaction allergique', 'allergie', 'irritation', 'intolerance']],
  ['product_stock', ['stock', 'rupture', 'disponibilite', 'reappro', 'inventory', 'epuise']],
  ['return_exchange', ['retour', 'remboursement', 'refund', 'return', 'retractation', 'echange', 'exchange']],
  ['delivery', ['livraison', 'expedition', 'shipping', 'delivery', 'transport', 'colissimo', 'chronopost', 'suivi de colis']],
  ['order', ['commande', 'order', 'numero de commande', 'suivi de commande', 'panier']],
  ['payment', ['paiement', 'payment', 'facture', 'billing', 'carte bancaire', 'moyens de paiement']],
  ['account', ['compte', 'account', 'mot de passe', 'password', 'connexion', 'login', 'inscription', 'desabonnement']],
  ['promotions', ['promotion', 'promotions', 'soldes', 'remise', 'code promo', 'offre', 'parrainage']],
  ['legal_privacy', ['confidentialite', 'privacy', 'donnees personnelles', 'donnees', 'personnelles', 'cookies', 'rgpd', 'gdpr', 'conditions generales', 'cgv', 'terms', 'legal', 'mentions legales', 'vente']],
  ['b2b', ['b2b', 'revendeur', 'wholesale', 'grossiste', 'professionnel', 'pharmacie', 'institut']],
  ['partner_collaboration', ['partenariat', 'partenaire', 'collaboration', 'influenceur', 'influenceuse', 'ambassadeur', 'ugc', 'affiliation']],
  ['careers', ['recrutement', 'carriere', 'carrieres', 'emploi', 'candidature', 'stage', 'alternance', 'nous rejoindre']],
  ['product', ['ingredient', 'composition', 'actif', 'actifs', 'conseil', 'utilisation', 'routine', 'peau', 'produit']],
  ['faq', ['faq', 'questions frequentes', 'contact', 'aide', 'help', 'assistance', 'service client']],
  ['brand_story', ['marque', 'histoire', 'heritage', 'hanbang', 'rituel qi', 'a propos']]
];

// Checked against the title + handle only (not the body), so a page *named* for a
// topic wins over a body that merely mentions other ones in passing.
const PRIMARY_CATEGORY_RULES = [
  ['faq', ['faq', 'questions frequentes', 'contact']],
  ['cosmetovigilance', ['cosmetovigilance', 'effet indesirable']],
  ['careers', ['recrutement', 'carriere', 'emploi', 'nous rejoindre']],
  ['product', ['ingredient', 'ingredients', 'composition', 'actif', 'actifs']],
  ['brand_story', ['marque', 'histoire', 'heritage', 'hanbang', 'rituel qi', 'a propos']]
];

export { KNOWLEDGE_CATEGORIES };

/** Fallback when nothing matches. Also the taxonomy's catch-all subject. */
export const FALLBACK_CATEGORY = 'other';

export function inferKnowledgeCategory(...values) {
  const primary = normalize(values.slice(0, 2).filter(Boolean).join(' '));
  for (const [category, terms] of PRIMARY_CATEGORY_RULES) {
    if (terms.some((term) => primary.includes(normalize(term)))) {
      return category;
    }
  }

  const haystack = normalize(values.filter(Boolean).join(' '));

  for (const [category, terms] of CATEGORY_RULES) {
    if (terms.some((term) => haystack.includes(normalize(term)))) {
      return category;
    }
  }

  return FALLBACK_CATEGORY;
}

function normalize(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
