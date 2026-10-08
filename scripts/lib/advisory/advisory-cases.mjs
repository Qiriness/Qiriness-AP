/**
 * The consultation's French test set, run on the LIVE catalogue by
 * `npm run eval:advisory` (free: no model). Each case is a conversation —
 * messages and chip answers — and what the engine must conclude.
 *
 *   expect.playbook   the playbook key chosen
 *   expect.question   the field asked next (null = no question)
 *   expect.products   a regex per step product, in order (name match)
 *   expect.not        regexes no recommended product may match
 *   expect.profile    profile values that must be set
 *
 * Products are matched by NAME pattern, never by id: the cases survive a
 * re-sync and read as the adviser would say them.
 */

export const ADVISORY_CASES = [
  // --- extraction + direct recommendation (conversation mode) ---
  { name: 'dry skin + first wrinkles → radiance, Active Énergie serum', turns: ["J'ai la peau sèche et je commence à avoir des rides"], expect: { playbook: 'face_radiance_energy', question: null, profile: { skin_type: 'dry', primary_concern: 'early_signs_of_ageing' }, products: [/Active Énergie/] } },
  { name: 'wrinkles alone are ambiguous: firmness or global anti-age', turns: ["J'ai des rides et la peau sèche"], expect: { question: 'primary_concern', options: ['loss_of_firmness', 'global_signs_of_ageing'] } },
  { name: 'the ambiguity answered by chip → global anti-age, rich Temps Sublime', turns: ["J'ai des rides et la peau sèche", { choice: 'profile:primary_concern:global_signs_of_ageing' }, { choice: 'profile:routine_scope:essential' }], expect: { playbook: 'face_global_anti_age', products: [/Temps Sublime/, /Temps Sublime Riche/] } },
  { name: 'oily + shine → oily playbook, light texture', turns: ['Peau grasse avec des brillances et des boutons, une routine simple'], expect: { playbook: 'face_oily_imperfections', not: [/Riche/] } },
  { name: '62 with a dull complexion → radiance, not advanced (age never selects)', turns: ["J'ai 62 ans et le teint terne"], expect: { playbook: 'face_radiance_energy', not: [/Exception/] } },
  { name: 'deep wrinkles → advanced (Exception)', turns: ['Rides marquées, je voudrais une routine essentielle'], expect: { playbook: 'face_advanced_anti_age', products: [/Exception/, /Exception/] } },
  { name: 'dark spots with cleanser + cream already → only the missing step', turns: ["J'ai des taches, j'utilise déjà un nettoyant et une crème, je veux compléter ma routine"], expect: { playbook: 'face_dark_spots', notSlots: ['moisturiser'] } },
  { name: 'sensitive + tightness → sensitive comfort, Sensi Zen', turns: ['Ma peau est sensible et tiraille'], expect: { playbook: 'face_sensitive_comfort', products: [/Sensi Zen/] } },
  { name: 'combination + dehydrated → hydration with the light Source d\'Eau', turns: ['Peau déshydratée et mixte, une routine essentielle'], expect: { playbook: 'face_hydration', products: [/Élixir Source d'Eau/, /Voile Source d'Eau/] } },
  { name: 'dry + dehydrated → rich Source d\'Eau', turns: ['Peau très sèche et déshydratée, une routine essentielle'], expect: { playbook: 'face_hydration', products: [/Élixir Source d'Eau/, /Source d'Eau Riche/] } },
  { name: 'dark circles → eye advisor, eye product only', turns: ["J'ai des cernes"], expect: { playbook: 'eye_advisor', products: [/Yeux|Regard/] } },
  { name: 'body dryness → body playbook, no face product', turns: ['Peau sèche sur le corps'], expect: { playbook: 'body_hydration', products: [/Corps/] } },

  // --- men (rules 4 and 5) ---
  { name: 'explicit men + hydration → men\'s products only', turns: ['Une crème pour homme, peau sèche et déshydratée'], expect: { playbook: 'men_face', products: [/Homme/], profile: { sex_target: 'men' } } },
  { name: 'men anti-age → the men\'s anti-age cream', turns: ['Je suis un homme, j\'ai des rides'], expect: { playbook: 'men_face', products: [/Anti-Âge Homme/] } },
  { name: 'no target → never a men\'s product', turns: ['Peau sèche et déshydratée, routine complète'], expect: { not: [/Homme/] } },

  // --- questions (routine builder) ---
  { name: 'routine builder with nothing known asks the concern', turns: [{ message: 'Construire ma routine', action: 'build_routine' }], expect: { question: 'primary_concern' } },
  { name: 'dehydration is face or body: the builder asks the area', turns: [{ message: 'Construire ma routine', action: 'build_routine' }, { choice: 'profile:primary_concern:dehydration' }], expect: { question: 'body_area' } },
  { name: 'routine builder asks skin type when it changes the cream', turns: [{ message: 'Construire ma routine', action: 'build_routine' }, { choice: 'profile:primary_concern:dehydration' }, { choice: 'profile:body_area:face' }], expect: { question: 'skin_type' } },
  { name: 'a question is never asked twice', turns: [{ message: 'Construire ma routine', action: 'build_routine' }, { choice: 'profile:primary_concern:dehydration' }, { choice: 'profile:body_area:face' }, { choice: 'profile:skin_type:unknown' }], expect: { notQuestion: 'skin_type' } },
  { name: 'routine builder ends in a routine', turns: [{ message: 'Construire ma routine', action: 'build_routine' }, { choice: 'profile:primary_concern:dehydration' }, { choice: 'profile:body_area:face' }, { choice: 'profile:skin_type:dry' }, { choice: 'profile:sensitivity:none' }, { choice: 'profile:current_routine:none' }, { choice: 'profile:routine_scope:essential' }, { choice: 'profile:age_band:30_44' }], expect: { playbook: 'face_hydration', status: 'recommended' } },
  { name: 'natural language mid-builder is not re-asked', turns: [{ message: 'Construire ma routine', action: 'build_routine' }, 'Plutôt des taches, et ma peau est mixte'], expect: { notQuestion: 'skin_type', profile: { skin_type: 'combination', primary_concern: 'dark_spots' } } }
];
