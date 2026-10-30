/**
 * German skincare phrasing, as data for lexicon.mjs: the same shape and keys as fr/lexicon.mjs.
 * Patterns run on `norm` text: lower case, umlauts without their dots (« mude », « fur »), « ß » as
 * « ss » (« weiss »). Compounds are common (« Augenfalten », « Gesichtsmaske »): a pattern allows the
 * word before where it matters.
 *
 * EVERY TABLE RUNS ON EVERY MESSAGE: no word here may also be an everyday French or English word.
 * Written 2026-10-30, not yet reviewed by a native speaker (VALIDATION_LOG).
 */

/** « Haut » then up to two words: « meine Haut ist sehr trocken », « Haut wird fettig ». */
const SKIN_IS = String.raw`\b(?:haut|gesichtshaut|gesicht) (?:ist |wird |fuhlt sich |ist eher |ist oft )?(?:\w+ ){0,2}?`;
/** The type, then up to two words, then « Haut »: « trockene und empfindliche Haut ». */
const BEFORE_SKIN = String.raw`(?: \w+){0,2}? (?:haut|gesichtshaut)\b`;

export default {
  code: 'de',

  /** Words that carry nothing about the skin (see en/lexicon.mjs `fillers`). */
  fillers: ['winter', 'sommer', 'fruhling', 'herbst', 'jahreszeit', 'kalt', 'warm', 'wetter', 'liebe', 'mag', 'gerne', 'gern', 'linie', 'serie', 'detail', 'details', 'geeignet', 'passend', 'sehen', 'anfangen', 'was', 'wie', 'wo', 'welche', 'welches', 'welcher', 'wirklich', 'zu', 'sehr', 'ziemlich', 'etwas', 'bisschen', 'viel', 'oft', 'immer', 'manchmal', 'seit', 'zeit', 'letzter', 'zuletzt', 'heute', 'tage', 'tag', 'alle', 'alles', 'morgens', 'abends', 'nachts', 'noch', 'eher', 'auch', 'also', 'gut', 'ja', 'nein', 'weil', 'wenn', 'nach', 'vor', 'wahrend', 'fuhlt', 'fuhle', 'scheint', 'wird', 'bleibt', 'bin', 'ist', 'sind', 'sein', 'haben', 'habe', 'hat', 'hatte', 'gemacht', 'machen', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'und', 'oder', 'aber', 'mit', 'fur', 'von', 'zum', 'zur', 'im', 'in', 'an', 'am', 'auf', 'bei', 'aus', 'um', 'ich', 'mir', 'mich', 'mein', 'meine', 'meiner', 'meinen', 'sie', 'ihr', 'es', 'nicht', 'kein', 'keine', 'mehr', 'weniger', 'produkt', 'produkte', 'routine', 'pflege', 'rat', 'tipp', 'empfehlen', 'empfehlung', 'will', 'mochte', 'brauche', 'benutze', 'verwende', 'probiert', 'kann', 'konnen', 'konnten', 'wissen', 'weiss', 'bereich', 'typ', 'art', 'zusammenstellen', 'zusammen', 'finden', 'wahlen', 'beste', 'besser', 'hallo', 'danke', 'bitte', 'vor', 'allem', 'hauptsachlich', 'rund', 'dieses', 'diese', 'dieser'],

  markers: ['ich', 'habe', 'meine', 'mein', 'meiner', 'haut', 'und', 'ist', 'nicht', 'ein', 'eine', 'einen', 'fur', 'mit', 'die', 'der', 'das', 'sehr', 'auch', 'bitte', 'danke', 'gesicht', 'augen', 'falten', 'sie', 'haben', 'welche', 'welches', 'wie', 'gibt', 'mochte', 'brauche', 'suche', 'trockene', 'oder', 'aber', 'kann', 'konnen', 'zu', 'auf', 'bei', 'mir', 'mich'],

  areas: {
    eyes: /\b(augen|auge|augenpartie|augenbereich|augenkontur|lider|augenlider|unter den augen|um die augen|augenringe|tranensacke)\b/,
    hands: /\b(hande|handrucken|nagelhaut)\b/,
    lips: /\b(lippen|lippe)\b/,
    feet: /\b(fusse|fuss|fersen?)\b/,
    body: /\b(korper|beine|bein|arme|rucken|ellbogen|knie|korperhaut)\b/,
    face: /\b(gesicht|gesichtshaut|stirn|wangen|wange|kinn)\b/
  },

  concerns: {
    deep_wrinkles: /\b((tiefe|ausgepragte|starke) (falten|furchen)|falten sind (sehr )?tief)\b/,
    early_signs_of_ageing: /\b(erste (falten|faltchen|anzeichen)|faltchen|feine linien|kleine falten|trockenheitsfaltchen)\b/,
    loss_of_density: /\b((verlust|mangel) an (dichte|hautdichte)|dunne haut|haut wird dunner)\b/,
    loss_of_firmness: /\b((verlust|mangel) an (festigkeit|spannkraft|elastizitat)|erschlafft\w*|schlaff\w*|festigkeit|straff\w*|spannkraft)\b/,
    facial_contours: /\b(gesichtskontur\w*|doppelkinn|kinnlinie)\b/,
    loss_of_tone: /\b((verlust|mangel) an tonus)\b/,
    global_signs_of_ageing: /\b(zeichen der hautalterung|hautalterung|alterung|alter werden|altert)\b/,
    mature_skin: /\b(reife haut)\b/,
    regeneration: /\b(regenerier\w*|regenerati\w*|hauterneuerung)\b/,
    wrinkles: /\b(falten|faltig\w*|anti ?falten|krahenfusse|mimikfalten|\w+falten)\b/,
    // The marks a spot leaves are spots, not blemishes (owner's notes v4).
    dark_spots: /\b((akne|pickel)(narben|male|flecken)|narben von (alten )?(pickeln|akne)|pigmentflecken|altersflecken|dunkle flecken|flecken|hyperpigmentierung|pigmentierung|melasma)\b/,
    uneven_tone: /\b(ungleichmassig\w* (teint|hautton|hautbild)|fleckige haut)\b/,
    redness: /\b(rotung\w*|gerotet\w*|rote haut|couperose|rosazea)\b/,
    irritation: /\b(irritation\w*|irritiert\w*|gereizt\w*)\b/,
    lack_of_radiance: /\b((mangel an|kein|keine|ohne) (strahlkraft|ausstrahlung))\b/,
    dullness: /\b(fahl\w*|stumpf\w*|glanzlos\w*|grauer teint|strahlkraft|ausstrahlung)\b/,
    dark_circles: /\b(augenringe|dunkle ringe|schatten unter den augen)\b/,
    puffiness: /\b(tranensacke|geschwollene augen|schwellung\w*|aufgedunsen\w*)\b/,
    tired_skin: /\b(mude|mudigkeit|erschopft\w*|abgespannt\w*|schlafmangel|zu wenig schlaf)\b/,
    dehydration: /\b(dehydrier\w*|feuchtigkeitsarm\w*|feuchtigkeitsmangel|mangel an feuchtigkeit|durstige haut)\b/,
    tightness: /\b(spannungsgefuhl|haut spannt|spannt)\b/,
    discomfort: /\b(unbehagen|juck\w*|brenn\w*|kribbel\w*)\b/,
    // A dry hand, lip, foot or body part: no skin type of the face (« sehr trockene Hände », « rissige Lippen »).
    dryness: /\b(trockenheit|schuppig\w*|rissig\w*|aufgesprungen\w*|sprode\w*|(trockene|raue|rissige) (hande|lippen|fusse|fersen|ellbogen|knie|beine)|(hande|lippen|fusse|fersen|ellbogen|knie|beine|korper)( \w+){0,2}? (trocken|rau|rissig))\b/,
    clogged_pores: /\b(mitesser\w*|(vergrosserte|verstopfte|grosse|sichtbare|offene) poren|poren)\b/,
    imperfections: /\b(pickel|unreinheit\w*|hautunreinheit\w*|akne|pusteln|unreine haut)\b/,
    excess_sebum: /\b(talg|uberschussiger talg|talgproduktion)\b/,
    shine: /\b(glanzt|glanzend\w*|fettglanz|t zone)\b/
  },

  skinTypes: {
    very_dry: new RegExp(String.raw`\b(sehr|extrem|super|wirklich) trocken\w*${BEFORE_SKIN}|${SKIN_IS}(sehr|extrem|super|wirklich) trocken\b`),
    dry: new RegExp(String.raw`\btrocken\w*${BEFORE_SKIN}|${SKIN_IS}trocken\b|^ trocken $`),
    normal: new RegExp(String.raw`\b(normal|ausgeglichen)\w*${BEFORE_SKIN}|${SKIN_IS}(normal|ausgeglichen)\b`),
    combination: new RegExp(String.raw`\b(mischhaut|kombinierte haut)\b|^ mischhaut $`),
    oily: new RegExp(String.raw`\b(fettig|olig)\w*${BEFORE_SKIN}|${SKIN_IS}(fettig|olig)\b|^ fettig $`)
  },

  men: /\b(fur (manner|herren|den mann)|manner|herren|mannlich|fur meinen (mann|freund|partner|vater|sohn|bruder)|ich bin ein mann|bart|rasur)\b/,
  women: /\b(fur meine (frau|freundin|partnerin|mutter|tochter|schwester)|ich bin eine frau)\b/,

  sensitivity: {
    none: /\b(nicht (sehr |besonders |so )?(empfindlich|sensibel|reaktiv)|keine empfindlichkeit)\b/,
    reactive: /\b(reaktiv\w*|reagiert (schnell|leicht|stark)?)\b/,
    sensitive: /\b(empfindlich\w*|sensibel\w*|unvertraglich\w*|irritier\w*)\b/
  },

  /** Each has an `item` group: the ingredient, as typed. */
  exclusions: [
    /\b(?:ohne|kein|keine|allergisch gegen|ich vermeide|vertrage kein\w*) (?<item>parfum|duftstoffe?|alkohol|retinol|atherische ole|ole|ol|silikone?|sulfate?|parabene?|niacinamid|vitamin c|\w+saure)\b/g,
    /\b(?<item>parfum|duftstoff|alkohol|silikon|paraben|sulfat|ol)frei\b/g
  ],

  ingredients: {
    fragrance: ['parfum', 'duftstoff', 'duftstoffe'],
    alcohol: ['alkohol'],
    retinol: ['retinol'],
    essential_oils: ['atherische ole', 'atherisches ol'],
    oil: ['ol', 'ole'],
    silicones: ['silikon', 'silikone'],
    sulfates: ['sulfat', 'sulfate'],
    parabens: ['paraben', 'parabene'],
    niacinamide: ['niacinamid'],
    vitamin_c: ['vitamin c'],
    salicylic_acid: ['salicylsaure'],
    glycolic_acid: ['glykolsaure'],
    hyaluronic_acid: ['hyaluronsaure'],
    lactic_acid: ['milchsaure'],
    azelaic_acid: ['azelainsaure'],
  },

  routineNone: /\b(keine routine|habe keine routine|benutze nichts|verwende nichts|gar nichts)\b/,
  /** `clause`: what follows « ich benutze schon », up to « aber ». */
  routineClause: /\b(?:ich benutze (?:schon |bereits )?|ich verwende (?:schon |bereits )?|ich habe (?:schon |bereits )|meine (?:aktuelle )?routine (?:ist |besteht aus |enthalt )?)(?<clause>.{0,120}?)(?:\baber\b|$)/,
  routineSteps: {
    night_cream: /\b(nachtcreme|nachtpflege)\b/,
    eye_care: /\b(augencreme|augenpflege|augenserum)\b/,
    cleanser: /\b(reinigung\w*|mizellenwasser|abschminktuch|make ?up entferner|seife|waschgel)\b/,
    serum: /\b(serum|elixier)\b/,
    lotion: /\b(tonic|gesichtswasser|essenz)\b/,
    mask: /\b\w*masken?\b/,
    moisturiser: /\b(tagescreme|gesichtscreme|feuchtigkeitscreme|feuchtigkeitspflege)\b/
  },

  // « mein Hauptproblem sind Falten »: the concern they name is the main one.
  // « was kann ich gegen Falten tun », « wie werde ich Pigmentflecken los »: asking for a concern.
  asksFor: /\b(was (kann|soll|sollte) ich (tun|machen|nehmen|benutzen|verwenden)|wie (werde ich|bekomme ich|kann ich|behandle ich|reduziere ich)|etwas (gegen|fur)|ein (produkt|mittel) (gegen|fur)|und (fur|was ist mit)|was hilft (gegen|bei)|was ist mit)\b/,
  additive: /\b(auch|ausserdem|zusatzlich|dazu noch|ebenfalls)\b/,
  concernIs: /\b((mein )?(haupt)?(problem|anliegen|sorge) (ist|sind)|hauptproblem (ist|sind))\b/,
  wants: /\b(ich suche|suche|ich brauche|ich mochte|ich will|ich hatte gern|haben sie|habt ihr|gibt es|konnen sie (mir )?empfehlen|empfehlen sie|welches? (serum|creme))\b/,
  desired: {
    serum: /\b(ein|das|mein) (serum|elixier)\b/,
    night_cream: /\b(eine|die|meine) nachtcreme\b/,
    eye_care: /\b(eine|die|meine) (augencreme|augenpflege)\b/,
    cleanser: /\b(ein|eine|das|die|mein|meine) (reinigungsgel|reinigung|reinigungsmilch|make ?up entferner)\b/,
    exfoliant: /\b(peeling\w*|exfoli\w*)\b/,
    mask: /\b(eine|die|meine) \w*maske\b/,
    moisturiser: /\b(eine|die|meine) (creme|tagescreme|gesichtscreme|feuchtigkeitscreme)\b/
  },

  scope: {
    complete: /\b(komplette routine|vollstandige routine|ganze routine|routine von a bis z)\b/,
    complete_existing: /\b(meine routine (erganzen|vervollstandigen)|zu meiner routine)\b/,
    essential: /\b((einfache|grundlegende|minimale|schnelle|kurze) routine|nur das notigste|nur die basics)\b/,
    targeted: /\b(ein einziges produkt|nur ein produkt|gezielte pflege|gezieltes produkt)\b/
  },

  routineTime: {
    both: /\b(morgens und abends|abends und morgens|tag und nacht|nacht und tag|beide routinen)\b/,
    day: /\b(morgenroutine|tagesroutine|routine (fur den |am )morgen)\b/,
    night: /\b(abendroutine|nachtroutine|routine (fur den |am )abend|vor dem schlafen(gehen)?)\b/
  },

  requests: {
    basic_routine: /\b(basisroutine|grundroutine|nur die grundlagen)\b/,
    gift: /\b(geschenk\w*|zum verschenken|geburtstag|muttertag|vatertag|weihnacht\w*|valentinstag)\b/,
    spa: /\b(spa abend|wellness ?abend|spa zu hause|home spa|mich verwohnen)\b/
  },
  moreOptions: /\b(etwas anderes|andere (optionen|produkte|vorschlage|alternativen)|ein anderes produkt|eine andere (option|alternative)|was noch|sonst noch etwas|alternativen)\b/,
  budgetSmall: /\b(kleines budget|knappes budget|begrenztes budget|gunstig\w*|preiswert\w*|billig\w*|nicht zu teuer|zu teuer|(etwas|ziemlich|sehr|so) teuer|kostet zu viel|kann ich mir nicht leisten|uber meinem budget|ausserhalb meines budgets)\b/,
  budgetAmount: [
    /\b(?:unter|weniger als|hochstens|maximal|max|bis zu|budget von|budget ist)\s(\d{1,4})\b(?! (?:jahre?n?|ml|tage?n?|wochen|monate?n?|minuten|min|stunden|mal|produkte?|schritte?|years?|days?|weeks?|months?|ans?|jours?|mois))/,
    /\b(\d{1,4}) (?:euro )?(?:max|maximal|hochstens)\b/
  ],

  /** Group 1: the age in years. */
  age: [/\bich bin (\d{2})\b/, /\b(\d{2}) jahre\b/],
  ageWords: [[/\b(zwanziger|zwanzig)\b/, 25], [/\b(dreissiger|dreissig)\b/, 35], [/\b(vierziger|vierzig)\b/, 45], [/\b(funfziger|funfzig)\b/, 55], [/\b(sechziger|siebziger|sechzig|siebzig)\b/, 65]],

  routineWord: /\b(\w*routinen?|ritual\w*|pflegeplan|(von )?morgens bis abends|tag und nacht)\b/,
  routineAsk: /\b(ich mochte|ich will|ich hatte gern|ich suche|ich brauche|suche|brauche|konnen sie mir|konnt ihr mir|empfehlen sie mir|schlagen sie mir|haben sie) (eine |einen |ein )?((neue|einfache|gute|komplette|vollstandige|personliche|personalisierte|tagliche)\s){0,3}(\w*routine|ritual)\b/,
  routineBuilder: /\b(\w*routine (zusammenstellen|erstellen|aufbauen|bauen)|(stell|stellen sie|erstelle|erstellen sie|bau|baue) (mir )?(eine |meine )?(\w+ )?routine( zusammen)?|(routine|fragebogen) (neu (machen|starten)|wiederholen|von vorne)|neue routine)\b/,
  dontKnow: /\b(ich weiss (es )?nicht|keine ahnung|weiss nicht|nicht sicher|bin mir nicht sicher)\b/,
  // A medical situation, a treatment, an allergy or a reaction (owner's notes v4): no cards, no routine offer.
  caution: /\b((dermatologisch\w*|arztlich\w*|medizinisch\w*|verschrieben\w*) (behandlung|therapie|creme|medikament\w*)|in behandlung|nehme (ein |eine )?(medikament\w*|antibiotik\w*)|medikament\w*|rezept|isotretinoin|roaccutan\w*|antibiotik\w*|muttermal\w*|leberfleck\w*|allergi\w*|verbrennung\w*|rote flecken|(allergische |haut)reaktion\w*|ausschlag|ekzem\w*|neurodermitis|schuppenflechte|dermatitis|schwanger\w*|stillzeit|ich stille)\b/,
  accessoryAsk: /\b(zubehor|werkzeug\w*|gerat\w*|gua sha|roller|steine?|quarz|jade|led)\b/
};
