/**
 * Dutch skincare phrasing, as data for lexicon.mjs: the same shape and keys as fr/lexicon.mjs.
 * Patterns run on `norm` text: lower case, no accents (« porien », « creme »), apostrophes as spaces.
 *
 * EVERY TABLE RUNS ON EVERY MESSAGE: no word here may also be an everyday French or English word.
 * Written 2026-10-30, not yet reviewed by a native speaker (VALIDATION_LOG).
 */

/** « huid » then up to two words: « mijn huid is erg droog », « huid wordt vet ». */
const SKIN_IS = String.raw`\b(?:huid|gezicht) (?:is |voelt |wordt |is erg |is heel |is vaak )?(?:\w+ ){0,2}?`;
/** The type, then up to two words, then « huid »: « droge en gevoelige huid ». */
const BEFORE_SKIN = String.raw`(?: \w+){0,2}? (?:huid|gezichtshuid)\b`;

export default {
  code: 'nl',

  /** Words that carry nothing about the skin (see en/lexicon.mjs `fillers`). */
  fillers: ['winter', 'zomer', 'lente', 'herfst', 'seizoen', 'koud', 'warm', 'weer', 'hou', 'houd', 'graag', 'lijn', 'serie', 'detail', 'details', 'geschikt', 'passend', 'zien', 'beginnen', 'wat', 'hoe', 'waar', 'welke', 'welk', 'echt', 'te', 'erg', 'heel', 'vrij', 'beetje', 'veel', 'vaak', 'altijd', 'soms', 'sinds', 'tijd', 'laatst', 'laatste', 'tegenwoordig', 'vandaag', 'dagen', 'dag', 'alle', 'alles', 'ochtend', 'avond', 'nacht', 'nog', 'eerder', 'ook', 'dus', 'goed', 'ja', 'nee', 'omdat', 'als', 'wanneer', 'na', 'voor', 'tijdens', 'voelt', 'voel', 'lijkt', 'wordt', 'blijft', 'ben', 'is', 'zijn', 'heb', 'hebt', 'heeft', 'had', 'gedaan', 'doen', 'de', 'het', 'een', 'en', 'of', 'maar', 'met', 'van', 'naar', 'bij', 'uit', 'om', 'op', 'aan', 'in', 'ik', 'me', 'mij', 'mijn', 'je', 'jij', 'u', 'uw', 'jullie', 'niet', 'geen', 'meer', 'minder', 'product', 'producten', 'routine', 'verzorging', 'advies', 'tip', 'aanraden', 'wil', 'zou', 'nodig', 'gebruik', 'gebruiken', 'geprobeerd', 'kan', 'kunt', 'kunnen', 'weten', 'weet', 'gebied', 'type', 'soort', 'samenstellen', 'samen', 'vinden', 'kiezen', 'beste', 'beter', 'hallo', 'hoi', 'dank', 'bedankt', 'alstublieft', 'aub', 'vooral', 'voornamelijk', 'rond', 'deze', 'dit', 'dat', 'die'],

  markers: ['ik', 'heb', 'mijn', 'huid', 'het', 'een', 'voor', 'niet', 'erg', 'heel', 'ook', 'graag', 'bedankt', 'dank', 'gezicht', 'ogen', 'rimpels', 'wat', 'welke', 'hebben', 'jullie', 'zoek', 'wil', 'zou', 'kan', 'van', 'dat', 'dit', 'droge', 'vette', 'naar', 'maar', 'zijn', 'hoe', 'uw', 'mij', 'een', 'goedendag', 'hoi'],

  areas: {
    eyes: /\b(ogen|oog|oogcontour|oogzone|onder de ogen|rond (de|mijn) ogen|oogleden|ooglid|wallen|kringen)\b/,
    hands: /\b(handen|handrug|nagelriemen)\b/,
    lips: /\b(lippen|lip)\b/,
    feet: /\b(voeten|voet|hielen|hiel)\b/,
    body: /\b(lichaam|benen|armen|ellebogen|elleboog|knieen|knie)\b/,
    face: /\b(gezicht|gezichtshuid|voorhoofd|wangen|wang)\b/
  },

  concerns: {
    deep_wrinkles: /\b((diepe|uitgesproken|zichtbare) rimpels|rimpels zijn (erg )?diep)\b/,
    early_signs_of_ageing: /\b(eerste (rimpels|rimpeltjes|tekenen)|fijne lijntjes|rimpeltjes|kleine rimpels)\b/,
    loss_of_density: /\b(verlies van (huid)?dichtheid|dunner wordende huid)\b/,
    loss_of_firmness: /\b(verlies van stevigheid|slappe huid|verslapping|stevigheid|verstevig\w*|elasticiteit)\b/,
    facial_contours: /\b(gezichtscontour\w*|dubbele kin|kaaklijn)\b/,
    loss_of_tone: /\b(verlies van spankracht|spankracht)\b/,
    global_signs_of_ageing: /\b(tekenen van veroudering|huidveroudering|veroudering|ouder worden)\b/,
    mature_skin: /\b(rijpe huid|oudere huid)\b/,
    regeneration: /\b(regenera\w*|huidvernieuwing)\b/,
    wrinkles: /\b(rimpels|rimpel|anti ?rimpel\w*|kraaienpootjes|lachrimpels|\w+rimpels)\b/,
    // The marks a spot leaves are spots, not blemishes (owner's notes v4).
    dark_spots: /\b((acne|puistjes) ?(littekens|vlekken)|littekens van (oude )?(puistjes|acne)|pigmentvlekken|ouderdomsvlekken|donkere vlekken|vlekken|hyperpigmentatie|pigmentatie|melasma)\b/,
    uneven_tone: /\b(ongelijkmatige (teint|huidskleur)|vlekkerige huid)\b/,
    redness: /\b(roodheid|rode huid|couperose|rosacea)\b/,
    irritation: /\b(irritatie\w*|geirriteerd\w*)\b/,
    lack_of_radiance: /\b(gebrek aan (uitstraling|glans)|geen uitstraling)\b/,
    dullness: /\b(doffe huid|dof|dofheid|vale (huid|teint)|grauw\w*|uitstraling)\b/,
    dark_circles: /\b(donkere kringen|kringen onder (de|mijn) ogen)\b/,
    puffiness: /\b(wallen|opgezette ogen|gezwollen ogen|zwelling)\b/,
    tired_skin: /\b(moe|vermoeid\w*|uitgeput|slaapgebrek|te weinig slaap)\b/,
    dehydration: /\b(uitgedroogd\w*|vochtarm\w*|vochttekort|gebrek aan vocht|dorstige huid|gedehydrateerd\w*)\b/,
    tightness: /\b(trekkerig\w*|trekt|strak gevoel|strakke huid)\b/,
    discomfort: /\b(ongemak|jeuk\w*|prikkel\w*|tinteling\w*|branderig\w*)\b/,
    // A dry hand, lip, foot or body part: no skin type of the face (« erg droge handen », « gesprongen lippen »).
    dryness: /\b(droogte|schilfer\w*|gesprongen|kloven|(droge|ruwe) (handen|lippen|voeten|hielen|ellebogen|knieen|benen)|(handen|lippen|voeten|hielen|ellebogen|knieen|benen|lichaam)( \w+){0,2}? (droog|ruw))\b/,
    clogged_pores: /\b(mee eters|(vergrote|verstopte|zichtbare|open|grote) porien|porien)\b/,
    imperfections: /\b(puistjes|puistje|onzuiverheden|onzuiverheid|acne|pukkels|jeugdpuistjes)\b/,
    excess_sebum: /\b(talg|overmatige talg|talgproductie)\b/,
    shine: /\b(glimmend\w*|glimt|vette glans|t zone)\b/
  },

  skinTypes: {
    very_dry: new RegExp(String.raw`\b(zeer|erg|heel|extreem|super) droge${BEFORE_SKIN}|${SKIN_IS}(zeer|erg|heel|extreem) droog\b`),
    dry: new RegExp(String.raw`\bdroge${BEFORE_SKIN}|${SKIN_IS}droog\b|^ droog $|^ droge $`),
    normal: new RegExp(String.raw`\b(normale|evenwichtige)${BEFORE_SKIN}|${SKIN_IS}normaal\b|^ normaal $`),
    combination: new RegExp(String.raw`\bgemengde${BEFORE_SKIN}|${SKIN_IS}gemengd\b|^ gemengde? $|\bcombinatiehuid\b`),
    oily: new RegExp(String.raw`\bvette${BEFORE_SKIN}|${SKIN_IS}vet\b|^ vette? $|\bolieachtige huid\b`)
  },

  men: /\b(voor (mannen|heren)|mannen|heren|mannelijk|voor mijn (man|vriend|partner|vader|zoon|broer)|ik ben een man|baard|scheren)\b/,
  women: /\b(voor mijn (vrouw|vriendin|partner|moeder|dochter|zus)|ik ben een vrouw)\b/,

  sensitivity: {
    none: /\b(niet (erg |zo |echt )?(gevoelig|reactief)|geen gevoeligheid)\b/,
    reactive: /\b(reactieve huid|reageert (snel|makkelijk|sterk)|reactief)\b/,
    sensitive: /\b(gevoelig\w*|intolerant|geirriteerd\w*)\b/
  },

  /** Each has an `item` group: the ingredient, as typed. */
  exclusions: [
    /\b(?:zonder|geen|allergisch voor|ik vermijd|vermijd) (?<item>parfum|geurstoffen?|alcohol|retinol|essentiele olien|olien|olie|siliconen?|sulfaten?|parabenen?|niacinamide|vitamine c|\w+zuur)\b/g,
    /\b(?<item>parfum|alcohol|olie|siliconen|parabenen|sulfaat)vrij\b/g
  ],

  ingredients: {
    fragrance: ['parfum', 'geurstof', 'geurstoffen'],
    alcohol: ['alcohol'],
    retinol: ['retinol'],
    essential_oils: ['essentiele olien', 'essentiele olie'],
    oil: ['olie', 'olien'],
    silicones: ['silicone', 'siliconen'],
    sulfates: ['sulfaat', 'sulfaten'],
    parabens: ['paraben', 'parabenen'],
    niacinamide: ['niacinamide'],
    vitamin_c: ['vitamine c'],
    salicylic_acid: ['salicylzuur'],
    glycolic_acid: ['glycolzuur'],
    hyaluronic_acid: ['hyaluronzuur'],
    lactic_acid: ['melkzuur'],
    azelaic_acid: ['azelainezuur'],
  },

  routineNone: /\b(geen routine|ik gebruik niets|ik gebruik niks|helemaal niets)\b/,
  /** `clause`: what follows « ik gebruik al », up to « maar ». */
  routineClause: /\b(?:ik gebruik (?:al )?|ik heb al |mijn (?:huidige )?routine (?:is |bestaat uit |bevat )?)(?<clause>.{0,120}?)(?:\bmaar\b|$)/,
  routineSteps: {
    night_cream: /\bnachtcreme\b/,
    eye_care: /\b(oogcreme|oogcontour\w*|oogserum|oogverzorging)\b/,
    cleanser: /\b(reiniger|reinigings\w*|micellair water|make ?up remover|zeep|reinigingsmelk)\b/,
    serum: /\b(serum|elixer)\b/,
    lotion: /\b(toner|gezichtswater|lotion)\b/,
    mask: /\b\w*maskers?\b/,
    moisturiser: /\b(dagcreme|gezichtscreme|vochtinbrengende creme)\b/
  },

  // « mijn grootste probleem zijn rimpels »: the concern they name is the main one.
  // « wat kan ik doen tegen rimpels », « hoe kom ik af van vlekken »: asking for a concern.
  asksFor: /\b(wat (kan|moet|zou) ik (doen|gebruiken|nemen)|hoe (kom ik af van|behandel ik|verminder ik|voorkom ik|bestrijd ik)|iets (voor|tegen)|een product (voor|tegen)|en (voor|wat met)|wat helpt (tegen|bij)|wat met)\b/,
  additive: /\b(ook|daarnaast|bovendien|eveneens|tevens)\b/,
  concernIs: /\b(mijn )?(grootste |belangrijkste )?(probleem|zorg|aandachtspunt) (is|zijn)\b/,
  wants: /\b(ik zoek|ik ben op zoek naar|op zoek naar|ik heb (\w+ )?nodig|ik wil|ik zou graag|hebben jullie|heeft u|is er|kunt u (\w+ )?aanraden|raad (me|mij) (\w+ )?aan|welk(e)? (serum|creme))\b/,
  desired: {
    serum: /\b(een|het|mijn) (serum|elixer)\b/,
    night_cream: /\b(een|de|mijn) nachtcreme\b/,
    eye_care: /\b(een|de|mijn) (oogcreme|oogcontour\w*|oogserum)\b/,
    cleanser: /\b(een|de|mijn) (reiniger|reinigingsgel|reinigingsmelk|make ?up remover)\b/,
    exfoliant: /\b(scrub\w*|exfolia\w*|peeling\w*)\b/,
    mask: /\b(een|het|mijn) \w*masker\b/,
    moisturiser: /\b(een|de|mijn) (creme|dagcreme|gezichtscreme|vochtinbrengende creme)\b/
  },

  scope: {
    complete: /\b(volledige routine|complete routine|hele routine|routine van a tot z)\b/,
    complete_existing: /\b(mijn routine aanvullen|aanvulling op mijn routine|bovenop mijn)\b/,
    essential: /\b((eenvoudige|simpele|basis|minimale|snelle) routine|alleen de basis|het essentiele)\b/,
    targeted: /\b(een enkel product|maar een product|alleen een product|gerichte verzorging)\b/
  },

  routineTime: {
    both: /\b(ochtend en avond|avond en ochtend|dag en nacht|nacht en dag|beide routines)\b/,
    day: /\b(ochtendroutine|dagroutine|routine voor de ochtend)\b/,
    night: /\b(avondroutine|nachtroutine|routine voor de avond|voor het slapen(gaan)?)\b/
  },

  requests: {
    basic_routine: /\b(basisroutine|alleen de basis)\b/,
    gift: /\b(cadeau\w*|kado\w*|verjaardag|moederdag|vaderdag|kerst\w*|valentijn\w*|sinterklaas)\b/,
    spa: /\b(spa avond|spa thuis|thuis spa|wellness avond|mezelf verwennen)\b/
  },
  moreOptions: /\b(iets anders|andere (opties|producten|keuzes|alternatieven)|een ander product|een andere optie|wat nog meer|alternatieven)\b/,
  budgetSmall: /\b(klein budget|krap budget|beperkt budget|goedkop\w*|betaalbaar\w*|voordelig\w*|niet te duur|te duur|(best|vrij|erg|heel) duur|kost te veel|kan ik niet betalen|boven mijn budget|buiten mijn budget)\b/,
  budgetAmount: [
    /\b(?:onder|minder dan|maximaal|max|hoogstens|tot|budget van|budget is)\s(\d{1,4})\b(?! (?:jaar|ml|dagen|weken|maanden|minuten|min|uur|keer|producten|stappen|years?|days?|weeks?|months?|ans?|jours?|mois))/,
    /\b(\d{1,4}) (?:euro )?(?:max|maximaal|hoogstens)\b/
  ],

  /** Group 1: the age in years. */
  age: [/\bik ben (\d{2})\b/, /\b(\d{2}) jaar\b/],
  ageWords: [[/\btwintiger\b/, 25], [/\bdertiger\b/, 35], [/\bveertiger\b/, 45], [/\bvijftiger\b/, 55], [/\b(zestiger|zeventiger)\b/, 65]],

  routineWord: /\b(\w*routines?|ritue(e)?l\w*|verzorgingsplan|(van )?ochtend tot avond|dag en nacht)\b/,
  routineAsk: /\b(ik wil|ik zou graag|ik zoek|ik ben op zoek naar|ik heb nodig|kunt u (me|mij)|kunnen jullie (me|mij)|raad (me|mij)|stel (me|mij)|hebben jullie) (een )?((nieuwe|goede|eenvoudige|complete|volledige|persoonlijke|gepersonaliseerde|dagelijkse)\s){0,3}(\w*routine|ritueel)\b/,
  routineBuilder: /\b(\w*routine (samenstellen|opbouwen|maken|creeren)|(stel|maak|bouw) (voor mij |me |mij )?(een |mijn )?(\w+ )?routine( samen)?|(routine|vragenlijst) (opnieuw|overnieuw)( (doen|maken|starten))?|opnieuw beginnen|nieuwe routine)\b/,
  dontKnow: /\b(ik weet (het )?niet|geen idee|weet niet|niet zeker|ik ben niet zeker)\b/,
  // A medical situation, a treatment, an allergy or a reaction (owner's notes v4): no cards, no routine offer.
  caution: /\b((dermatologische|medische|voorgeschreven) (behandeling|creme|medicatie)|onder behandeling|ik neem (\w+ ){0,2}(medicijnen|medicatie|antibiotica)|medicijn\w*|medicatie|isotretinoine|roaccutane|antibiotica|moedervlek\w*|allergi\w*|brandwond\w*|verbrand\w*|rode plekken|(allergische |huid)reactie\w*|uitslag|eczeem|dermatitis|zwanger\w*|borstvoeding)\b/,
  accessoryAsk: /\b(accessoire\w*|hulpmiddel\w*|apparaat|apparaten|gua sha|roller\w*|stenen|steen|kwarts|jade|led)\b/
};
