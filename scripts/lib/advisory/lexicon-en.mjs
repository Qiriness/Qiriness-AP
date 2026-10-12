/**
 * English skincare phrasing, as data for lexicon.mjs: the same shape and keys
 * as lexicon-fr.mjs. Patterns run on `norm` text: lower case, apostrophes as
 * spaces (« i m », « don t », « men s »).
 */

/** « skin » then up to three words: « my skin is very dry », « skin that gets oily ». */
const SKIN_IS = String.raw`\bskin (?:is |feels |gets |can be |tends to be |that is |that gets )(?:\w+ ){0,2}?`;
/** The type, then up to three words, then « skin »: « dry and dehydrated skin » is dry. */
const BEFORE_SKIN = String.raw`(?: \w+){0,3}? skin\b`;

export default {
  code: 'en',

  /** Words only English uses: they tell the language of a message. */
  /**
   * Words that carry nothing about the skin: what is left of a message once
   * these, the markers and every pattern are removed is what the lexicon did
   * NOT understand (`residue`), and sends the turn to the model reader.
   */
  fillers: ['where', 'start', 'begin', 'should', 'winter', 'summer', 'spring', 'autumn', 'fall', 'season', 'cold', 'hot', 'weather', 'detail', 'details', 'range', 'mode', 'suitable', 'adapted', 'what', 'how', 'which', 'love', 'like', 'really', 'very', 'so', 'quite', 'bit', 'little', 'lot', 'pretty', 'lately', 'recently', 'these', 'days', 'always', 'often', 'sometimes', 'usually', 'now', 'today', 'still', 'also', 'just', 'even', 'too', 'feel', 'feels', 'feeling', 'felt', 'get', 'gets', 'getting', 'got', 'seems', 'looks', 'look', 'become', 'becomes', 'been', 'be', 'has', 'had', 'kind', 'sort', 'since', 'because', 'when', 'after', 'before', 'during', 'there', 'they', 'them', 'their', 'its', 'im', 'ive', 'ok', 'okay', 'thank', 'thx', 'hey', 'good', 'great', 'morning', 'evening', 'night', 'time', 'times', 'bit', 'more', 'less', 'much', 'many', 'any', 'something', 'anything', 'product', 'products', 'routine', 'skincare', 'care', 'advice', 'recommend', 'suggest', 'tell', 'know', 'think', 'want', 'wanted', 'need', 'needs', 'use', 'using', 'used', 'try', 'tried', 'trying', 'one', 'ones', 'thing', 'things', 'way', 'than', 'then', 'here', 'there', 'could', 'should', 'will', 'was', 'were', 'did', 'didn', 'doesn', 'isn', 'not', 'no', 'an', 'a', 'in', 'on', 'at', 'by', 'or', 'but', 'if', 'as', 'from', 'up', 'out', 'all', 'mostly', 'mainly', 'especially', 'around', 'area', 'type', 'kind', 'build', 'together', 'show', 'give', 'find', 'choose', 'right', 'best', 'better'],

  markers: ['the', 'my', 'i', 'is', 'and', 'for', 'with', 'not', 'skin', 'what', 'which', 'you', 'your', 'have', 'do', 'does', 'can', 'it', 'of', 'to', 'any', 'help', 'please', 'hello', 'hi', 'thanks', 'yes', 'want', 'need', 'looking', 'eyes', 'face', 'wrinkles', 'cream', 'we', 'am', 'm', 'don', 'would', 'like', 'how', 'are', 'about', 'this', 'that', 'some'],

  areas: {
    eyes: /\b(eyes?|eye area|eye contour|under ?eyes?|eyelids?|eye bags|around (my|the) eyes)\b/,
    body: /\b(body|legs?|arms?|my back|after (the |a |my )?shower)\b/,
    face: /\b(face|facial|forehead|cheeks?|chin)\b/
  },

  concerns: {
    deep_wrinkles: /\b((deep|marked|pronounced|set in|established|deeper) (wrinkles?|lines)|wrinkles? (are|is) (very )?(deep|marked))\b/,
    early_signs_of_ageing: /\b((first|early) (wrinkles?|lines|signs( of (ageing|aging))?)|fine lines?|small wrinkles?|starting to (get|have|see|notice) (some )?(wrinkles?|lines))\b/,
    loss_of_density: /\b(loss of density|lack of density|thinning skin|skin (is )?thinning)\b/,
    loss_of_firmness: /\b(loss of firmness|lack of firmness|losing firmness|sagging|saggy|firmness|firming|firm up|laxity|loose skin)\b/,
    facial_contours: /\b(jawline|face contours?|facial contours?|double chin|face shape)\b/,
    loss_of_tone: /\b(loss of tone|lack of tone|losing tone)\b/,
    global_signs_of_ageing: /\b(signs of (ageing|aging)|anti ?(ageing|aging)|ageing|aging|getting older)\b/,
    mature_skin: /\bmature skin\b/,
    regeneration: /\b(regenerat\w+|skin renewal)\b/,
    wrinkles: /\b(wrinkles?|wrinkled|anti ?wrinkles?|crows? feet|expression lines)\b/,
    dark_spots: /\b((dark|age|sun|brown|pigment) spots?|hyperpigmentation|pigmentation|melasma)\b/,
    uneven_tone: /\b(uneven (skin )?(tone|complexion)|blotchy)\b/,
    redness: /\b(redness|red skin|red patches|rosacea|couperose|flushing)\b/,
    lack_of_radiance: /\b(lack of radiance|lacks radiance|no radiance|lack of glow|no glow)\b/,
    dullness: /\b(dull( skin| complexion)?|dullness|lacklust(re|er)|radiance|glow)\b/,
    dark_circles: /\b(dark circles?|under ?eye circles?)\b/,
    puffiness: /\b(puffiness|puffy( eyes)?|eye bags|bags under (my |the )?eyes|swelling|swollen)\b/,
    tired_skin: /\b(tired|fatigued?|exhausted|lack of sleep)\b/,
    dehydration: /\b(dehydrat\w*|lacks? (water|moisture|hydration)|thirsty skin)\b/,
    tightness: /\b(tightness|(feels?|feeling|gets?|getting|is|so|very|really) (\w+ )?tight|tight skin|pulling)\b/,
    discomfort: /\b(discomfort|uncomfortable|itch\w*|sting\w*|tingl\w*|burning)\b/,
    dryness: /\b(dryness|flaky|flaking|peeling|rough skin)\b/,
    clogged_pores: /\b(blackheads?|(enlarged|clogged|visible|large|open|blocked) pores?|pores?)\b/,
    imperfections: /\b(blemish\w*|imperfections?|acne|pimples?|spots?|breakouts?|zits?)\b/,
    excess_sebum: /\b(sebum|excess (oil|sebum)|too much oil)\b/,
    shine: /\b(shine|shiny|shininess|greasy|oily t ?zone|t ?zone)\b/
  },

  skinTypes: {
    very_dry: new RegExp(String.raw`\b(very|extremely|really|super) dry${BEFORE_SKIN}|${SKIN_IS}(very|extremely|really|super) dry\b`),
    dry: new RegExp(String.raw`\bdry${BEFORE_SKIN}|${SKIN_IS}dry\b|^ dry $`),
    normal: new RegExp(String.raw`\b(normal|balanced)${BEFORE_SKIN}|${SKIN_IS}(normal|balanced)\b|^ (normal|balanced) $`),
    combination: new RegExp(String.raw`\bcombination${BEFORE_SKIN}|${SKIN_IS}combination\b|^ combination $`),
    oily: new RegExp(String.raw`\boily${BEFORE_SKIN}|${SKIN_IS}oily\b|^ oily $`)
  },

  men: /\b(for men|men s|mens|male|for (a|my) (man|husband|boyfriend|father|dad|son|brother)|i m a (man|guy)|i am a (man|guy)|beard|shaving)\b/,
  women: /\b(for (my|a) (wife|girlfriend|mother|mum|mom|daughter|sister)|i m a woman|i am a woman)\b/,

  sensitivity: {
    none: /\b(not (at all |really |very )?(sensitive|reactive)|no sensitivity)\b/,
    reactive: /\b(reactive|reacts (easily|quickly|badly)?)\b/,
    sensitive: /\b(sensitive|sensitivity|intolerant|irritat\w*)\b/
  },

  exclusions: [
    /\b(?:without|no|free from|free of|allergic to|i avoid|avoid|i can t use|can t use|cannot use) (?<item>fragrance|perfume|parfum|alcohol|retinol|essential oils?|oils?|silicones?|sulfates?|sulphates?|parabens?|niacinamide|vitamin c|[a-z]+ acid)\b/g,
    /\b(?<item>fragrance|perfume|alcohol|paraben|sulfate|sulphate|silicone|oil) free\b/g
  ],

  routineNone: /\b(no routine|don t have a routine|do not have a routine|nothing at all|i don t use anything|i use nothing|i don t use any)\b/,
  routineClause: /\b(?:i (?:already )?use |i m (?:already )?using |i already have |my (?:current )?routine (?:is |includes |has )?)(?<clause>.{0,120}?)(?:\bbut\b|$)/,
  routineSteps: {
    night_cream: /\bnight cream\b/,
    eye_care: /\b(eye (cream|contour|care|serum))\b/,
    cleanser: /\b(cleanser|cleansing (gel|milk|foam|oil)|face wash|micellar water|make ?up remover|soap)\b/,
    serum: /\b(serum|elixir)\b/,
    lotion: /\b(toner|lotion|essence)\b/,
    mask: /\b(face )?masks?\b/,
    moisturiser: /\b(moisturi[sz]er|cream|day cream|face cream)\b/
  },

  wants: /\b(i m looking for|looking for|i need|i want|i d like|i would like|can you recommend|could you recommend|recommend me|do you have|which (serum|cream))\b/,
  desired: {
    serum: /\b(a|the|my) (serum|elixir)\b/,
    night_cream: /\b(a|the|my) night cream\b/,
    eye_care: /\b(an|the|my) eye (cream|contour|care|serum)\b/,
    cleanser: /\b(a|the|my) (cleanser|face wash|make ?up remover)\b/,
    mask: /\b(a|the|my) (face )?mask\b/,
    moisturiser: /\b(a|the|my) (moisturi[sz]er|cream|day cream|face cream)\b/
  },

  scope: {
    complete: /\b((full|complete|whole|entire) (skin ?care )?routine|routine from a to z)\b/,
    complete_existing: /\b((complete|add to|complement|round out) my routine|on top of my)\b/,
    essential: /\b((simple|basic|essential|minimal|quick|easy) (skin ?care )?routine|just the (essentials|basics))\b/,
    targeted: /\b((one|a single|just one) (product|treatment)|targeted (product|treatment|care))\b/
  },

  age: [/\b(?:i am|i m|im) (\d{2})\b/, /\b(\d{2}) (?:years? old|yo|y o)\b/],
  ageWords: [[/\b(twenties|20s)\b/, 25], [/\b(thirties|30s)\b/, 35], [/\b(forties|40s)\b/, 45], [/\b(fifties|50s)\b/, 55], [/\b(sixties|seventies|60s|70s)\b/, 65]],

  routineBuilder: /\b((build|create|make|put together|design|set up|help me (build|create|make|put together)) (me )?(together )?(a |an |my |our )?((full|complete|whole|personali[sz]ed|daily|new|skin ?care) )*routine|routine builder)\b/,
  dontKnow: /\b(i don t know|i do not know|no idea|not sure|dunno|i m not sure)\b/
};
