/**
 * English: the chat's vocabulary beyond the skin (lexicon.mjs). The same keys as fr/words.mjs, which
 * documents each one; i18n.test.mjs holds them to it.
 */
export default {
  code: 'en',

  turns: {
    yes: ['yes', 'yeah', 'yep', 'sure', 'please', 'of course', "let'?s (do it|go)"],
    no: ['no', 'nope', 'not (now|right now|today)', 'no thanks?'],
    negation: ['not', 'no'],
    stillLooking: ['still looking', 'just looking', 'not yet', 'maybe later', 'later'],
    cartYes: ['add( (it|them|this|that))?', 'put (it|them) in', 'go ahead', 'do it', "i'?ll take (it|them)"],
    addRequest: ['\\b(add|put|pop|place)\\b[^.?!]{0,60}\\b(cart|basket|bag)\\b', "\\bi'?ll take (it|them|this|that)\\b"],
    notAdd: ["don'?t add", 'do not add', 'remove'],
  },

  contact: ['customer (?:service|care|support)', 'contact us', 'contact form', 'get in touch', 'reach (?:out to )?us'],
  professional: ['doctors?', 'physicians?', 'pharmacists?', 'gp', 'healthcare professional'],
  order: ['orders?', 'parcels?', 'packages?', 'deliver\\w*', 'received', 'missing', 'refunds?', 'exchanges?', 'returns?', 'tracking', 'wrong (item|product)'],
  orderNumber: ['order number'],
  concernAsk: ['concerns?', 'worr\\w*', 'bother\\w*', 'one of these', 'which of these', 'address', 'target', 'focus on', 'work on', 'improve', 'treat'],
  asksToSee: ['show( me)?', 'see( it)?', 'link'],

  pastPurchase: [
    'i (?:have |\'ve )?(?:already )?(?:bought|ordered|purchased|got)',
    'my (?:last |previous |past )?(?:orders?|purchases?)',
    'last time',
    're-?order|re-?buy|buy (?:it|that|them) again',
    'my products',
  ],

  neutral: ['yes', 'no', 'ok', 'okay', 'thanks', 'thank you'],

  refs: {
    grammar: ['both', 'other', 'first', 'last', 'third', 'two', 'three', 'four', 'second', 'morning', 'evening', 'one', 'ones'],
    anchors: ['the', 'my', 'your', 'our', 'this', 'that', 'these', 'those'],
    definite: ['the'],
    stopwords: ['of', 'for', 'and', 'with', 'is', 'it', 'to', 'in', 'on', 'from', 'are', 'does', 'do', 'very', 'not'],
    common: ['less', 'your', 'yours', 'what', 'have', 'will', 'would', 'could', 'should', 'about', 'there', 'their', 'them', 'they', 'when', 'where', 'which', 'with', 'this', 'that',
      'than', 'then', 'into', 'just', 'some', 'many', 'much', 'more', 'most', 'also', 'only', 'other', 'good', 'need', 'want', 'like', 'make', 'used', 'using'],
    indefinite: ['a', 'an', 'some', 'any'],
    separators: ['and', 'or', 'with'],
    discovery: ['which', 'what', 'do you have', 'have you got', 'recommend', 'suggest', 'something for', 'looking for (a|an|some)', 'a product', 'a cream', 'a serum', 'an? (routine|treatment)', 'for (dry|oily|combination|sensitive|my) skin', 'your products'],
    pluralPrefixes: ['the ', 'the first ', 'all '],
    counts: { two: 2, three: 3, four: 4 },
    pluralAlone: { both: 2, 'all three': 3 },
    recommendedCue: ['suggest\\w*'],
    other: ['the other( one)?'],
    ordinals: {
      first: ['first'],
      second: [],
      third: ['third'],
      last: ['last'],
    },
    inverted: [],
    this: ['this one', 'that one', 'this product', 'this item', 'it'],
    demonstratives: ['this', 'that', 'these', 'those'],
  },

  equivalents: {
    cream: ['cream', 'creams', 'moisturiser', 'moisturizer'], mask: ['mask', 'masks'], toner: ['toner'], gift_set: ['gift set', 'gift box', 'box set'],
    oil: ['oil'], milk: ['milk'], balm: ['balm'], scrub: ['scrub', 'exfoliator'], cleanser: ['cleanser'], makeup_remover: ['make up remover', 'makeup remover'],
    mist: ['mist'], water: ['water'], foam: ['foam'], patches: ['patches'], night: ['night'], day: ['day'], eyes: ['eye', 'eyes'], lips: ['lips'],
    hands: ['hand', 'hands'], body: ['body'], face: ['face'], range: ['range'], orange_blossom: ['orange blossom'], rose_quartz: ['rose quartz'],
  },

  demonstrativeCare: ['this (?:cream|serum|product|one|mask|lotion|balm|gel|cleanser|fluid|oil|kit|set)'],

  searchStopwords: ['the', 'and', 'for', 'with', 'skin', 'product', 'products', 'care'],
  faqStopwords: 'do the a an is are can i my to of how what it this for and does'.split(' '),

  topics: {
    delivery: ['shipping', 'ship', 'shipped', 'delivery', 'deliver', 'delivered', 'dispatch', 'dispatched', 'postage'],
    returns: ['return', 'returns', 'returning'],
    refunds: ['refund', 'refunds', 'refunded'],
    payments: ['klarna', 'paypal', 'payment', 'pay', 'instalments', 'installments'],
    cancellations: ['cancel', 'cancelled', 'canceled', 'cancellation'],
    promotions: ['discount', 'discounts', 'coupon', 'offer', 'offers', 'deal', 'deals', 'voucher'],
    privacy: ['privacy', 'gdpr'],
  },
  topicCues: {
    personalData: ['personal data'],
    privacyChange: ['edit', 'change'],
    change: ['change', 'modify', 'update', 'edit'],
    orderOrAddress: ['address', 'order'],
    gift: ['gift'],
    giftOffer: ['order', 'offer'],
    address: ['address'],
    timeOrCost: ['time', 'cost'],
    shippingCost: ['cost', 'costs', 'threshold', 'free', 'fee', 'fees', 'charge', 'price'],
    shippingWhere: ['ship to', 'deliver to', 'countries', 'country', 'abroad', 'worldwide'],
    dispatch: ['dispatch', 'dispatched', 'processing'],
    deliveryTime: ['time', 'times', 'days', 'long'],
    deliveryTimeStrict: ['time', 'times', 'days', 'long'],
    deliveryWord: ['delivery'],
    precautions: ['eyes', 'safety'],
    suitability: ['pregnan', 'breastfeed', 'suitab'],
    warranty: ['warranty', 'guarantee'],
    claims: ['claims?', 'efficacy', 'proven', 'results?', 'effective'],
    returns: ['return', 'returned', 'opened'],
    usage: ['use', 'apply', 'morning', 'evening', 'night', 'sessions?', 'clean', 'charge', 'battery', 'manual'],
    abroad: ['abroad'],
    countryLead: ['in', 'for', 'to', 'and'],
  },
  countryAliases: { usa: 'US' },

  shopping: {
    cart: ['cart', 'basket', 'already', 'applied', 'discount', 'voucher', 'coupon'],
    stock: ['availab'],
    offerNouns: ['offers?', 'deals?'],
    areVerb: ['are\\s+'],
    available: ['availab'],
    buyVerbs: ['want', 'buy'],
    quantities: { two: 2, three: 3 },
    everything: ['cart', 'basket', 'everything'],
    offers: ['offer', 'deal', 'voucher', 'coupon', 'combin', 'stack', 'discount'],
    evaluate: ['cart', 'basket', 'combin', 'stack', 'missing', 'work', 'applied', 'discount', 'voucher', 'coupon'],
    codeFiller: ['IS', 'ISN', 'ISNT', 'DOES', 'DOESN', 'DOESNT', 'DID', 'DIDN', 'DIDNT', 'WON', 'WONT', 'NOT', 'WORK', 'WORKS', 'WORKING', 'THAT', 'THIS',
      'FOR', 'ON', 'IN', 'AT', 'IT', 'YOU', 'AND', 'OR', 'TO', 'WAS', 'WASN', 'CAN', 'CANNOT', 'CANT', 'WILL', 'STILL', 'ALSO'],
  },

  skin: ['skin', 'complexion', 'face', 'pores?', 'lips?', 'cheeks?', 'forehead', 'eyes?', 'hands?', 'body'],

  orderPrefix: ['no\\.?\\s*', 'order\\s*'],

  widget: {
    shopping: ['cart', 'basket', 'stock', 'availab', 'promo', 'offer', 'deal', 'voucher', 'coupon', 'discount', 'code', 'combin', 'stack', 'checkout'],
    discountAmount: ['\\d+\\s*(?:%|percent)', '\\b\\d+\\s*off\\b', '\\bpercent off\\b'],
    cartPage: ['they', 'them', 'these', 'adapt', 'suit'],
    cartPagePhrase: ['can you see'],
    cartAll: ['cart', 'basket', 'everything'],
    offerNouns: ['offers?', 'deals?'],
    areVerb: ['are\\s+'],
    available: ['availab'],
    offersNow: ['right now', 'currently', 'today'],
    currentOffers: ['current (offers|deals|promotions)'],
    eligibility: ['stack'],
    stock: ['stock', 'availab'],
    promo: ['discount'],
    order: ['orders?', 'parcels?', 'packages?'],
  },
};
