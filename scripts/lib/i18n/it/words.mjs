/**
 * Italian: the chat's vocabulary beyond the skin. The same keys as fr/words.mjs, which documents
 * each one. Written 2026-10-30, not yet reviewed by a native speaker (VALIDATION_LOG).
 */
export default {
  code: 'it',

  turns: {
    yes: ['s[iì]', 'certo', 'certamente', 'volentieri', "d'accordo", 'va bene', 'perfetto', 'ok(ay)?'],
    no: ['no', 'no grazie', 'non (ora|adesso|per ora)', 'non serve'],
    negation: ['non'],
    stillLooking: ['sto ancora guardando', 'sto ancora cercando', 'non ancora', 'pi[uù] tardi', 'ci penso'],
    cartYes: ['aggiung\\w*', 'mettil[oaie]', 'mett\\w*', 'lo prendo', 'la prendo', 'li prendo', 'le prendo'],
    addRequest: ['\\b(aggiung\\w*|mett\\w*|inserisc\\w*)\\b[^.?!]{0,60}\\bcarrello\\b', '\\b(lo|la|li|le) prendo\\b'],
    notAdd: ['non (lo |la |li |le )?(aggiung|mett)\\w*', 'non nel carrello', 'rimuov\\w*', 'togli\\w*'],
  },

  contact: ['servizio clienti', 'assistenza clienti', 'contattarci', 'contattaci', 'modulo di contatto', 'il nostro team'],
  professional: ['medic[oi]', 'dermatolog\\w*', 'farmacist\\w*', 'professionista sanitario'],
  order: ['ordin[ei]', 'pacco', 'pacchi', 'spedizion[ei]', 'consegn\\w*', 'ricevuto', 'mancant[ei]', 'rimbors\\w*', 'cambi[oa]', 'resi', 'reso', 'tracciamento', 'prodotto sbagliato'],
  orderNumber: ['numero (di |dell )?ordine'],
  concernAsk: ['preoccupazion\\w*', 'priorit\\w*', 'problem[ai]', 'una di queste', 'quale di queste', 'migliorare', 'trattare', 'attenuare', 'lavorare su'],
  asksToSee: ['mostra\\w*', 'vedere', 'rivedere', 'link', 'scheda'],

  pastPurchase: [
    'ho (gia )?(comprato|acquistato|ordinato|preso)',
    'i miei (ultimi |precedenti )?(acquisti|ordini)',
    'il mio (ultimo |precedente )?ordine',
    "l'ultima volta|l ultima volta",
    'ricomprare|riordinare|riprendere',
    'i miei prodotti',
  ],

  neutral: ['s[iì]', 'grazie', 'va bene', 'perfetto'],

  refs: {
    grammar: ['due', 'tre', 'quattro', 'primo', 'prima', 'secondo', 'seconda', 'terzo', 'terza', 'ultimo', 'ultima', 'altro', 'altra', 'altri', 'questo', 'quello', 'quella', 'mattina', 'sera', 'entrambi', 'entrambe'],
    // Not « i »: it is English's "I".
    anchors: ['il', 'lo', 'la', 'gli', 'le', 'del', 'della', 'al', 'alla', 'mio', 'mia', 'suo', 'sua', 'vostro', 'vostra', 'questo', 'questa', 'quel', 'quella'],
    definite: ['il', 'lo', 'la', 'gli', 'le'],
    stopwords: ['di', 'da', 'e', 'o', 'per', 'con', 'senza', 'su', 'in', 'che', 'non', 'piu', 'molto', 'anche'],
    common: ['meno', 'avete', 'abbiamo', 'sono', 'ma', 'quindi', 'allora', 'come', 'quando', 'fare', 'posso', 'puo', 'voglio', 'essere', 'avere', 'questa', 'quale', 'cosa', 'vorrei'],
    indefinite: ['un', 'uno', 'una', 'dei', 'delle', 'degli', 'qualche'],
    separators: ['e', 'o', 'oppure', 'con', 'contro', 'poi'],
    discovery: ['quale', 'quali', 'avete', 'consigliate', 'consigli', 'proponete', 'cerco (un|una|dei|delle)', 'un prodotto', 'una crema', 'un siero', 'una routine', 'per (la mia |una )?pelle', 'i vostri prodotti'],
    pluralPrefixes: ['tutti e ', 'tutte e ', 'i ', 'le '],
    counts: { due: 2, tre: 3, quattro: 4 },
    pluralAlone: { entrambi: 2, entrambe: 2 },
    recommendedCue: ['consigliat\\w*', 'raccomandat\\w*', 'propost\\w*', 'suggerit\\w*'],
    other: ['l altro', 'l altra'],
    // With their article: alone, « prima » is "before" and « secondo » "according to".
    ordinals: {
      first: ['(il |la )(primo|prima)'],
      second: ['(il |la )(secondo|seconda)'],
      third: ['(il |la )?(terzo|terza)'],
      last: ['(l |il |la )(ultimo|ultima)'],
    },
    inverted: [],
    // Not « questa » alone: « questa mattina » points at nothing.
    this: ['questo', 'quello', 'questo prodotto', 'questa crema', 'questo siero', 'quel prodotto'],
    demonstratives: ['questo', 'questa', 'quel', 'quella'],
  },

  equivalents: {
    cream: ['crema', 'creme'], mask: ['maschera', 'maschere'], toner: ['tonico'], gift_set: ['cofanetto', 'set regalo'], oil: ['olio'], milk: ['latte'],
    balm: ['balsamo'], scrub: ['scrub', 'esfoliante'], cleanser: ['detergente'], makeup_remover: ['struccante'], mist: ['acqua spray', 'nebulizzatore'],
    water: ['acqua'], foam: ['schiuma'], patches: ['cerotti'], night: ['notte'], day: ['giorno'], eyes: ['occhi', 'occhio'], lips: ['labbra'],
    hands: ['mani', 'mano'], body: ['corpo'], face: ['viso'], range: ['linea', 'gamma'], orange_blossom: ['fiori d arancio'], rose_quartz: ['quarzo rosa'],
  },

  demonstrativeCare: ['(?:questo|questa|quel|quella) (?:crema|siero|prodotto|trattamento|maschera|lozione|balsamo|gel|latte|olio|contorno|detergente|elisir|cofanetto)'],

  searchStopwords: ['per', 'con', 'senza', 'della', 'delle', 'dei', 'mia', 'mio', 'pelle', 'prodotto', 'prodotti', 'cura'],
  faqStopwords: 'il lo la i gli le un una di da del della in con su per e o non che come cosa quale quali posso puo devo mio mia questo questa prodotto prodotti'.split(' '),

  topics: {
    delivery: ['consegna', 'consegnare', 'spedizione', 'spedire', 'spedito'],
    returns: ['reso', 'resi', 'restituire', 'restituzione', 'recesso'],
    refunds: ['rimborso', 'rimborsare', 'rimborsato'],
    payments: ['pagamento', 'pagare', 'pagamenti'],
    cancellations: ['annullare', 'annullamento', 'cancellare'],
    promotions: ['sconto', 'sconti', 'promozione', 'promozioni', 'offerta', 'offerte', 'codice'],
    privacy: ['riservatezza'],
  },
  topicCues: {
    personalData: ['dati personali'],
    privacyChange: ['modificare', 'cambiare'],
    change: ['modificare', 'cambiare', 'modifica'],
    orderOrAddress: ['indirizzo', 'ordine'],
    gift: ['regalo'],
    giftOffer: ['offerta', 'ordine', 'gratuito', 'mancante'],
    address: ['indirizzo'],
    timeOrCost: ['tempi', 'tempo', 'costo', 'spese'],
    shippingCost: ['costo', 'costi', 'spese', 'gratuita', 'gratis', 'soglia'],
    shippingWhere: ['paesi', 'paese', 'estero', 'spedite in', 'consegnate in'],
    dispatch: ['spedizione', 'preparazione'],
    deliveryTime: ['tempi', 'giorni', 'quanto tempo', 'arriva'],
    deliveryTimeStrict: ['tempi', 'giorni', 'quanto tempo', 'arriva'],
    deliveryWord: ['consegna'],
    precautions: ['precauzion\\w*', 'controindicazion\\w*', 'pericol\\w*', 'occhi'],
    suitability: ['incinta', 'gravidanza', 'allatt', 'adatt'],
    warranty: ['garanzia'],
    claims: ['efficacia', 'risultat[oi]', 'provat[oa]'],
    returns: ['reso', 'restituire', 'apert[oa]', 'usat[oa]'],
    usage: ['usare', 'utilizzare', 'applicare', 'mattina', 'sera', 'istruzioni', 'manuale'],
    abroad: ['estero'],
    countryLead: ['e', 'in', 'per', 'verso'],
  },
  countryAliases: {},

  shopping: {
    cart: ['carrello', '\\bgi[aà]\\b', 'applicat', 'sconto'],
    stock: ['disponibil'],
    offerNouns: ['offerte?', 'promozion[ei]', 'codic[ei]'],
    areVerb: ['sono\\s+'],
    available: ['disponibil'],
    buyVerbs: ['prendo', 'prendere', 'comprare', 'compro', 'ordinare', 'voglio'],
    quantities: { uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5 },
    everything: ['carrello', 'tutto'],
    offers: ['offert', 'sconto', 'saldi', 'codice', 'cumul', 'promozion'],
    evaluate: ['carrello', 'cumul', 'manca', 'funzion', 'applicat', 'sconto'],
    codeFiller: ['NON', 'FUNZIONA', 'SCONTO', 'CHE', 'PER', 'SU', 'IL', 'LA', 'E', 'MIO', 'MIA', 'QUESTO'],
  },

  skin: ['pelle', 'pelli', 'viso', 'volto', 'labbra', 'guance', 'fronte', 'occhi', 'mani', 'corpo', 'carnagione'],

  orderPrefix: ['ordine\\s*', 'n\\.?\\s*'],

  widget: {
    shopping: ['carrello', 'disponibil', 'offert', 'saldi', 'sconto', 'cumul', 'quantit', 'codice'],
    discountAmount: ['\\d+\\s*(?:%|per\\s?cento)'],
    cartPage: ['vanno', 'questi', 'queste', 'adatti'],
    cartPagePhrase: ['vedete'],
    cartAll: ['carrello', 'tutto'],
    offerNouns: ['offerte?', 'promozion[ei]'],
    areVerb: ['sono\\s+'],
    available: ['disponibil'],
    offersNow: ['momento', 'attual'],
    currentOffers: [],
    eligibility: ['cumul', 'manca', 'applic', 'funzion', 'idone'],
    stock: ['disponibil'],
    promo: ['offert', 'sconto'],
    order: ['ordin[ei]', 'pacc[oh]i?'],
  },
};
