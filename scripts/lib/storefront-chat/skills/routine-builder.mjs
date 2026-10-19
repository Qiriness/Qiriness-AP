/**
 * THE ROUTINE BUILDER SKILL (owner, 2026-10-13): what the model needs while it
 * builds a personalised routine, and nothing it does not.
 *
 *   instructions   the builder's guardrails, moved out of the always-on prompt
 *   tools          advise (the engine, routine mode), get_past_purchases
 *                  (signed in only)
 *   open           `mode === 'routine_builder'`: the routine offer's « Oui »,
 *                  the build_routine action, the lexicon's routine words, or the
 *                  model's use_skill
 *
 * What the model does NOT decide here: the routine offer, the purchase
 * question, the product built around, the treat (routine-flow.mjs) and the
 * products themselves (the engine). It converses and explains.
 */

export const GET_PAST_PURCHASES = 'get_past_purchases';

export const ROUTINE_BUILDER = {
  name: 'routine_builder',
  summary: 'build a personalised skincare routine with the customer, one question at a time',

  isActive: ({ mode } = {}) => mode === 'routine_builder',

  instructions: () => [
    '- You are building a personalised routine with the customer. The consultation engine chooses every product; ADVICE carries its steps, its one next_question and the profile. Call advise with what the customer tells you (profile_updates, scope).',
    '- One question per turn, the engine\'s next_question, in a few natural words; its buttons show the options. Never ask their sex; their age only when it is the engine\'s next_question (age_band: it chooses the line suited to their skin\'s age). Never ask anything already in the profile. First question: say in one short sentence that a few questions will make the routine better suited to them.',
    '- status recommended: present the steps in order, one short sentence each (the step named by its stage, the product, why it suits their skin type and concern, from reason_codes and product facts only; never their age, never a price). Put each step product in `products`, in order. Steps with time day are the morning routine, time night the evening one: the morning first, then the evening, each introduced in a few words; a skipped step also_in_day_routine is a morning product used in the evening too, said once, briefly. Never add a product, an ingredient, a benefit or a result that ADVICE does not give.',
    '- A step with customer_interest is the product they came for: say the routine is built around it. A skipped step already_owned is filled by their customer_product: say they can keep it, and recommend only the other steps. already_in_routine: they keep their own product for that step.',
    '- status waiting_for_follow_up: answer what they said in one or two sentences and ask nothing; the app asks next.',
    '- Purchases are the app\'s to ask about, never yours. just_answered: acknowledge their answer in a few words and go on. customer_said build_around: the routine is built around it. running_low: the app shows its card; never push a reorder. set_aside: leave it out. A purchase never tells you their skin type or concerns.',
    '- Treats (a « petit plaisir ») and the routine offer are the app\'s. Never offer either yourself.',
    '- get_past_purchases, when offered, lists what this signed-in customer bought before (products and days only): use it only to talk about those products, never as a profile.',
  ],

  /**
   * @param {{ adviseDefinition: object | null, signedIn: boolean }} ctx
   */
  tools: ({ adviseDefinition = null, signedIn = false } = {}) => [
    ...(adviseDefinition ? [adviseDefinition] : []),
    ...(signedIn ? [pastPurchasesDefinition()] : []),
  ],
};

function pastPurchasesDefinition() {
  return {
    type: 'function',
    function: {
      name: GET_PAST_PURCHASES,
      description: 'What this signed-in customer bought before on this store: product names, the day of the last purchase, counts, and what they said about each (build_around, running_low, set_aside). No order numbers, amounts or addresses.',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  };
}
