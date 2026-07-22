const CATEGORY_RULES = [
  ['faq', ['faq', 'questions frequentes', 'contact', 'aide', 'help', 'assistance', 'service client']],
  ['shipping_delivery', ['livraison', 'expedition', 'shipping', 'delivery', 'transport', 'colissimo', 'chronopost']],
  ['returns_refunds', ['retour', 'remboursement', 'refund', 'return', 'retractation', 'echange']],
  ['privacy', ['confidentialite', 'privacy', 'donnees', 'personnelles', 'cookies', 'rgpd', 'gdpr']],
  ['product_information', ['ingredient', 'composition', 'actif', 'actifs', 'conseil', 'utilisation', 'routine', 'peau']],
  ['brand_story', ['marque', 'histoire', 'heritage', 'hanbang', 'rituel qi']],
  ['legal', ['conditions generales', 'cgv', 'terms', 'legal', 'mentions legales', 'vente']],
  ['payments', ['paiement', 'payment', 'facture', 'billing']],
  ['promotions', ['promotion', 'promotions', 'soldes', 'remise', 'code promo', 'offre']],
  ['b2b_partnerships', ['b2b', 'partenariat', 'partenaire', 'revendeur', 'wholesale', 'grossiste']],
  ['stock', ['stock', 'rupture', 'disponibilite', 'reappro', 'inventory']]
];

const PRIMARY_CATEGORY_RULES = [
  ['faq', ['faq', 'questions frequentes', 'contact']],
  ['product_information', ['ingredient', 'ingredients', 'composition', 'actif', 'actifs']],
  ['brand_story', ['marque', 'histoire', 'heritage', 'hanbang', 'rituel qi']]
];

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

  return 'general';
}

function normalize(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
