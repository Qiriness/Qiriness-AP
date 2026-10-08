/**
 * French (and a little English) phrasing → profile updates. Deterministic,
 * about a millisecond, before any model call: « J'ai la peau sèche et je
 * commence à avoir des rides » gives skin_type dry and primary concern
 * early_signs_of_ageing without a tool round.
 *
 * LANGUAGE, NOT BRAND. Every phrase here is ordinary skincare French; the
 * values it produces are the config's vocabulary keys, and an update whose
 * value the shop's config does not know is dropped by `mergeProfile`. What the
 * lexicon misses, the model adds through the `advise` tool's profile_updates.
 *
 * SPECIFIC BEFORE GENERAL, AND A MATCH CONSUMES ITS WORDS: « rides marquées »
 * is deep_wrinkles and does not also count as plain wrinkles.
 */

import { norm } from './text.mjs';

const EYE_WORDS = /\b(yeux|oeil|contour des yeux|contour de l oeil|regard|paupieres?|cernes?|poches?)\b/;
const BODY_WORDS = /\b(corps|jambes?|bras|dos|apres la douche|peau du corps)\b/;
const FACE_WORDS = /\b(visage|figure|front|joues?|menton)\b/;

/** [pattern, face concern, eye-area concern]. Order matters: specific first. */
const CONCERNS = [
  [/\brides? (tres )?(profondes?|marquees?|installees?|prononcees?|creusees?)\b/, 'deep_wrinkles', 'advanced_eye_wrinkles'],
  [/\b(premieres? rides?|premiers? signes?|ridules?|petites? rides?|debut de rides?|commence a avoir des rides?|rides? naissantes?|fines? lignes?)\b/, 'early_signs_of_ageing', 'early_signs'],
  [/\b(perte de densite|peau (qui )?s amincit|manque de densite)\b/, 'loss_of_density', null],
  [/\b(relachement|perte de fermete|manque de fermete|peau (qui )?se relache|affaissement|fermete|raffermir)\b/, 'loss_of_firmness', 'loss_of_firmness'],
  [/\b(ovale du visage|contours? du visage|double menton)\b/, 'facial_contours', null],
  [/\b(perte de tonicite|manque de tonus|tonicite)\b/, 'loss_of_tone', null],
  [/\b(signes? de l age|vieillissement|anti ?age|peau vieillit|vieillir)\b/, 'global_signs_of_ageing', 'mature_eye_area'],
  [/\b(peau mature|peaux matures)\b/, 'mature_skin', 'mature_eye_area'],
  [/\b(regenerer|regeneration)\b/, 'regeneration', null],
  [/\b(rides?|anti ?rides?|wrinkles?)\b/, 'wrinkles', 'eye_wrinkles'],
  [/\b(taches?|hyperpigmentation|pigmentation|masque de grossesse|melasma)\b/, 'dark_spots', null],
  [/\b(teint (irregulier|inegal|brouille|pas uniforme|heterogene))\b/, 'uneven_tone', null],
  [/\b(rougeurs?|couperose|rosacee|peau rouge)\b/, 'redness', null],
  [/\b(manque d eclat|pas d eclat|sans eclat)\b/, 'lack_of_radiance', null],
  [/\b(teint terne|peau terne|terne|grise mine|mauvaise mine|bonne mine|eclat|dull)\b/, 'dullness', null],
  [/\b(cernes?)\b/, 'dark_circles', 'dark_circles'],
  [/\b(poches?|yeux gonfles|gonflement)\b/, 'puffiness', 'puffiness'],
  [/\b(fatigu\w*|epuise\w*|manque de sommeil|tired)\b/, 'tired_skin', 'tired_eyes'],
  [/\b(deshydrat\w*|manque d eau|dehydrated)\b/, 'dehydration', null],
  [/\b(tiraill\w*|ma peau tire|peau qui tire|sensation de tension|tire apres)\b/, 'tightness', null],
  [/\b(inconfort|picote(ments?)?|demange(aisons?)?|brule|chauffe)\b/, 'discomfort', null],
  [/\b(secheresse|peau qui pele|desquame|dessechee?|squames|rugueuse)\b/, 'dryness', null],
  [/\b(points? noirs?|pores? (dilates?|bouches?|obstrues?|visibles?)|pores?)\b/, 'clogged_pores', null],
  [/\b(boutons?|imperfections?|acne|bouton|spots?|breakouts?)\b/, 'imperfections', null],
  [/\b(sebum|exces de sebum)\b/, 'excess_sebum', null],
  [/\b(brillances?|brille|luisante?|shiny|zone t grasse)\b/, 'shine', null]
];

