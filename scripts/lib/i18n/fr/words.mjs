/**
 * French: the chat's vocabulary beyond the skin (lexicon.mjs). Each entry is read by one module,
 * named beside it, together with the same entry of every other language (languages.mjs).
 *
 * Two kinds of text:
 *   - RAW: the message as typed, matched case-insensitively (accents and apostrophes as typed).
 *   - NORM: lower case, no accents, apostrophes and hyphens as spaces (« l autre », « celui ci »).
 * Strings in arrays are regex fragments unless the entry says « words » (matched whole).
 */
export default {
  code: 'fr',

  /** routine-flow.mjs: answers to the routine offer and the cart question. RAW, at the start of the message. */
  turns: {
    yes: ['oui', 'ouais', 'volontiers', 'avec plaisir', "d'accord", 'ok(ay)?', 'bien s[uû]r', 'carr[ée]ment', 'go'],
    no: ['non', 'nan', "pas (maintenant|pour l'instant|besoin)", 'sans fa[cç]on'],
    /** Words that, anywhere after a yes, cancel it (« oui mais pas maintenant »). */
    negation: ['pas', 'non'],
    /** « Je cherche encore »: not now (the cart question's « no »). Anywhere in the message. */
    stillLooking: ['je cherche encore', 'je regarde encore', 'pas encore', 'plus tard', 'je reflechis', 'je réfléchis'],
    /** « Ajouter svp » under the cart question is a yes (owner, 2026-10-29). At the start. */
    cartYes: ['ajout\\w*', 'rajout\\w*', 'mets[- ]?(le|la|les)?', 'mettez[- ]?(le|la|les)?', 'vas[- ]y', 'allez[- ]y', 'je (le|la|les) prends'],
    /** Asking to add something (owner, 2026-10-29). Anywhere. */
    addRequest: ['\\b(ajout\\w*|rajout\\w*|mets|mettez|mettre|placez)\\b[^.?!]{0,60}\\bpanier\\b', '\\bje (le|la|les) prends\\b'],
    /** Not adding, or taking out. Anywhere. */
    notAdd: ["ne (l'|l’|le |la |les )?(ajout|mett)\\w* pas", 'pas (au|dans mon|dans le) panier', 'retir\\w*', 'enlev\\w*', 'supprim\\w*'],
  },

  /** llm-agent.mjs: a reply that sends them to customer service. RAW. */
  contact: ['service (?:client|clientèle|consommateurs?)', 'nous contacter', 'contactez[- ]nous', 'formulaire de contact', 'notre équipe'],
  /** llm-agent.mjs: a reply that sends them to a health professional (owner's notes v4). NORM. */
  professional: ['medecins?', 'dermatolog\\w*', 'pharmacien\\w*', 'professionnel de sante', 'allergolog\\w*'],
  /** llm-agent.mjs: a message about an order (owner's notes v4: « livré mais pas reçu »). NORM. */
  order: ['commandes?', 'commande', 'colis', 'livr\\w*', 'recu', 'recue', 'recus', 'manquants?', 'rembours\\w*', 'echange\\w*', 'retour\\w*', 'suivi', 'produit (different|errone|abime|casse)'],
  /** llm-agent.mjs: the message already gives its order number. NORM. */
  orderNumber: ['numero de (la )?commande'],
  /** llm-agent.mjs: the model asks the concern itself (« l'une de ces préoccupations ? »). NORM. */
  concernAsk: ['preoccup\\w*', 'priorit\\w*', 'soucis?', 'l une de ces', 'parmi ces', 'cibler', 'traiter', 'ameliorer', 'attenuer', 'travailler'],
  /** llm-agent.mjs: « montrez-le-moi », « le lien ». RAW. */
  asksToSee: ['montre[rz]?', 'voir', 'revoir', 'affiche[rz]?', 'lien', 'fiche'],

  /** purchase-turn.mjs: the customer talks about what they bought before. RAW. */
  pastPurchase: [
    "(?:j'|j’|je )ai (?:déjà )?(?:acheté|commandé|pris)",
    'mes (?:derniers? |précédents? )?(?:achats?|commandes?)',
    'ma (?:dernière |précédente )?commande',
    'la dernière fois',
    'racheter|recommander|reprendre (?:le|la|les|mon|ma|mes)',
    'mes produits',
  ],

  /** conversation-language.mjs: a whole message that is no language switch (« oui », « merci »). RAW. */
  neutral: ['oui', 'non', 'merci'],

  /** conversation-refs.mjs: what a customer points at without naming it. NORM, whole words unless said. */
  refs: {
    /** Grammar never typo-corrected into a product word (« trois » is not « trio »). */
    grammar: ['deux', 'troi', 'trois', 'quatre', 'premier', 'premiere', 'second', 'seconde', 'deuxieme', 'troisieme', 'dernier', 'derniere', 'autre', 'autres', 'celui', 'celle', 'ceux', 'celle', 'cela', 'matin', 'soir'],
    /** Articles, possessives, demonstratives: the next word is a named thing. */
    anchors: ['le', 'la', 'l', 'les', 'du', 'au', 'aux', 'mon', 'ma', 'me', 'votre', 'vos', 'notre', 'ce', 'cet', 'cette'],
    definite: ['le', 'la', 'l', 'les'],
    /** Short function words never part of a product name. */
    stopwords: ['de', 'des', 'du', 'et', 'ou', 'a', 'au', 'aux', 'en', 'pour', 'par', 'avec', 'sans', 'sur', 'dans', 'qui', 'que', 'est', 'il', 'elle', 'ne', 'pas', 'plus', 'tres', 'bien'],
    /** Everyday words never typo-corrected (« vous » is not « doux »; « moins » is one letter from « mains »). */
    common: ['moins', 'moin', 'plus', 'vous', 'avez', 'nous', 'leur', 'leurs', 'elles', 'mais', 'donc', 'alors', 'aussi', 'comme', 'quand', 'faire', 'peux', 'peut', 'veux', 'sont', 'etre', 'avoir', 'cette'],
    indefinite: ['un', 'une', 'de', 'des', 'quelque'],
    /** Between two product mentions (RAW, surrounded by spaces). */
    separators: ['et', 'ou', 'avec', 'versus', 'vs', 'contre', 'puis', 'ainsi que'],
    /** « quels sérums avez-vous », « une crème pour peau sèche » (fragments). */
    discovery: ['quel', 'quels', 'quelle', 'quelles', 'avez vous', 'auriez vous', 'vous avez', 'conseillez', 'recommandez', 'proposez', 'cherche (un|une|des)', 'un produit', 'une creme', 'un serum', 'un soin', 'une routine', 'pour (une|les|ma|mon) peau', 'pour peau', 'vos produits'],
    /** « les deux », « tous les trois » (fragments): before a number. */
    pluralPrefixes: ['tous les ', 'toutes les ', 'les '],
    /** The numbers after them, and how many each means. Digits are any language's. */
    counts: { deux: 2, 2: 2, trois: 3, 3: 3, quatre: 4, 4: 4 },
    /** A whole phrase meaning a number (« both »). */
    pluralAlone: {},
    recommendedCue: ['conseill\\w*', 'recommand\\w*', 'propos\\w*', 'suggere\\w*'],
    other: ['l autre'],
    /** « le premier », « la dernière » (fragments, with their article). */
    ordinals: {
      first: ['(le |la )?(premier|premiere)'],
      second: ['(le |la )?(second|seconde|deuxieme)'],
      third: ['(le |la )?(troisieme)'],
      last: ['(le |la )?(dernier|derniere)'],
    },
    /** « est-elle recommandée ? »: the subject pronoun after its verb is the product just discussed. */
    inverted: ['(est|sont|convient|conviennent|conviendrait|contient|marche|fonctionne|dure|coute|sent|existe|reste|peut|va|irait|serait|a t|existe t|convient t|faut) (elle|il|elles|ils)'],
    this: ['celui ci', 'celle ci', 'celui la', 'celle la', 'ce produit', 'ce soin', 'cet article', 'ca', 'cela'],
    /** Demonstratives before a care word (« cette crème »). */
    demonstratives: ['ce', 'cet', 'cette', 'ces'],
  },

  /**
   * conversation-refs.mjs: everyday words for care types and areas, NORM. The same key in every
   * language is the same thing (« crème » = "cream"): a customer's word becomes the catalogue's own.
   */
  equivalents: {
    cream: ['creme'], mask: ['masque', 'masques'], toner: ['lotion'], gift_set: ['coffret'], oil: ['huile'], milk: ['lait'],
    balm: ['baume'], scrub: ['gommage'], cleanser: ['nettoyant'], makeup_remover: ['demaquillant'], mist: ['brume'],
    water: ['eau'], foam: ['mousse'], patches: ['patchs'], night: ['nuit'], day: ['jour'], eyes: ['yeux'], lips: ['levres'],
    hands: ['mains'], body: ['corps'], face: ['visage'], range: ['gamme'], orange_blossom: ['fleur d oranger'], rose_quartz: ['quartz rose'],
  },

  /** product-resolver.mjs: « cette crème » on a product page is that product. NORM. */
  demonstrativeCare: ['(?:cette|cet|ce) (?:creme|serum|soin|produit|masque|lotion|baume|gel|lait|huile|contour|fluide|nettoyant|elixir|coffret)'],

  /** product-tools.mjs: words with no product meaning in a search (whole words). */
  searchStopwords: ['les', 'des', 'une', 'pour', 'avec', 'sans', 'dans', 'sur', 'par', 'est', 'que', 'qui', 'mon', 'mes', 'votre', 'vos', 'peau', 'soin', 'soins', 'produit', 'produits'],
  /** faq-matcher.mjs: words that say nothing about an FAQ (whole words). */
  faqStopwords: 'a au aux avec ce cet cette ces ca de des du en et est il elle ils elles je le la les leur ma mes mon ne nous on ou par pas pour puis puisje peux peut quel quelle quels quelles que qui se ses si son sont sur un une vous votre vos comment combien dois doisje faut faire produit produits soin soins'.split(' '),

  /** knowledge-topics.mjs: the policy topics a question is about (whole words, near-typos allowed). NORM. */
  topics: {
    delivery: ['livraison', 'livrer', 'livre', 'livrez', 'expedition', 'expedier'],
    returns: ['retour', 'retours', 'retourner', 'renvoyer', 'retractation'],
    refunds: ['remboursement', 'rembourser', 'rembourse', 'remboursee'],
    payments: ['payer', 'paiement', 'payement', 'payes'],
    cancellations: ['annuler', 'annulation'],
    promotions: ['promo', 'promotions', 'promotion', 'reduction', 'remise', 'offre', 'offres'],
    privacy: ['confidentialite', 'rgpd'],
  },
  /** knowledge-topics.mjs: phrases that settle a topic (fragments). NORM. */
  topicCues: {
    personalData: ['donnees personnelles', 'donnees privees'],
    /** Changing one's data is not a privacy question. */
    privacyChange: ['modifier', 'changer'],
    change: ['modifier', 'changer', 'modification'],
    orderOrAddress: ['adresse', 'commande'],
    gift: ['cadeau'],
    giftOffer: ['offre', 'promo', 'commande', 'gratuit', 'manquant'],
    address: ['adresse'],
    timeOrCost: ['delai', 'temps', 'cout', 'frais'],
    shippingCost: ['frais', 'cout', 'coute', 'gratuite?', 'offerte?', 'seuil', 'port'],
    shippingWhere: ['pays', 'zone', 'destinations?', 'etranger', 'international', 'livrez', 'livrer', 'livre'],
    dispatch: ['expedition', 'expedier', 'preparation'],
    deliveryTime: ['delais?', 'temps', 'jours?', 'arrive', 'livraisson', 'livraison'],
    deliveryTimeStrict: ['delais?', 'temps', 'jours?', 'arrive'],
    deliveryWord: ['livraison'],
    precautions: ['precautions?', 'restrictions?', 'contre indications?', 'interdit', 'danger', 'yeux'],
    suitability: ['enceinte', 'grossesse', 'allait', 'traitement', 'allerg', 'convient'],
    warranty: ['garantie'],
    claims: ['efficacite', 'prouve', 'prouvee', 'resultats?'],
    returns: ['retour', 'retourner', 'ouverte?', 'utilisee?'],
    usage: ['utiliser', 'utilisation', 'usage', 'matin', 'soir', 'seances?', 'nettoyer', 'charger', 'batterie', 'manuel', 'instructions?'],
    abroad: ['etranger', 'international', 'outre mer', 'dom tom'],
    /** Before a bare country answer (« et en Belgique ? »). */
    countryLead: ['et', 'en', 'pour', 'vers'],
  },
  /** knowledge-topics.mjs: other names of countries (normalised name → ISO code). */
  countryAliases: { hollande: 'NL' },

  /** shopping-tools.mjs: which shopping data a message needs (fragments, RAW, case-insensitive). */
  shopping: {
    cart: ['panier', 'déjà', 'deja', 'appliqu', 'reduction', 'réduction'],
    stock: ['stock', 'disponib'],
    /** « les offres sont disponibles »: about the offers, not the stock. */
    offerNouns: ['offres?', 'promotions?', 'promos?', 'codes?'],
    areVerb: ['sont\\s+'],
    available: ['disponib'],
    buyVerbs: ['prends?', 'prendre', 'acheter', 'commande', 'veux'],
    quantities: { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5 },
    everything: ['panier', 'tout'],
    offers: ['promo', 'offre', 'soldes', 'code', 'cumul', 'remise', 'réduction', 'reduction'],
    evaluate: ['panier', 'cumul', 'manque', 'fonctionn', 'marche', 'appliqu', 'réduction', 'reduction', 'remise'],
    /** Words after « code » that are not a code (« mon code ne marche pas »). Upper case. */
    codeFiller: ['PROMO', 'NE', 'DE', 'EST', 'REDUCTION', 'MARCHE', 'FONCTIONNE', 'PAS', 'QUE', 'QUI', 'POUR', 'SUR', 'DANS', 'ET'],
  },

  /** profile-reader.mjs: words that make a message about the skin. NORM. */
  skin: ['peau', 'peaux', 'teint', 'visage', 'levres?', 'joues?', 'front', 'yeux', 'mains?', 'corps'],

  /** order-status.mjs: before an order number (« commande 1234 », « n° 1234 »). RAW. */
  orderPrefix: ['n[°o]\\s*', 'commande\\s*'],

  /**
   * The widget (advisor-cart.js, advisor-panel.js), generated into them by
   * scripts/storefront/build-widget-words.mjs. RAW, case-insensitive fragments.
   */
  widget: {
    /** Shopping words: the message gets the cart's context. */
    shopping: ['panier', 'disponib', 'offre', 'soldes', 'remise', 'reduction', 'réduction', 'cumul', 'quantit'],
    /** « 20 pour cent »: an amount off. */
    discountAmount: ['\\d+\\s*(?:%|pour\\s?cent)'],
    /** On the cart page, about the products in it (« conviennent-ils ? »). */
    cartPage: ['convien', 'ces', 'ils', 'elles'],
    cartPagePhrase: ['voyez.vous'],
    /** The whole cart: « tout », « mon panier ». */
    cartAll: ['panier', 'tout'],
    /** « quelles offres sont disponibles », « les offres du moment »: a listing, the cart is not needed. */
    offerNouns: ['offres?', 'promotions?', 'promos?'],
    areVerb: ['sont\\s+'],
    available: ['disponib'],
    offersNow: ['moment', 'actuell'],
    currentOffers: [],
    /** The cart is needed after all: a code, a combination, an eligibility. */
    eligibility: ['code', 'cumul', 'manque', 'appliqu', 'fonctionn', 'eligib', 'éligib'],
    stock: ['disponib'],
    promo: ['promo', 'offre', 'code'],
    /** advisor-panel.js: a question about an order (« Je vérifie votre commande… »). */
    order: ['commandes?', 'colis'],
  },
};
