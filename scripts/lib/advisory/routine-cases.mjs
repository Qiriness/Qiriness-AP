/**
 * What the routine builder SHOULD do, on the invented routines and catalogue
 * (data/advisor/sample-routines/; docs/storefront-advisor-plan.md § 3.1–3.4
 * and § 4). `npm run advisor:score` runs the engine on each and reports what
 * passes. The failures are the optimisation list.
 *
 * Expectations are about product TYPES and the CONCERNS their products target,
 * never about a named product: a routine is built from products, each of a
 * type that targets a concern or a combination (owner, 2026-10-13).
 *
 *   message      what the customer says (the lexicon reads it, as in a chat)
 *   builder      true: the routine builder is open (« Oui » to the offer)
 *   owned        handles they said they build around (purchase « around »)
 *   expect
 *     foundation       one of these foundations (A–G, or men / eyes)
 *     status           recommended | needs_info
 *     steps            [min, max] products recommended
 *     types            product types the routine must include
 *     no_types         product types it must not include (already owned, wrong size)
 *     targets          [{ type, any: [concern keys] }]: that step's product targets one of them
 *     texture          { type, is }: that step's product texture
 *     every            'sensitive_ok' | 'men_first' | 'not_premium'
 *     no_handles       products never shown (out of stock, not advised)
 *     kit_first        the first product is a kit or a gift set
 *     no_treat         no treat is offered
 */

const both = (id, fr, en, rest) => [
  { id: `${id}.fr`, lang: 'fr', message: fr, ...rest },
  { id: `${id}.en`, lang: 'en', message: en, ...rest },
];