/** « peau » then up to three words then the type: « peau déshydratée et mixte » is combination. */
const SKIN = String.raw`\bpeaux?\b(?: \w+){0,3}? `;
const SKIN_TYPES = [
  [new RegExp(`${SKIN}(tres|extremement|vraiment|super) seches?\\b`), 'very_dry'],
  [new RegExp(`${SKIN}seches?\\b|\\bdry skin\\b`), 'dry'],
  [new RegExp(`${SKIN}(normales?|equilibrees?)\\b|\\bnormal skin\\b`), 'normal'],
  [new RegExp(`${SKIN}mixtes?\\b|\\bcombination skin\\b|^ mixtes? $`), 'combination'],
  [new RegExp(`${SKIN}grasses?\\b|\\boily skin\\b`), 'oily']
];

const ROUTINE_STEPS = [
  [/\bcreme de nuit\b/, 'night_cream'],
  [/\b(contour des yeux|creme (pour les )?yeux)\b/, 'eye_care'],
  [/\b(nettoyant|demaquillant|lait demaquillant|eau micellaire|mousse nettoyante|gel nettoyant|savon)\b/, 'cleanser'],
  [/\b(serum|elixir)\b/, 'serum'],
  [/\b(lotion|tonique)\b/, 'lotion'],
  [/\bmasques?\b/, 'mask'],
  [/\b(creme|hydratant|moisturi[sz]er|creme de jour)\b/, 'moisturiser']
];

const DESIRED = [
  [/\b(un|une|le|la|mon|ma) (serum|elixir)\b/, 'serum'],
  [/\b(une|la|ma) creme de nuit\b/, 'night_cream'],
  [/\b(un|le|mon) contour des yeux\b/, 'eye_care'],
  [/\b(un|une|le|la) (nettoyant|demaquillant)\b/, 'cleanser'],
  [/\b(un|le) masque\b/, 'mask'],
  [/\b(une|la) (creme|creme de jour|creme hydratante)\b/, 'moisturiser']
];
const WANTS = /\b(je cherche|je recherche|il me faut|je voudrais|j aimerais|je souhaite|besoin d|conseillez moi|recommandez moi|vous auriez|vous avez|quel(le)?s? (serait|serum|creme))\b/;

const AGE_WORDS = [[/\b(vingtaine)\b/, 25], [/\b(trentaine)\b/, 35], [/\b(quarantaine)\b/, 45], [/\b(cinquantaine)\b/, 55], [/\b(soixantaine|septantaine)\b/, 65]];

export const ROUTINE_BUILDER = /\b(construire (ma|une) routine|creer (ma|une) routine|me faire une routine|composer (ma|une) routine|build (my|a) routine)\b/;
const DONT_KNOW = /\b(je (ne )?sais pas|aucune idee|j en sais rien|pas sure?|je ne suis pas sure?|i don t know|not sure)\b/;

export function ageBand(age) {
  if (!Number.isFinite(age) || age < 12 || age > 110) return null;
  return age < 30 ? 'under_30' : age < 45 ? '30_44' : age < 60 ? '45_59' : '60_plus';
}

/**
 * @param {string} message
 * @param {{ profile?: object, lastAsked?: string | null }} [context]
 * @returns {{ updates: { field: string, value: string, source: 'natural_language', confidence: string }[], routineBuilder: boolean }}
 */
