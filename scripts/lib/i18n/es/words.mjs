/**
 * Spanish: the chat's vocabulary beyond the skin. The same keys as fr/words.mjs, which documents
 * each one. Written 2026-10-30; the owner reviews the Spanish (VALIDATION_LOG).
 */
export default {
  code: 'es',

  turns: {
    yes: ['s[ií]', 'claro', 'por supuesto', 'vale', 'de acuerdo', 'perfecto', 'venga', 'ok(ay)?'],
    no: ['no', 'no gracias', 'ahora no', 'no hace falta'],
    negation: ['no'],
    stillLooking: ['sigo mirando', 'todav[ií]a estoy mirando', 'a[uú]n no', 'todav[ií]a no', 'm[aá]s tarde', 'lo pienso', 'lo pensar[eé]'],
    // « añadir », « añádelo » (the accent moves with the pronoun).
    cartYes: ['a[nñ][aá]d\\w*', 'agr[eé]g\\w*', 'p[oó]n(lo|la|los|las)', 'me (lo|la|los|las) llevo', 'dale'],
    addRequest: ['(a[nñ][aá]d\\w*|agr[eé]g\\w*|p[oó]n\\w*|m[eé]te\\w*)[^.?!]{0,60}\\b(carrito|cesta|carro)\\b', '\\bme (lo|la|los|las) llevo\\b'],
    notAdd: ['no (lo |la |los |las )?(a[nñ]ad|agreg|pong)\\w*', 'no (al|en el) carrito', 'quit\\w*', 'elimin\\w*', 'borr\\w*'],
  },

  contact: ['servicio de atenci[oó]n al cliente', 'atenci[oó]n al cliente', 'cont[aá]ctanos', 'contactar con nosotros', 'formulario de contacto', 'nuestro equipo'],
  professional: ['medicos?', 'dermatolog\\w*', 'farmaceutic\\w*', 'profesional de la salud'],
  order: ['pedidos?', 'paquetes?', 'envio', 'entrega\\w*', 'entregad\\w*', 'recibid[oa]', 'faltan?', 'reembols\\w*', 'devoluci\\w*', 'seguimiento', 'producto (equivocado|incorrecto|danado|roto)'],
  orderNumber: ['numero de pedido'],
  concernAsk: ['preocupacion\\w*', 'prioridad\\w*', 'una de estas', 'cual de estas', 'mejorar', 'tratar', 'atenuar', 'trabajar'],
  asksToSee: ['mu[eé]stra\\w*', 'ver', 'enlace', 'ficha'],

  pastPurchase: [
    '(ya )?(he comprado|compr[eé]|he pedido|ped[ií])',
    'mis ([uú]ltimos |anteriores )?(pedidos|compras)',
    'mi ([uú]ltimo |anterior )?pedido',
    'la [uú]ltima vez',
    'volver a comprar|recomprar|volver a pedir',
    'mis productos',
  ],

  neutral: ['s[ií]', 'gracias', 'vale', 'claro'],

  refs: {
    grammar: ['dos', 'tres', 'cuatro', 'primero', 'primera', 'segundo', 'segunda', 'tercero', 'tercera', 'ultimo', 'ultima', 'otro', 'otra', 'otros', 'ambos', 'ambas', 'manana', 'noche'],
    // Not « mi »: it is Italian's "me" too; not « tu »: it is French; not « esta »: « está » is a verb.
    anchors: ['el', 'los', 'las', 'del', 'al', 'mis', 'su', 'sus', 'vuestro', 'nuestro', 'este', 'ese', 'esa'],
    definite: ['el', 'los', 'las'],
    stopwords: ['del', 'y', 'o', 'al', 'para', 'por', 'con', 'sin', 'sobre', 'es', 'no', 'mas', 'muy'],
    common: ['menos', 'tienen', 'tenemos', 'son', 'pero', 'entonces', 'tambien', 'como', 'cuando', 'hacer', 'puedo', 'puede', 'quiero', 'ser', 'tener', 'cual'],
    indefinite: ['un', 'una', 'unos', 'unas', 'algun', 'alguna'],
    separators: ['y', 'o', 'con', 'contra', 'luego'],
    // Not « que » alone: it is French's « que » too.
    discovery: ['cual', 'cuales', 'que (crema|serum|producto)', 'tienen', 'teneis', 'recomiendan', 'recomiendas', 'busco (un|una|unos)', 'un producto', 'una crema', 'un serum', 'una rutina', 'para (mi |una )?piel', 'vuestros productos', 'sus productos'],
    pluralPrefixes: ['los ', 'las ', 'todos los ', 'todas las '],
    counts: { dos: 2, tres: 3, cuatro: 4 },
    pluralAlone: { ambos: 2, ambas: 2 },
    recommendedCue: ['recomendad\\w*', 'aconsejad\\w*', 'propuest\\w*', 'sugerid\\w*'],
    other: ['el otro', 'la otra'],
    ordinals: {
      first: ['(el |la )(primero|primera|primer)'],
      second: ['(el |la )(segundo|segunda)'],
      third: ['(el |la )(tercero|tercera)'],
      last: ['(el |la )(ultimo|ultima)'],
    },
    inverted: [],
    // Not « esta » alone: « mi piel está seca » points at nothing.
    this: ['esto', 'este producto', 'esta crema', 'este serum', 'ese producto', 'esa crema'],
    demonstratives: ['este', 'esta', 'ese', 'esa', 'estos', 'estas'],
  },

  equivalents: {
    cream: ['crema', 'cremas'], mask: ['mascarilla', 'mascarillas'], toner: ['tonico'], gift_set: ['cofre', 'estuche', 'set de regalo'], oil: ['aceite'], milk: ['leche'],
    balm: ['balsamo'], scrub: ['exfoliante'], cleanser: ['limpiador', 'limpiadora'], makeup_remover: ['desmaquillante'], mist: ['bruma'],
    water: ['agua'], foam: ['espuma'], patches: ['parches'], night: ['noche'], day: ['dia'], eyes: ['ojos', 'ojo'], lips: ['labios'],
    hands: ['manos', 'mano'], body: ['cuerpo'], face: ['cara', 'rostro'], range: ['gama'], orange_blossom: ['azahar', 'flor de azahar'], rose_quartz: ['cuarzo rosa'],
  },

  demonstrativeCare: ['(?:esta|este|esa|ese) (?:crema|serum|producto|tratamiento|mascarilla|locion|balsamo|gel|leche|aceite|contorno|limpiador|elixir|estuche)'],

  searchStopwords: ['los', 'las', 'una', 'para', 'con', 'sin', 'del', 'por', 'mis', 'piel', 'producto', 'productos', 'cuidado'],
  faqStopwords: 'el los las un una del al con por para y o no como cual puedo debo mis es son este esta producto productos'.split(' '),

  topics: {
    delivery: ['entrega', 'entregar', 'envio', 'enviar', 'enviado', 'reparto'],
    returns: ['devolucion', 'devolver', 'devoluciones', 'desistimiento'],
    refunds: ['reembolso', 'reembolsar', 'reembolsado'],
    payments: ['pago', 'pagar', 'pagos', 'plazos'],
    cancellations: ['cancelar', 'cancelacion', 'anular'],
    promotions: ['descuento', 'descuentos', 'promocion', 'promociones', 'oferta', 'ofertas', 'cupon', 'codigo'],
    privacy: ['privacidad'],
  },
  topicCues: {
    personalData: ['datos personales'],
    privacyChange: ['modificar', 'cambiar'],
    change: ['modificar', 'cambiar', 'modificacion'],
    orderOrAddress: ['direccion', 'pedido'],
    gift: ['regalo'],
    giftOffer: ['oferta', 'pedido', 'gratis', 'falta'],
    address: ['direccion'],
    timeOrCost: ['plazo', 'tiempo', 'coste', 'costo', 'gastos'],
    shippingCost: ['coste', 'costo', 'gastos', 'gratis', 'gratuito', 'umbral'],
    shippingWhere: ['paises', 'pais', 'extranjero', 'internacional', 'envian a'],
    dispatch: ['envio', 'preparacion'],
    deliveryTime: ['plazo', 'plazos', 'dias', 'cuanto tarda', 'tarda', 'llega'],
    deliveryTimeStrict: ['plazo', 'plazos', 'dias', 'cuanto tarda', 'tarda', 'llega'],
    deliveryWord: ['entrega'],
    precautions: ['precaucion\\w*', 'contraindicacion\\w*', 'peligro\\w*', 'ojos'],
    suitability: ['embaraz', 'lactancia', 'amamant', 'adecuad'],
    warranty: ['garantia'],
    claims: ['eficacia', 'resultad\\w*', 'probad[oa]'],
    returns: ['devolucion', 'devolver', 'abiert[oa]', 'usad[oa]'],
    usage: ['usar', 'utilizar', 'aplicar', 'manana', 'noche', 'instrucciones', 'manual'],
    abroad: ['extranjero'],
    countryLead: ['y', 'para', 'hacia'],
  },
  countryAliases: { holanda: 'NL', eeuu: 'US' },

  shopping: {
    cart: ['carrito', 'cesta', '\\bya\\b', 'aplicad', 'descuento'],
    stock: ['disponib', 'en stock'],
    offerNouns: ['ofertas?', 'promociones?', 'c[oó]digos?'],
    areVerb: ['est[aá]n\\s+'],
    available: ['disponib'],
    buyVerbs: ['compro', 'comprar', 'pido', 'pedir', 'quiero', 'llevo'],
    quantities: { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 },
    everything: ['carrito', 'cesta', 'todo'],
    offers: ['oferta', 'descuento', 'rebajas', 'c[oó]digo', 'cup[oó]n', 'promoci', 'acumul'],
    evaluate: ['carrito', 'cesta', 'acumul', 'falta', 'funciona', 'aplicad', 'descuento'],
    codeFiller: ['NO', 'FUNCIONA', 'DESCUENTO', 'EL', 'LA', 'ES', 'MI', 'PARA', 'EN', 'Y', 'ESTE'],
  },

  skin: ['piel', 'pieles', 'cara', 'rostro', 'tez', 'labios', 'mejillas', 'frente', 'ojos', 'manos', 'cuerpo', 'poros'],

  orderPrefix: ['pedido\\s*', 'n[uú]m(?:ero)?\\.?\\s*'],

  widget: {
    shopping: ['carrito', 'cesta', 'disponib', 'oferta', 'rebajas', 'descuento', 'cup[oó]n', 'acumul', 'cantidad', 'c[oó]digo'],
    discountAmount: ['\\d+\\s*(?:%|por\\s?ciento)'],
    cartPage: ['sirven', 'estos', 'estas', 'valen'],
    cartPagePhrase: ['puedes ver', 'puede ver'],
    cartAll: ['carrito', 'cesta', 'todo'],
    offerNouns: ['ofertas?', 'promociones?'],
    areVerb: ['est[aá]n\\s+'],
    available: ['disponib'],
    offersNow: ['momento', 'actual', 'ahora', 'hoy'],
    currentOffers: ['ofertas actuales'],
    eligibility: ['acumul', 'falta', 'aplic', 'funciona', 'v[aá]lid'],
    stock: ['disponib'],
    promo: ['oferta', 'descuento'],
    order: ['pedidos?', 'paquetes?'],
  },
};
