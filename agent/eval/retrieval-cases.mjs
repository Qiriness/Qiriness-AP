// Labelled review set for RETRIEVAL — the counterpart to categorisation-cases.mjs.
//
// Each case is a customer question plus what a human says should come back. The
// phrasings are modelled on the real recurring topics the clustering report
// found (delivery "je n'ai toujours pas reçu" at 27 messages, the newsletter
// welcome code at 20, product-quality problems at 15), rewritten here as dummy
// data — never a real customer email, per AGENTS.md.
//
// LABELLED AT DOCUMENT LEVEL, NOT CHUNK ID. Chunks are regenerated with new ids
// every time a document is re-imported or the chunker changes, so a chunk-id
// label would rot silently and start reporting misses that are really renames.
// Documents are stable: they are keyed to a Shopify source.
//
// Each case:
//   expectDocuments - the document title(s) that answer this. Empty + expectNone
//                     for questions the library genuinely cannot answer.
//   accept          - documents a human would also accept. Real questions have
//                     more than one defensible source, and scoring without this
//                     measures agreement with one arbitrary reading.
//   expectNone      - TRUE when the correct behaviour is to return nothing.
//   expectBand      - answerable | weak | none, for checking the thresholds.
//   entities        - what an extractor should pull out. Scored separately.
//   note            - what the case tests, so a regression is diagnosable.
//
// EXPECT-NONE CASES ARE NOT PADDING. Withholding is a design goal: below the
// answerable band chunks never reach the case file. A retriever that returns
// three chunks for everything scores perfectly on recall and is useless, and
// only these cases and precision catch it.