export function extractProfile(message, { profile = {}, lastAsked = null } = {}) {
  let text = ` ${norm(message)} `;
  const updates = [];
  const add = (field, value, confidence = 'medium', extra = {}) => updates.push({ field, value, source: 'natural_language', confidence, ...extra });
  const consume = (re) => { text = text.replace(new RegExp(re.source, 'g'), ' '); };

  // « je ne sais pas » answers the question just asked, nothing else.
  if (lastAsked && DONT_KNOW.test(text)) add(lastAsked, 'unknown', 'high');

  // Area first: it decides which concern a word means (« rides » near « yeux »).
  const eyes = EYE_WORDS.test(text) && !FACE_WORDS.test(text);
  const body = BODY_WORDS.test(text);
  if (eyes) add('body_area', 'eyes', 'high');
  else if (body) add('body_area', 'body', 'high');
  else if (FACE_WORDS.test(text)) add('body_area', 'face', 'high');
  const eyeContext = eyes || (!body && !FACE_WORDS.test(text) && profile.body_area?.value === 'eyes');

  if (/\b(homme|hommes|masculin|pour mon (mari|copain|compagnon|pere|fils|frere|conjoint)|je suis un homme|barbe|rasage|for men|for my husband)\b/.test(text)) add('sex_target', 'men', 'high');
  else if (/\b(pour (ma|une) (femme|compagne|mere|fille|soeur|copine)|je suis une femme)\b/.test(text)) add('sex_target', 'women', 'high');

  if (/\b(pas|non|plutot pas) (du tout )?(sensible|reactive)s?\b|\bpas de sensibilite\b/.test(text)) {
    add('sensitivity', 'none', 'high');
    consume(/\b(pas|non|plutot pas) (du tout )?(sensible|reactive)s?\b|\bpas de sensibilite\b/);
  } else if (/\b(peaux? ((tres|plutot|assez|un peu) )?reactives?|reagit|reactive)\b/.test(text)) {
    add('sensitivity', 'reactive', 'high');
  } else if (/\b(sensibles?|sensibilite|intolerante?|irrite\w*|sensitive)\b/.test(text)) {
    add('sensitivity', 'sensitive', 'high');
  }

  for (const [re, value] of SKIN_TYPES) {
    // Not consumed: the window between « peau » and the type can hold a concern
    // (« peau déshydratée et mixte »).
    if (re.test(text)) { add('skin_type', value, 'high'); break; }
  }

  const exclusions = [...text.matchAll(/\b(?:sans|pas de|pas d|allergique (?:a|au|aux)(?: l| la| le)?|j evite(?: le| la| les)?) (parfum|alcool|retinol|huiles? essentielles?|huile|silicones?|sulfates?|parabenes?|niacinamide|vitamine c|acide [a-z]+)\b/g)].map((m) => m[1]);
  for (const word of new Set(exclusions)) add('known_exclusions', word, 'high');

  const routineClause = text.match(/\b(?:j utilise (?:deja )?|j ai deja |ma routine (?:actuelle )?(?:c est |est |comprend )?|j applique (?:deja )?|i use |i already use )(?<clause>.{0,120}?)(?:\bmais\b|$)/);
  if (/\b(pas de routine|aucune routine|rien du tout|je n utilise rien|n utilise aucun)\b/.test(text)) add('current_routine', 'none', 'high');
  else if (routineClause) {
    let clause = routineClause.groups.clause;
    for (const [re, kind] of ROUTINE_STEPS) if (re.test(clause)) { add('current_routine', kind, 'high'); clause = clause.replace(new RegExp(re.source, 'g'), ' '); }
    text = text.replace(routineClause[0], ' ');
  }

  if (WANTS.test(text)) {
    for (const [re, kind] of DESIRED) if (re.test(text)) { add('desired_care_type', kind, 'medium'); break; }
  }

  if (/\b(routine complete|toute (une|la) routine|routine de a a z|routine entiere|full routine)\b/.test(text)) add('routine_scope', 'complete', 'high');
  else if (/\b(completer (ma|mon) routine|ajouter a ma routine|en plus de (ma|mes))\b/.test(text)) add('routine_scope', 'complete_existing', 'high');
  else if (/\b(routine (simple|essentielle|de base|minimale|rapide)|l essentiel|juste l essentiel)\b/.test(text)) add('routine_scope', 'essential', 'high');
  else if (/\b(un seul (produit|soin)|juste un (produit|soin)|un soin cible|un produit cible|one product)\b/.test(text)) add('routine_scope', 'targeted', 'high');

  const age = text.match(/\b(\d{2}) ans\b/) ?? text.match(/\b(?:i am|i m) (\d{2})\b/);
  const band = age ? ageBand(Number(age[1])) : ageBand(AGE_WORDS.find(([re]) => re.test(text))?.[1]);
  if (band) add('age_band', band, 'high');

  const found = [];
  for (const [re, face, eye] of CONCERNS) {
    const m = text.match(re);
    if (!m) continue;
    const value = eyeContext && eye ? eye : face;
    if (value) found.push({ value, at: m.index });
    consume(re);
  }
  found.sort((a, b) => a.at - b.at);
  const hasPrimary = Boolean(profile.primary_concern?.value && profile.primary_concern.value !== 'unknown');
  found.forEach((c, i) => add(i === 0 && !hasPrimary ? 'primary_concern' : 'secondary_concerns', c.value, 'medium'));

  // Sensitivity said on its own is the concern: « j'ai la peau sensible ».
  const sens = updates.find((u) => u.field === 'sensitivity' && u.value !== 'none');
  if (sens && !found.length && !hasPrimary) add('primary_concern', sens.value === 'reactive' ? 'reactive_skin' : 'sensitivity', 'medium');

  // Dry skin on the body is a dryness concern: there is no « skin type » of the body.
  const st = updates.find((u) => u.field === 'skin_type');
  if (body && st && ['dry', 'very_dry'].includes(st.value) && !found.length && !hasPrimary) add('primary_concern', 'dryness', 'medium');

  return { updates, routineBuilder: ROUTINE_BUILDER.test(` ${norm(message)} `) };
}
