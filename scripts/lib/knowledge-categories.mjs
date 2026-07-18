const CATEGORY_RULES = [
  ['support', ['contact', 'aide', 'help', 'faq', 'assistance', 'service client', 'questions frequentes']],
  ['shipping_delivery', ['livraison', 'expedition', 'shipping', 'delivery', 'transport', 'colissimo', 'chronopost']],
  ['returns_refunds', ['retour', 'remboursement', 'refund', 'return', 'retractation', 'echange']],
  ['privacy', ['confidentialite', 'privacy', 'donnees', 'personnelles', 'cookies', 'rgpd', 'gdpr']],
  ['product_advice', ['ingredient', 'composition', 'actif', 'actifs', 'conseil', 'utilisation', 'routine', 'peau']],
  ['brand_story', ['marque', 'histoire', 'heritage', 'hanbang', 'rituel qi']],
  ['legal', ['conditions generales', 'cgv', 'terms', 'legal', 'mentions legales', 'vente']],
  ['payments', ['paiement', 'payment', 'facture', 'billing']]
];

const PRIMARY_CATEGORY_RULES = [
  ['support', ['contact', 'faq', 'questions frequentes']],
  ['product_advice', ['ingredient', 'ingredients', 'composition', 'actif', 'actifs']],
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