export const CASES = [
  // --- returns and refunds -------------------------------------------------
  {
    id: 'return-window',
    subject: 'Délai pour retourner un article',
    body: "Bonjour, j'ai reçu ma commande la semaine dernière et le produit ne me convient pas. Combien de temps ai-je pour le renvoyer ?",
    category: 'return_exchange',
    expectDocuments: ['Refund policy'],
    accept: ['Terms of sale', 'Livraisons et retours'],
    expectBand: 'answerable',
    entities: {},
    note: 'the plainest possible policy question. If this does not retrieve, nothing will.'
  },
  {
    id: 'withdrawal-14-days',
    subject: 'Droit de rétractation',
    body: "Je souhaite annuler mon achat. Je crois qu'il existe un délai de rétractation de 14 jours dans l'Union européenne, est-ce que cela s'applique ?",
    category: 'return_exchange',
    expectDocuments: ['Refund policy'],
    accept: ['Terms of sale', 'Conditions générales de ventes'],
    expectBand: 'answerable',
    entities: {},
    note: 'the phrasing sits in a SECOND chunk of the same document — tests that chunking did not bury it.'
  },
  {
    id: 'refund-timing',
    subject: 'Remboursement pas reçu',
    body: "Mon retour a été accepté il y a deux semaines mais je n'ai toujours pas vu le remboursement sur mon compte. Sous quel délai arrive-t-il ?",
    category: 'return_exchange',
    expectDocuments: ['Refund policy'],
    accept: ['Terms of sale'],
    expectBand: 'answerable',
    entities: {},
    note: 'a PROBLEM rather than a question, but the answer is still the policy.'
  },

  // --- delivery ------------------------------------------------------------
  {
    id: 'delivery-times',
    subject: 'Délais de livraison',
    body: 'Bonjour, sous combien de jours la commande est-elle expédiée et livrée en France métropolitaine ?',
    category: 'delivery',
    expectDocuments: ['Shipping'],
    accept: ['Livraisons et retours', 'FAQ'],
    expectBand: 'answerable',
    entities: {},
    note: 'the shipping policy, which is a policy rather than a page.'
  },
  {
    id: 'parcel-not-arrived',
    subject: "Je n'ai toujours pas reçu ma commande",
    body: "Bonjour, ma commande #4854 a été expédiée il y a douze jours et le suivi n'a pas bougé. Je n'ai toujours rien reçu.",
    category: 'delivery',
    expectDocuments: [],
    expectNone: true,
    expectBand: 'none',
    entities: { orderNumbers: ['4854'] },
    note: 'THE largest cluster in the inbox (27 messages) and the knowledge library cannot answer it — the answer is THIS parcel, from the order tools. Retrieval must stay quiet and let the entity route it.'
  },

  // --- promotions ----------------------------------------------------------
  {
    id: 'welcome-code-not-working',
    subject: 'Mon code ne fonctionne pas',
    body: "J'ai reçu le code BIENVENUE pour l'inscription à la newsletter mais il est refusé au moment de payer.",
    category: 'promotions',
    expectDocuments: [],
    expectNone: true,
    expectBand: 'none',
    entities: { codes: ['BIENVENUE'] },
    note: 'the single biggest cluster (20 messages). Answered by the promotion tool from the customer record, never by an article.'
  },
  {
    id: 'code-on-wrong-product',
    subject: 'Code de réduction',
    body: "J'ai essayé d'utiliser UKLED20 sur ma crème mais ça ne marche pas. Pourquoi ?",
    category: 'promotions',
    expectDocuments: [],
    expectNone: true,
    expectBand: 'none',
    entities: { codes: ['UKLED20'] },
    note: 'the answer is the code\'s product restriction — a structured lookup. Tests that a code is extracted exactly, not as a substring.'
  },

  // --- product -------------------------------------------------------------
  {
    id: 'led-mask-sensitive-skin',
    subject: 'Masque LED et peaux sensibles',
    body: 'Bonjour, votre masque LED convient-il aux peaux sensibles ? Je fais souvent des réactions.',
    category: 'product',
    expectDocuments: [],
    expectNone: true,
    expectBand: 'none',
    entities: { products: ['masque LED'] },
    note: 'answered from the PRODUCT row (usage instructions, ingredients), not the knowledge library. 29 level-1 product tickets look like this.'
  },
  {
    id: 'coffret-ambiguous',
    subject: 'Question sur le coffret',
    body: "Je voudrais des informations sur le coffret Caresse Temps Sublime, notamment sa composition.",
    category: 'product',
    expectDocuments: [],
    expectNone: true,
    expectBand: 'none',
    entities: { products: ['coffret Caresse Temps Sublime'] },
    note: 'genuinely names two products. The product matcher must return BOTH as ambiguous rather than silently picking one.'
  },

  // --- account -------------------------------------------------------------
  {
    id: 'cannot-log-in',
    subject: 'Problème de connexion',
    body: "Je n'arrive pas à me connecter à mon compte, le mot de passe est refusé.",
    category: 'account',
    expectDocuments: ['FAQ'],
    accept: ['Privacy policy'],
    expectBand: 'weak',
    entities: {},
    note: 'measured at 0.62 against the password-reset FAQ on the old library — the case that justifies searching `faq` alongside the subject.'
  },
  {
    id: 'how-many-orders',
    subject: 'Historique de commandes',
    body: "Bonjour, combien de commandes ai-je passées chez vous depuis l'année dernière ?",
    category: 'account',
    expectDocuments: [],
    expectNone: true,
    expectBand: 'none',
    entities: {},
    note: 'no article can answer this — it is the CRM lookup. No entity either, so the router must fall back on the category alone.'
  },

  // --- multi-intent --------------------------------------------------------
  {
    id: 'two-questions-at-once',
    subject: 'Deux questions',
    body: "Bonjour, est-ce que le masque LED convient aux peaux sensibles ? Et par ailleurs ma commande #6216 n'est jamais arrivée.",
    category: 'product',
    expectDocuments: [],
    expectNone: true,
    expectBand: 'none',
    entities: { products: ['masque LED'], orderNumbers: ['6216'] },
    note: 'TWO intents with two different retrieval paths. Today one blended vector matches neither; this is the case multi-query rewriting exists to fix, and the entity labels are what a rewriter should produce.'
  },

  // --- brand knowledge ------------------------------------------------------
  {
    id: 'brand-hanbang',
    subject: 'Question sur votre approche',
    body: "Bonjour, j'ai lu que vos soins s'inspiraient du Hanbang. Pouvez-vous m'expliquer ce que c'est et ce qui rend votre marque différente ?",
    category: 'other',
    expectDocuments: ['Inspiration Hanbang'],
    accept: ['La Marque', 'Le Rituel Qi'],
    expectBand: 'answerable',
    entities: {},
    note: 'brand_story articles ARE knowledge — this is a real customer question. Excluded from search only because the original rule conflated the brand_story CATEGORY with the brand-voice CORE TOPIC, which now has its own mechanism.'
  },

  // --- the traps -----------------------------------------------------------
  {
    id: 'erp-reference-not-an-order',
    subject: 'Référence Q00',
    body: "Bonjour, concernant la référence Q00 26200111, pouvez-vous me dire où elle en est ?",
    category: 'order',
    expectDocuments: [],
    expectNone: true,
    expectBand: 'none',
    entities: { orderNumbers: [] },
    note: '911 of these in the corpus. An internal ERP reference that will NEVER match an order — extracting it as an order number is worse than extracting nothing.'
  },
  {
    id: 'bare-number-is-not-an-order',
    subject: 'Commande de mai',
    body: "J'ai commandé le 17 mai, le montant de 89,50 euros a été débité mais je n'ai rien reçu.",
    category: 'order',
    expectDocuments: [],
    expectNone: true,
    expectBand: 'none',
    entities: { orderNumbers: [] },
    note: 'French support mail is full of dates, postcodes and prices. A parser that grabs bare numbers would read 17, 89 or 50 as an order.'
  },
  {
    id: 'off-topic',
    subject: 'Partenariat influence',
    body: "Bonjour, je suis créatrice de contenu et je souhaiterais collaborer avec votre marque sur Instagram.",
    category: 'partner_collaboration',
    expectDocuments: [],
    expectNone: true,
    expectBand: 'none',
    entities: {},
    note: 'nothing in a support library answers this, and it is forwarded rather than answered. Pure restraint check.'
  }
];
