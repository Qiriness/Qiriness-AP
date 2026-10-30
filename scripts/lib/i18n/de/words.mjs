/**
 * German: the chat's vocabulary beyond the skin. The same keys as fr/words.mjs, which documents
 * each one. NORM entries are written without umlaut dots (« ruckerstattung »); RAW ones allow both
 * (« zur[uü]ck »). Written 2026-10-30, not yet reviewed by a native speaker (VALIDATION_LOG).
 */
export default {
  code: 'de',

  turns: {
    yes: ['ja', 'gerne?', 'klar', 'sicher', 'nat[uü]rlich', 'einverstanden', 'super', 'ok(ay)?'],
    no: ['nein', 'nee', 'nicht (jetzt|heute)', 'nein danke', 'lieber nicht'],
    negation: ['nicht', 'nein', 'kein\\w*'],
    stillLooking: ['ich schaue noch', 'ich suche noch', 'noch nicht', 'sp[aä]ter', '[uü]berlege noch'],
    cartYes: ['hinzuf[uü]g\\w*', 'f[uü]g\\w* (es|sie|ihn) hinzu', 'ich nehme (es|sie|ihn|das)', '(bitte )?in den warenkorb'],
    // The verb comes first (« füge es in den Warenkorb ») or last (« bitte in den Warenkorb legen »).
    addRequest: ['\\b(f[uü]g\\w*|leg\\w*|pack\\w*|tu\\w*|hinzuf[uü]g\\w*)\\b[^.?!]{0,60}\\b(warenkorb|einkaufswagen)\\b', '\\b(warenkorb|einkaufswagen)\\b[^.?!]{0,30}\\b(legen|hinzuf[uü]gen|tun|packen)\\b', '\\bich nehme (es|sie|ihn|das|die)\\b'],
    notAdd: ['nicht (hinzuf[uü]gen|in den warenkorb)', 'entfern\\w*', 'l[oö]sch\\w*'],
  },

  contact: ['kundenservice', 'kundendienst', 'kontaktieren sie uns', 'kontaktformular', 'unser team'],
  professional: ['arzt', 'arztin', 'arzte', 'hautarzt\\w*', 'dermatolog\\w*', 'apothek\\w*'],
  order: ['bestellung\\w*', 'paket\\w*', 'lieferung\\w*', 'geliefert', 'erhalten', 'fehlt', 'fehlen', 'ruckerstattung\\w*', 'erstattung\\w*', 'umtausch', 'rucksendung\\w*', 'sendungsverfolgung', 'falsch\\w* (artikel|produkt)'],
  orderNumber: ['bestellnummer', 'nummer der bestellung'],
  concernAsk: ['anliegen\\w*', 'prioritat\\w*', 'hauptproblem', 'eines davon', 'welches davon', 'verbessern', 'behandeln', 'mildern', 'angehen'],
  asksToSee: ['zeig\\w*', 'ansehen', 'anschauen', 'link'],

  pastPurchase: [
    'ich habe (schon |bereits )?(gekauft|bestellt)',
    '(schon|bereits) (gekauft|bestellt)',
    'meine (letzte|letzten|vorherige) (bestellung|bestellungen|k[aä]ufe)',
    'das letzte mal',
    'nachbestellen|nachkaufen|wieder kaufen',
    'meine produkte',
  ],

  neutral: ['ja', 'nein', 'danke', 'danke sch[oö]n', 'gerne'],

  refs: {
    grammar: ['zwei', 'drei', 'vier', 'erste', 'erster', 'erstes', 'zweite', 'zweiter', 'dritte', 'letzte', 'letzter', 'andere', 'anderen', 'beide', 'beiden', 'morgens', 'abends'],
    // Not « des »: French « des rides » would make « rides » a product's name.
    anchors: ['der', 'die', 'das', 'den', 'dem', 'mein', 'meine', 'meinen', 'ihre', 'deine', 'unsere', 'dieser', 'diese', 'dieses'],
    definite: ['der', 'die', 'das', 'den', 'dem'],
    stopwords: ['und', 'oder', 'fur', 'mit', 'ohne', 'von', 'zu', 'auf', 'ist', 'sind', 'sehr', 'nicht', 'auch'],
    common: ['weniger', 'mehr', 'sie', 'haben', 'wir', 'aber', 'wenn', 'machen', 'kann', 'mochte', 'sein', 'welche', 'wie'],
    indefinite: ['ein', 'eine', 'einen', 'einem', 'einer', 'etwas'],
    separators: ['und', 'oder', 'mit', 'gegen'],
    discovery: ['welche\\w*', 'haben sie', 'habt ihr', 'empfehlen sie', 'empfehlt', 'ich suche (ein|eine|einen)', 'ein produkt', 'eine creme', 'ein serum', 'eine routine', 'fur (meine |trockene |fettige |empfindliche )?haut', 'ihre produkte'],
    pluralPrefixes: ['alle '],
    counts: { zwei: 2, drei: 3, vier: 4 },
    pluralAlone: { beide: 2, beiden: 2 },
    recommendedCue: ['empfohlen\\w*', 'vorgeschlagen\\w*'],
    other: ['das andere', 'die andere', 'der andere'],
    // With their article: « erste Falten » are early wrinkles, not the first product.
    ordinals: {
      first: ['(der |die |das )(erste|erster|erstes)'],
      second: ['(der |die |das )(zweite|zweiter|zweites)'],
      third: ['(der |die |das )(dritte|dritter|drittes)'],
      last: ['(der |die |das )(letzte|letzter|letztes)'],
    },
    inverted: [],
    // Not « diese » alone: « diese Woche » points at nothing.
    this: ['das hier', 'dieses hier', 'dieses produkt', 'diese creme', 'dieses serum'],
    demonstratives: ['dieses', 'diese', 'dieser', 'diesen'],
  },

  equivalents: {
    cream: ['creme', 'cremes'], mask: ['maske', 'masken'], toner: ['gesichtswasser', 'tonic'], gift_set: ['geschenkset', 'geschenkbox'], oil: ['ol'], milk: ['milch'],
    balm: ['balsam'], scrub: ['peeling'], cleanser: ['reiniger', 'reinigungsgel'], makeup_remover: ['make up entferner', 'abschminkmittel'], mist: ['gesichtsspray'],
    water: ['wasser'], foam: ['schaum'], patches: ['augenpads'], night: ['nacht'], day: ['tag'], eyes: ['augen', 'auge'], lips: ['lippen'],
    hands: ['hande'], body: ['korper'], face: ['gesicht'], range: ['serie', 'linie'], orange_blossom: ['orangenblute'], rose_quartz: ['rosenquarz'],
  },

  demonstrativeCare: ['(?:diese|dieses|dieser|diesen) (?:creme|serum|produkt|pflege|maske|lotion|balsam|gel|milch|ol|augencreme|reiniger|elixier|set)'],

  searchStopwords: ['und', 'fur', 'mit', 'ohne', 'von', 'der', 'die', 'das', 'mein', 'meine', 'haut', 'pflege', 'produkt', 'produkte'],
  faqStopwords: 'der die das den dem ein eine einen und oder fur mit von zu auf ist sind kann ich mein meine wie welche nicht produkt produkte'.split(' '),

  topics: {
    delivery: ['lieferung', 'liefern', 'versand', 'versenden', 'zustellung', 'verschickt'],
    returns: ['rucksendung', 'zurucksenden', 'retoure', 'widerruf'],
    refunds: ['erstattung', 'ruckerstattung', 'erstattet'],
    payments: ['zahlung', 'bezahlen', 'zahlen', 'ratenzahlung'],
    cancellations: ['stornieren', 'stornierung', 'storno'],
    promotions: ['rabatt', 'rabatte', 'angebot', 'angebote', 'gutschein', 'aktion', 'rabattcode'],
    privacy: ['datenschutz', 'dsgvo'],
  },
  topicCues: {
    personalData: ['personliche daten', 'personenbezogene daten'],
    privacyChange: ['andern'],
    change: ['andern', 'anderung', 'bearbeiten'],
    orderOrAddress: ['adresse', 'bestellung'],
    gift: ['geschenk'],
    giftOffer: ['angebot', 'bestellung', 'gratis', 'fehlt'],
    address: ['adresse'],
    timeOrCost: ['dauer', 'zeit', 'kosten'],
    shippingCost: ['kosten', 'gebuhr\\w*', 'gratis', 'kostenlos', 'versandkostenfrei', 'schwelle'],
    shippingWhere: ['lander', 'land', 'ausland', 'liefern sie nach'],
    dispatch: ['versand', 'bearbeitung'],
    deliveryTime: ['dauer', 'wie lange', 'tage', 'lieferzeit'],
    deliveryTimeStrict: ['dauer', 'wie lange', 'tage', 'lieferzeit'],
    deliveryWord: ['lieferung'],
    precautions: ['vorsicht\\w*', 'gegenanzeige\\w*', 'gefahr\\w*', 'augen'],
    suitability: ['schwanger', 'stillzeit', 'geeignet', 'vertrag'],
    warranty: ['garantie', 'gewahrleistung'],
    claims: ['wirksamkeit', 'ergebnis\\w*', 'bewiesen'],
    returns: ['rucksendung', 'zurucksenden', 'geoffnet', 'benutzt'],
    usage: ['anwend\\w*', 'benutzen', 'auftragen', 'morgens', 'abends', 'anleitung'],
    abroad: ['ausland'],
    countryLead: ['und', 'nach', 'fur'],
  },
  countryAliases: {},

  shopping: {
    cart: ['warenkorb', 'einkaufswagen', 'bereits', 'angewendet', 'rabatt'],
    stock: ['verf[uü]gbar', 'vorr[aä]tig', 'auf lager'],
    offerNouns: ['angebote?', 'aktionen?', 'gutscheine?'],
    areVerb: ['sind\\s+'],
    available: ['verf[uü]gbar'],
    buyVerbs: ['nehme', 'kaufen', 'bestellen', 'm[oö]chte'],
    quantities: { ein: 1, eine: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, funf: 5 },
    everything: ['warenkorb', 'alles'],
    offers: ['angebot', 'rabatt', 'gutschein', 'aktion', 'kombinier'],
    evaluate: ['warenkorb', 'kombinier', 'fehlt', 'funktioniert', 'angewendet', 'rabatt'],
    codeFiller: ['FUNKTIONIERT', 'NICHT', 'RABATT', 'DER', 'DIE', 'DAS', 'IST', 'MEIN', 'FUR', 'AUF', 'UND'],
  },

  skin: ['haut', 'gesicht', 'gesichtshaut', 'teint', 'poren', 'lippen', 'wangen', 'stirn', 'augen', 'hande', 'korper'],

  orderPrefix: ['bestellung\\s*', 'nr\\.?\\s*'],

  widget: {
    shopping: ['warenkorb', 'einkaufswagen', 'verf[uü]gbar', 'angebot', 'rabatt', 'gutschein', 'aktion', 'kombinier', 'menge', 'lager'],
    discountAmount: ['\\d+\\s*(?:%|prozent)'],
    cartPage: ['passen', 'diese'],
    cartPagePhrase: ['sehen sie'],
    cartAll: ['warenkorb', 'alles'],
    offerNouns: ['angebote?', 'aktionen?'],
    areVerb: ['sind\\s+'],
    available: ['verf[uü]gbar'],
    offersNow: ['moment', 'aktuell', 'gerade', 'heute'],
    currentOffers: ['aktuelle (angebote|aktionen)'],
    eligibility: ['kombinier', 'fehlt', 'angewendet', 'funktioniert'],
    stock: ['verf[uü]gbar', 'lager'],
    promo: ['angebot', 'rabatt'],
    order: ['bestellung\\w*', 'paket\\w*'],
  },
};