export const ROUTINE_CASES = [
  // § 4 — combined concerns: one foundation, the other concern fills a step.
  ...both('combined-concerns',
    "J'ai la peau du visage sèche, terne et je commence à avoir des rides, construisez-moi une routine",
    'My facial skin is dry, dull and I am starting to get wrinkles, build me a routine',
    { builder: true, expect: { foundation: ['A', 'E'], status: 'recommended', steps: [2, 3], types: ['serum', 'cream'], targets: [{ type: 'serum', any: ['wrinkles', 'fine_lines', 'dullness', 'dehydration'] }], texture: { type: 'cream', is: 'rich' } } }),

  // § 3.2 — the essential size by default: the first daily required steps, a cleanser among them.
  ...both('essential-default',
    'Je voudrais une routine pour mon visage déshydraté',
    'I would like a routine for my dehydrated face',
    { builder: true, expect: { foundation: ['A'], status: 'recommended', steps: [2, 3], types: ['cleanser', 'cream'] } }),

  // § 3.2 — complete: 4–5 daily steps.
  ...both('complete-sensitive',
    'Je veux une routine complète, mon visage a des rougeurs et réagit facilement',
    'I want a complete routine, my face gets red and reacts easily',
    { builder: true, expect: { foundation: ['C'], status: 'recommended', steps: [3, 5], types: ['cleanser', 'cream'], every: 'sensitive_ok' } }),

  // § 3.1 — skin type chooses the cream's texture.
  ...both('texture-oily',
    'Une routine pour les imperfections, j’ai la peau du visage grasse',
    'A routine for blemishes, my facial skin is oily',
    { builder: true, expect: { foundation: ['B'], status: 'recommended', types: ['cleanser', 'cream'], texture: { type: 'cream', is: 'light' }, targets: [{ type: 'cleanser', any: ['blemishes', 'excess_sebum', 'enlarged_pores'] }] } }),

  // § 3.1 — dark spots: an anti-spot serum, the SPF module proposed.
  ...both('dark-spots-spf',
    'Une routine complète contre les taches sur mon visage',
    'A complete routine against dark spots on my face',
    { builder: true, expect: { foundation: ['F'], status: 'recommended', types: ['serum', 'spf'], targets: [{ type: 'serum', any: ['dark_spots', 'uneven_tone'] }] } }),

  // § 4 — pre-existing products: only the missing steps (owner's rule: no doubling).
  ...both('owned-types',
    "J'ai le visage déshydraté et j'utilise déjà un nettoyant et une crème, que me manque-t-il ?",
    'My face is dehydrated and I already use a cleanser and a cream, what am I missing?',
    { builder: true, expect: { foundation: ['A'], status: 'recommended', no_types: ['cleanser', 'cream'], types: ['serum'] } }),

  // Owner's rule — an owned type is not doubled UNLESS the concern points to a specific product for that step.
  ...both('owned-but-concern-points',
    "J'ai déjà un sérum hydratant mais j'ai des taches sur le visage, construisez-moi une routine",
    'I already have a hydrating serum but I have dark spots on my face, build me a routine',
    { builder: true, expect: { foundation: ['F'], status: 'recommended', types: ['serum'], targets: [{ type: 'serum', any: ['dark_spots', 'uneven_tone'] }] } }),

  // Phase 2 — a product they build around fills its step, never sold again.
  ...both('built-around',
    'Je voudrais une routine pour mon visage déshydraté',
    'I would like a routine for my dehydrated face',
    { builder: true, owned: ['t-serum-aqua'], expect: { foundation: ['A'], status: 'recommended', no_types: ['serum'], no_handles: ['t-serum-aqua'] } }),

  // § 4 — one product only.
  ...both('one-product',
    'Juste un sérum pour les rides de mon visage',
    'Just a serum for the wrinkles on my face',
    { expect: { foundation: ['E'], status: 'recommended', steps: [1, 1], types: ['serum'], targets: [{ type: 'serum', any: ['wrinkles', 'fine_lines'] }] } }),

  // § 4 — the basic routine only on an explicit request.
  ...both('basic-explicit',
    'Je veux juste une routine de base pour mon visage',
    'I just want a basic routine for my face',
    { builder: true, expect: { foundation: ['G'], status: 'recommended', steps: [2, 2], types: ['cleanser', 'cream'], no_types: ['serum'] } }),

  // § 4 — « I don't know what I need »: one useful question, no routine.
  ...both('dont-know',
    "Je ne sais pas ce qu'il me faut",
    "I don't know what I need",
    { expect: { status: 'needs_info' } }),

  // § 4 — men: Hydration with men's products first.
  ...both('men-dry',
    'Je suis un homme, j’ai le visage sec, il me faut une routine',
    'I am a man with a dry face, I need a routine',
    { builder: true, expect: { foundation: ['A', 'men'], status: 'recommended', types: ['cream'], every: 'men_first', texture: { type: 'cream', is: 'rich' } } }),

  // § 4 — eye-only request: the eyes module alone.
  ...both('eyes-only',
    'Juste une crème contour des yeux pour mes cernes',
    'Just an eye cream for my dark circles',
    { expect: { foundation: ['eyes'], status: 'recommended', steps: [1, 1], types: ['eye'], targets: [{ type: 'eye', any: ['dark_circles', 'puffiness'] }] } }),

  // § 3.1 — the eyes module added to a complete routine when the concern calls for it.
  ...both('eyes-module-in-complete',
    "Une routine complète pour mon visage terne, et j'ai des cernes",
    'A complete routine for my dull face, and I have dark circles',
    { builder: true, expect: { foundation: ['D'], status: 'recommended', types: ['serum', 'eye'], targets: [{ type: 'serum', any: ['dullness', 'signs_of_fatigue'] }] } }),

  // § 4 — premium only when it is justified: not for « wrinkles » alone.
  ...both('premium-not-by-default',
    'Une routine anti-rides pour mon visage',
    'An anti-wrinkle routine for my face',
    { builder: true, expect: { foundation: ['E'], status: 'recommended', every: 'not_premium' } }),

  // § 4 — budget: the essential size, no treat.
  ...both('small-budget',
    "J'ai un petit budget, une routine pour mon visage déshydraté",
    'I have a small budget, a routine for my dehydrated face',
    { builder: true, expect: { foundation: ['A'], status: 'recommended', steps: [2, 3], no_treat: true } }),

  // § 3.4 — a gift: gift sets first.
  ...both('gift',
    "Je cherche un cadeau pour ma mère qui aime l'hydratation",
    'I am looking for a gift for my mother who loves hydration',
    { expect: { kit_first: true } }),

  // § 3.4 — a spa evening: the spa treat routine (exfoliant, masks).
  ...both('spa',
    'Je veux me faire une soirée spa à la maison',
    'I want a spa evening at home',
    { builder: true, expect: { types: ['mask'] } }),

  // § 3.2 — never pad, never show what is out of stock or not advised.
  ...both('never-pad-or-unavailable',
    'Une routine complète pour mon visage très sec',
    'A complete routine for my very dry face',
    { builder: true, expect: { foundation: ['A'], status: 'recommended', no_handles: ['t-serum-aqua-intense', 't-creme-retiree'], texture: { type: 'cream', is: 'rich' } } }),
];
