/**
 * Dutch: the chat's vocabulary beyond the skin. The same keys as fr/words.mjs, which documents
 * each one. Not « de » or « en » as grammar words: they are everyday French (and Spanish) too.
 * Written 2026-10-30, not yet reviewed by a native speaker (VALIDATION_LOG).
 */
export default {
  code: 'nl',

  turns: {
    yes: ['ja', 'graag', 'zeker', 'prima', 'goed', 'natuurlijk', 'doe maar', 'ok(ay)?'],
    no: ['nee', 'neen', 'niet (nu|vandaag)', 'nee dank je', 'nee bedankt', 'liever niet'],
    negation: ['niet', 'nee', 'geen'],
    stillLooking: ['ik kijk nog', 'ik zoek nog', 'nog niet', 'ik denk er nog over na'],
    cartYes: ['toevoeg\\w*', 'voeg (het|ze) toe', 'ik neem (het|ze|die|dat)', 'in (het|mijn) (winkelmandje|mandje)'],
    addRequest: ['\\b(voeg\\w*|toevoeg\\w*|doe|stop|leg)\\b[^.?!]{0,60}\\b(winkelmandje|winkelwagen|mandje)\\b', '\\bik neem (het|ze|die|dat)\\b'],
    notAdd: ['niet toevoegen', 'niet in (het|mijn) (winkelmandje|mandje)', 'verwijder\\w*', 'haal (het|ze) eruit'],
  },

  contact: ['klantenservice', 'klantendienst', 'neem contact (met ons )?op', 'contactformulier', 'ons team'],
  professional: ['arts', 'artsen', 'huisarts', 'huidarts', 'dermatolo\\w*', 'apotheker\\w*'],
  order: ['bestelling\\w*', 'pakket\\w*', 'levering', 'geleverd', 'ontvangen', 'ontbre\\w*', 'terugbetaling\\w*', 'omruilen', 'retour\\w*', 'track en trace', 'verkeerd\\w* (artikel|product)'],
  orderNumber: ['bestelnummer', 'ordernummer'],
  concernAsk: ['aandachtspunt\\w*', 'prioriteit\\w*', 'een van deze', 'welke van deze', 'verbeteren', 'behandelen', 'aanpakken'],
  asksToSee: ['toon\\w*', 'laat (het )?zien', 'bekijken', 'link'],

  pastPurchase: [
    'ik heb (al |eerder )?(gekocht|besteld)',
    'mijn (laatste|vorige) (bestelling|bestellingen|aankopen)',
    'de vorige keer',
    'opnieuw bestellen|nabestellen|weer kopen',
    'mijn producten',
  ],

  neutral: ['ja', 'nee', 'dank je', 'dank u', 'bedankt', 'graag', 'prima'],

  refs: {
    grammar: ['twee', 'drie', 'vier', 'eerste', 'tweede', 'derde', 'laatste', 'andere', 'beide', 'allebei', 'ochtend', 'avond'],
    // Not « dat »: « ik denk dat… » names nothing.
    anchors: ['het', 'mijn', 'jouw', 'uw', 'onze', 'deze', 'dit'],
    definite: ['het'],
    stopwords: ['of', 'voor', 'met', 'zonder', 'van', 'op', 'is', 'zijn', 'erg', 'niet', 'ook'],
    common: ['minder', 'meer', 'jullie', 'hebben', 'wij', 'maar', 'dus', 'als', 'maken', 'kan', 'wil', 'zou', 'welke', 'wat', 'hoe'],
    indefinite: ['een', 'enkele'],
    separators: ['tegenover'],
    discovery: ['welke', 'hebben jullie', 'heeft u', 'raden jullie', 'raadt u', 'ik zoek (een|iets)', 'een product', 'een creme', 'een serum', 'een routine', 'voor (mijn |droge |vette |gevoelige )?huid', 'jullie producten'],
    pluralPrefixes: ['alle '],
    counts: { twee: 2, drie: 3, vier: 4 },
    pluralAlone: { beide: 2, allebei: 2 },
    recommendedCue: ['aangeraden', 'aanbevolen', 'voorgesteld'],
    other: ['de andere', 'het andere'],
    ordinals: {
      first: ['(de |het )eerste'],
      second: ['(de |het )tweede'],
      third: ['(de |het )derde'],
      last: ['(de |het )laatste'],
    },
    inverted: [],
    // Not « dat » or « dit » alone: « ik denk dat… » points at nothing.
    this: ['dit product', 'deze creme', 'dit serum', 'deze hier', 'die hier'],
    demonstratives: ['deze', 'dit', 'die'],
  },

  equivalents: {
    cream: ['creme', 'cremes'], mask: ['masker', 'maskers'], toner: ['gezichtswater'], gift_set: ['cadeauset', 'geschenkset'], oil: ['olie'], milk: ['melk'],
    balm: ['balsem'], scrub: ['peeling'], cleanser: ['reiniger'], makeup_remover: ['make up remover'], mist: ['gezichtsspray'],
    water: ['water'], foam: ['schuim'], patches: ['oogpads'], night: ['nacht'], day: ['dag'], eyes: ['ogen', 'oog'], lips: ['lippen'],
    hands: ['handen'], body: ['lichaam'], face: ['gezicht'], range: ['lijn', 'serie'], orange_blossom: ['oranjebloesem'], rose_quartz: ['rozenkwarts'],
  },

  demonstrativeCare: ['(?:deze|dit|die) (?:creme|serum|product|verzorging|masker|lotion|balsem|gel|melk|olie|oogcreme|reiniger|elixer|set)'],

  searchStopwords: ['voor', 'met', 'zonder', 'van', 'het', 'mijn', 'huid', 'verzorging', 'product', 'producten'],
  faqStopwords: 'het een of voor met van op is zijn kan ik mijn hoe wat welke niet product producten'.split(' '),

  topics: {
    delivery: ['levering', 'leveren', 'verzending', 'verzenden', 'bezorging', 'bezorgen', 'verstuurd'],
    returns: ['retour', 'retourneren', 'terugsturen', 'herroeping'],
    refunds: ['terugbetaling', 'terugbetalen', 'terugbetaald'],
    payments: ['betaling', 'betalen', 'ideal'],
    cancellations: ['annuleren', 'annulering'],
    promotions: ['korting', 'kortingen', 'aanbieding', 'aanbiedingen', 'kortingscode', 'actie'],
    privacy: ['avg'],
  },
  topicCues: {
    personalData: ['persoonsgegevens', 'persoonlijke gegevens'],
    privacyChange: ['wijzigen', 'aanpassen'],
    change: ['wijzigen', 'aanpassen', 'wijziging'],
    orderOrAddress: ['adres', 'bestelling'],
    gift: ['cadeau'],
    giftOffer: ['aanbieding', 'bestelling', 'gratis', 'ontbreekt'],
    address: ['adres'],
    timeOrCost: ['tijd', 'kosten'],
    shippingCost: ['kosten', 'gratis', 'verzendkosten', 'drempel'],
    shippingWhere: ['landen', 'buitenland', 'internationaal', 'leveren jullie in'],
    dispatch: ['verzending', 'verwerking'],
    deliveryTime: ['hoe lang', 'dagen', 'levertijd', 'duurt'],
    deliveryTimeStrict: ['hoe lang', 'dagen', 'levertijd', 'duurt'],
    deliveryWord: ['levering', 'bezorging'],
    precautions: ['voorzorg\\w*', 'contra indicatie\\w*', 'gevaar\\w*', 'ogen'],
    suitability: ['zwanger', 'borstvoeding', 'geschikt'],
    warranty: ['garantie'],
    claims: ['werkzaamheid', 'resultat\\w*', 'bewezen'],
    returns: ['retour', 'terugsturen', 'geopend', 'gebruikt'],
    usage: ['gebruiken', 'aanbrengen', 'ochtend', 'avond', 'handleiding', 'instructies'],
    abroad: ['buitenland'],
    countryLead: ['naar', 'voor'],
  },
  countryAliases: { holland: 'NL' },

  shopping: {
    cart: ['winkelmandje', 'winkelwagen', 'mandje', 'toegepast', 'korting'],
    stock: ['beschikbaar', 'op voorraad', 'voorraad'],
    offerNouns: ['aanbiedingen?', 'acties?', 'kortingscodes?'],
    areVerb: ['zijn\\s+'],
    available: ['beschikbaar'],
    buyVerbs: ['neem', 'kopen', 'bestellen'],
    quantities: { twee: 2, drie: 3, vier: 4, vijf: 5 },
    everything: ['winkelmandje', 'mandje', 'alles'],
    offers: ['aanbieding', 'korting', 'actie\\b', 'kortingscode', 'combiner'],
    evaluate: ['winkelmandje', 'mandje', 'combiner', 'ontbreekt', 'werkt', 'toegepast', 'korting'],
    codeFiller: ['WERKT', 'NIET', 'KORTING', 'HET', 'IS', 'MIJN', 'VOOR', 'OP'],
  },

  skin: ['huid', 'gezicht', 'gezichtshuid', 'teint', 'porien', 'lippen', 'wangen', 'voorhoofd', 'ogen', 'handen', 'lichaam'],

  orderPrefix: ['bestelling\\s*', 'nr\\.?\\s*'],

  widget: {
    shopping: ['winkelmandje', 'winkelwagen', 'mandje', 'beschikbaar', 'aanbieding', 'korting', 'actie\\b', 'acties', 'combiner', 'aantal', 'voorraad'],
    discountAmount: ['\\d+\\s*(?:%|procent)'],
    cartPage: ['passen', 'deze'],
    cartPagePhrase: ['zie je', 'ziet u'],
    cartAll: ['winkelmandje', 'mandje', 'alles'],
    offerNouns: ['aanbiedingen?', 'acties?'],
    areVerb: ['zijn\\s+'],
    available: ['beschikbaar'],
    offersNow: ['momenteel', 'op dit moment', 'vandaag'],
    currentOffers: ['huidige (aanbiedingen|acties)'],
    eligibility: ['combiner', 'ontbreekt', 'toegepast', 'werkt'],
    stock: ['beschikbaar', 'voorraad'],
    promo: ['aanbieding', 'korting'],
    order: ['bestelling\\w*', 'pakket\\w*'],
  },
};
