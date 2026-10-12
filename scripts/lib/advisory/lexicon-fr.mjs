/**
 * French skincare phrasing, as data for lexicon.mjs. Patterns run on `norm`
 * text: lower case, no accents, apostrophes as spaces (« j ai », « l oeil »).
 *
 * LANGUAGE, NOT BRAND. Every phrase is ordinary skincare French; the keys are
 * the config's vocabulary. lexicon-en.mjs has the same shape, and a test
 * holds the two to the same keys.
 */

/** « peau » then up to three words then the type: « peau déshydratée et mixte » is combination. */
const SKIN = String.raw`\bpeaux?\b(?: \w+){0,3}? `;

export default {
  code: 'fr',

  /** Words only French uses: they tell the language of a message. */
  markers: ['je', 'j', 'ai', 'est', 'et', 'le', 'la', 'un', 'on', 'peut', 'que', 'qui', 'ce', 'c', 'qu', 'sans', 'svp', 'avez', 'votre', 'vos', 'les', 'des', 'du', 'mon', 'ma', 'mes', 'une', 'pour', 'avec', 'pas', 'peau', 'quel', 'quelle', 'vous', 'nous', 'sur', 'dans', 'mais', 'tres', 'aussi', 'bonjour', 'merci', 'oui', 'yeux', 'visage', 'rides', 'creme', 'soin'],

  areas: {
    eyes: /\b(yeux|oeil|contour des yeux|contour de l oeil|regard|paupieres?|cernes?|poches?)\b/,
    body: /\b(corps|jambes?|bras|dos|apres la douche|peau du corps)\b/,
    face: /\b(visage|figure|front|joues?|menton)\b/
  },

  concerns: {
    deep_wrinkles: /\brides? (tres )?(profondes?|marquees?|installees?|prononcees?|creusees?)\b/,
    early_signs_of_ageing: /\b(premieres? rides?|premiers? signes?|ridules?|petites? rides?|debut de rides?|commence a avoir des rides?|rides? naissantes?|fines? lignes?)\b/,
    loss_of_density: /\b(perte de densite|peau (qui )?s amincit|manque de densite)\b/,
    loss_of_firmness: /\b(relachement|perte de fermete|manque de fermete|peau (qui )?se relache|affaissement|fermete|raffermir)\b/,
    facial_contours: /\b(ovale du visage|contours? du visage|double menton)\b/,
    loss_of_tone: /\b(perte de tonicite|manque de tonus|tonicite)\b/,
    global_signs_of_ageing: /\b(signes? de l age|vieillissement|anti ?age|peau vieillit|vieillir)\b/,
    mature_skin: /\b(peau mature|peaux matures)\b/,
    regeneration: /\b(regenerer|regeneration)\b/,
    wrinkles: /\b(rides?|anti ?rides?)\b/,
    dark_spots: /\b(taches?|hyperpigmentation|pigmentation|masque de grossesse|melasma)\b/,
    uneven_tone: /\b(teint (irregulier|inegal|brouille|pas uniforme|heterogene))\b/,
    redness: /\b(rougeurs?|couperose|rosacee|peau rouge)\b/,
    lack_of_radiance: /\b(manque d eclat|pas d eclat|sans eclat)\b/,
    dullness: /\b(teint terne|peau terne|terne|grise mine|mauvaise mine|bonne mine|eclat)\b/,
    dark_circles: /\b(cernes?)\b/,
    puffiness: /\b(poches?|yeux gonfles|gonflement)\b/,
    tired_skin: /\b(fatigu\w*|epuise\w*|manque de sommeil)\b/,
    dehydration: /\b(deshydrat\w*|manque d eau)\b/,
    tightness: /\b(tiraill\w*|ma peau tire|peau qui tire|sensation de tension|tire apres)\b/,
    discomfort: /\b(inconfort|picote(ments?)?|demange(aisons?)?|brule|chauffe)\b/,
    dryness: /\b(secheresse|peau qui pele|desquame|dessechee?|squames|rugueuse)\b/,
    clogged_pores: /\b(points? noirs?|pores? (dilates?|bouches?|obstrues?|visibles?)|pores?)\b/,
    imperfections: /\b(boutons?|imperfections?|acne)\b/,
    excess_sebum: /\b(sebum|exces de sebum)\b/,
    shine: /\b(brillances?|brille|luisante?|zone t grasse)\b/
  },

  skinTypes: {
    very_dry: new RegExp(`${SKIN}(tres|extremement|vraiment|super) seches?\\b`),
    dry: new RegExp(`${SKIN}seches?\\b|^ seches? $`),
    normal: new RegExp(`${SKIN}(normales?|equilibrees?)\\b|^ (normale|equilibree)s? $`),
    combination: new RegExp(`${SKIN}mixtes?\\b|^ mixtes? $`),
    oily: new RegExp(`${SKIN}grasses?\\b|^ grasses? $`)
  },

  men: /\b(homme|hommes|masculin|pour mon (mari|copain|compagnon|pere|fils|frere|conjoint)|je suis un homme|barbe|rasage)\b/,
  women: /\b(pour (ma|une) (femme|compagne|mere|fille|soeur|copine)|je suis une femme)\b/,

  sensitivity: {
    none: /\b(pas|non|plutot pas) (du tout )?(sensible|reactive)s?\b|\bpas de sensibilite\b/,
    reactive: /\b(peaux? ((tres|plutot|assez|un peu) )?reactives?|reagit|reactive)\b/,
    sensitive: /\b(sensibles?|sensibilite|intolerante?|irrite\w*)\b/
  },

  /** Each has an `item` group: the ingredient, as typed. */
  exclusions: [
    /\b(?:sans|pas de|pas d|allergique (?:a|au|aux)(?: l| la| le)?|j evite(?: le| la| les)?) (?<item>parfum|alcool|retinol|huiles? essentielles?|huile|silicones?|sulfates?|parabenes?|niacinamide|vitamine c|acide [a-z]+)\b/g
  ],

  routineNone: /\b(pas de routine|aucune routine|rien du tout|je n utilise rien|n utilise aucun)\b/,
  /** `clause`: what follows « j'utilise déjà », up to « mais ». */
  routineClause: /\b(?:j utilise (?:deja )?|j ai deja |ma routine (?:actuelle )?(?:c est |est |comprend )?|j applique (?:deja )?)(?<clause>.{0,120}?)(?:\bmais\b|$)/,
  routineSteps: {
    night_cream: /\bcreme de nuit\b/,
    eye_care: /\b(contour des yeux|creme (pour les )?yeux)\b/,
    cleanser: /\b(nettoyant|demaquillant|lait demaquillant|eau micellaire|mousse nettoyante|gel nettoyant|savon)\b/,
    serum: /\b(serum|elixir)\b/,
    lotion: /\b(lotion|tonique)\b/,
    mask: /\bmasques?\b/,
    moisturiser: /\b(creme|hydratant|creme de jour)\b/
  },

  wants: /\b(je cherche|je recherche|il me faut|je voudrais|j aimerais|je souhaite|besoin d|conseillez moi|recommandez moi|vous auriez|vous avez|quel(le)?s? (serait|serum|creme))\b/,
  desired: {
    serum: /\b(un|une|le|la|mon|ma) (serum|elixir)\b/,
    night_cream: /\b(une|la|ma) creme de nuit\b/,
    eye_care: /\b(un|le|mon) contour des yeux\b/,
    cleanser: /\b(un|une|le|la) (nettoyant|demaquillant)\b/,
    mask: /\b(un|le) masque\b/,
    moisturiser: /\b(une|la) (creme|creme de jour|creme hydratante)\b/
  },

  scope: {
    complete: /\b(routine complete|toute (une|la) routine|routine de a a z|routine entiere)\b/,
    complete_existing: /\b(completer (ma|mon) routine|ajouter a ma routine|en plus de (ma|mes))\b/,
    essential: /\b(routine (simple|essentielle|de base|minimale|rapide)|l essentiel|juste l essentiel)\b/,
    targeted: /\b(un seul (produit|soin)|juste un (produit|soin)|un soin cible|un produit cible)\b/
  },

  /** Group 1: the age in years. */
  age: [/\b(\d{2}) ans\b/],
  ageWords: [[/\bvingtaine\b/, 25], [/\btrentaine\b/, 35], [/\bquarantaine\b/, 45], [/\bcinquantaine\b/, 55], [/\b(soixantaine|septantaine)\b/, 65]],

  routineBuilder: /\b((construire|creer|composer|elaborer|monter|etablir|faire|me faire|m aider a (construire|creer|faire)) (ensemble )?(avec moi )?(ma|une|mon|la) ((nouvelle|vraie|bonne|petite) )?routine|routine builder|mode routine)\b/,
  dontKnow: /\b(je (ne )?sais pas|aucune idee|j en sais rien|pas sure?|je ne suis pas sure?)\b/
};
