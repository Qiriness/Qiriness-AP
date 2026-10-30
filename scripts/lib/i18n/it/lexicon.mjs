/**
 * Italian skincare phrasing, as data for lexicon.mjs: the same shape and keys as fr/lexicon.mjs.
 * Patterns run on `norm` text: lower case, no accents, apostrophes as spaces (« l acne », « c e »).
 *
 * EVERY TABLE RUNS ON EVERY MESSAGE: no word here may also be an everyday French or English word.
 * Written 2026-10-30, not yet reviewed by a native speaker (VALIDATION_LOG).
 */

/** « pelle » then up to three words then the type: « pelle disidratata e mista » is combination. */
const SKIN = String.raw`\bpell[ei]\b(?: \w+){0,3}? `;

export default {
  code: 'it',

  /** Words that carry nothing about the skin (see en/lexicon.mjs `fillers`). */
  fillers: ['inverno', 'estate', 'primavera', 'autunno', 'stagione', 'freddo', 'caldo', 'adoro', 'piace', 'piacerebbe', 'gamma', 'linea', 'dettaglio', 'dettagli', 'adatto', 'adatta', 'adatti', 'adatte', 'vedere', 'iniziare', 'inizio', 'cosa', 'come', 'dove', 'davvero', 'troppo', 'poco', 'molto', 'abbastanza', 'spesso', 'sempre', 'volte', 'qualche', 'ultimamente', 'recentemente', 'oggi', 'giorni', 'giorno', 'tutti', 'tutte', 'tutto', 'mattina', 'sera', 'notte', 'ancora', 'piuttosto', 'anche', 'allora', 'quindi', 'ecco', 'bene', 'si', 'perche', 'quando', 'dopo', 'prima', 'durante', 'sento', 'sembra', 'diventa', 'resta', 'sono', 'essere', 'avere', 'ho', 'hai', 'ha', 'fatto', 'fare', 'il', 'lo', 'la', 'le', 'gli', 'un', 'uno', 'una', 'di', 'da', 'del', 'della', 'dei', 'delle', 'al', 'alla', 'ai', 'in', 'nel', 'nella', 'con', 'su', 'per', 'tra', 'fra', 'e', 'o', 'ma', 'se', 'non', 'piu', 'meno', 'qualcosa', 'prodotto', 'prodotti', 'routine', 'cura', 'consiglio', 'consigli', 'consigliare', 'consigliate', 'consigliami', 'raccomandare', 'voglio', 'vorrei', 'bisogno', 'uso', 'usare', 'provato', 'posso', 'potete', 'potreste', 'sapere', 'so', 'zona', 'tipo', 'genere', 'costruire', 'insieme', 'trovare', 'scegliere', 'migliore', 'meglio', 'ciao', 'salve', 'grazie', 'prego', 'soprattutto', 'principalmente', 'intorno', 'mi', 'ti', 'ci', 'che', 'mio', 'mia', 'miei', 'mie', 'questo', 'questa', 'quale', 'quali'],

  markers: ['ho', 'sono', 'della', 'delle', 'degli', 'dei', 'per', 'pelle', 'mia', 'mio', 'vorrei', 'grazie', 'buongiorno', 'ciao', 'che', 'gli', 'anche', 'molto', 'questo', 'questa', 'viso', 'occhi', 'rughe', 'avete', 'qual', 'quale', 'cosa', 'sul', 'sulla', 'nel', 'nella', 'perche', 'piu', 'voglio', 'consigli', 'il'],

  areas: {
    eyes: /\b(occhi|occhio|contorno (occhi|degli occhi)|palpebr[ae]|occhiaie|borse sotto gli occhi|intorno agli occhi)\b/,
    hands: /\b(mani|(la|una|mia) mano|dorso delle mani|cuticole)\b/,
    lips: /\b(labbra|labbro)\b/,
    feet: /\b(piedi|piede|talloni|tallone)\b/,
    body: /\b(corpo|gambe|gamba|braccia|braccio|schiena|gomiti|gomito|ginocchia|ginocchio)\b/,
    face: /\b(viso|volto|faccia|fronte|guance|guancia|mento)\b/
  },

  concerns: {
    deep_wrinkles: /\brughe (molto )?(profonde|marcate|pronunciate|evidenti)\b/,
    early_signs_of_ageing: /\b(prime rughe|primi segni|rughette|piccole rughe|linee sottili|rughe sottili|inizio ad avere (le |delle )?rughe)\b/,
    loss_of_density: /\b(perdita di densita|mancanza di densita|pelle (che si )?assottiglia)\b/,
    loss_of_firmness: /\b(rilassamento|cedimento|perdita di compattezza|mancanza di compattezza|compattezza|rassodare|pelle cadente|pelle (che )?cede|elasticita)\b/,
    facial_contours: /\b(ovale del viso|contorn[oi] del viso|doppio mento)\b/,
    loss_of_tone: /\b(perdita di tono|mancanza di tono|tonicita)\b/,
    global_signs_of_ageing: /\b(segni (dell eta|del tempo)|invecchiamento|anti ?eta|antieta|invecchia\w*)\b/,
    mature_skin: /\b(pelle matura|pelli mature)\b/,
    regeneration: /\b(rigener\w+)\b/,
    wrinkles: /\b(rughe|ruga|antirughe|anti rughe|zampe di gallina|rughe d espressione)\b/,
    // The marks a spot leaves are spots, not blemishes (owner's notes v4).
    dark_spots: /\b((segni|macchie|cicatrici)( lasciat[ie])? (da|dei|dell|di|della)( vecchi| vecchie)? ?(brufoli|acne|imperfezioni)|post ?acne|macchi[ae]( scure| solari| dell eta)?|iperpigmentazione|pigmentazione|melasma)\b/,
    uneven_tone: /\b((incarnato|tono|colorito) (non uniforme|irregolare|disomogeneo))\b/,
    redness: /\b(rossor[ei]|couperose|rosacea|pelle arrossata)\b/,
    irritation: /\b(irritazion[ei]|irritat[aoei]|pelle irritata)\b/,
    lack_of_radiance: /\b(mancanza di luminosita|senza luminosita|poca luminosita)\b/,
    dullness: /\b(pelle spenta|incarnato spento|colorito spento|spent[ao]|luminosita|bella cera)\b/,
    dark_circles: /\b(occhiaie)\b/,
    puffiness: /\b(borse( sotto gli occhi)?|occhi gonfi|gonfiore)\b/,
    tired_skin: /\b(stanc[ao]|stanchezza|affaticat\w*|spossat\w*|mancanza di sonno|poco sonno)\b/,
    dehydration: /\b(disidrat\w*|mancanza d acqua|manca d acqua)\b/,
    tightness: /\b(la pelle tira|pelle che tira|mi tira|tiraggio|sensazione di tensione)\b/,
    discomfort: /\b(disagio|fastidio|prurito|pizzic\w*|bruciore)\b/,
    // A dry hand, lip, foot or body part: no skin type of the face (« mani molto secche », « labbra screpolate »).
    dryness: /\b(secchezza|desquama\w*|ruvid[aei]|screpolat[aeio]|screpolatur\w*|(mani|labbra|piedi|talloni|gomiti|ginocchia|gambe|corpo|braccia)( \w+){0,2}? (secch[ei]|secca|secco|ruvid[aei]))\b/,
    clogged_pores: /\b(punti neri|pori (dilatati|ostruiti|visibili|aperti)|pori)\b/,
    imperfections: /\b(brufol[io]|imperfezion[ei]|acne|foruncol\w*)\b/,
    excess_sebum: /\b(sebo|eccesso di sebo)\b/,
    shine: /\b(lucid[ao]|lucidita|untuos[ao]|zona t)\b/
  },

  skinTypes: {
    very_dry: new RegExp(`${SKIN}(molto|estremamente|davvero|super) secca\\b|\\bviso (molto|estremamente) secco\\b`),
    dry: new RegExp(`${SKIN}secc[ah]e?\\b|\\bviso secco\\b|^ secca $`),
    normal: new RegExp(`${SKIN}(normale|normali|equilibrata)\\b|^ (normale|equilibrata) $`),
    combination: new RegExp(`${SKIN}mist[ae]\\b|^ mist[ae] $`),
    oily: new RegExp(`${SKIN}grass[ae]\\b|\\bviso grasso\\b|^ grass[ae] $`)
  },

  men: /\b(per uomo|per uomini|uomini|maschile|per (mio|il mio) (marito|ragazzo|compagno|padre|figlio|fratello)|sono un uomo|barba|rasatura)\b/,
  women: /\b(per (mia|la mia) (moglie|ragazza|compagna|madre|mamma|figlia|sorella)|sono una donna)\b/,

  sensitivity: {
    none: /\b(non (e |sono )?(per niente |molto |affatto )?(sensibile|reattiva)|nessuna sensibilita)\b/,
    reactive: /\b(pelle reattiva|reattiva|reagisce( facilmente| subito)?)\b/,
    sensitive: /\b(sensibil[ei]|sensibilita|intollerante|irrit\w*)\b/
  },

  /** Each has an `item` group: the ingredient, as typed. */
  exclusions: [
    /\b(?:senza|niente|allergic[ao] (?:a|al|alla|agli|ai)|evito(?: il| la| lo| i| gli| le)?) (?<item>profumo|fragranza|alcool|alcol|retinolo|oli essenziali|olio essenziale|olio|oli|siliconi?|solfati?|parabeni?|niacinamide|vitamina c|acido [a-z]+)\b/g
  ],

  ingredients: {
    fragrance: ['profumo', 'profumi', 'fragranza'],
    alcohol: ['alcol', 'alcool'],
    retinol: ['retinolo'],
    essential_oils: ['oli essenziali', 'olio essenziale'],
    oil: ['olio', 'oli'],
    silicones: ['silicone', 'siliconi'],
    sulfates: ['solfato', 'solfati'],
    parabens: ['parabene', 'parabeni'],
    niacinamide: ['niacinamide'],
    vitamin_c: ['vitamina c'],
    salicylic_acid: ['acido salicilico'],
    glycolic_acid: ['acido glicolico'],
    hyaluronic_acid: ['acido ialuronico'],
    lactic_acid: ['acido lattico'],
    azelaic_acid: ['acido azelaico'],
  },

  routineNone: /\b(nessuna routine|non ho (una|nessuna) routine|non uso niente|non uso nulla|niente di niente)\b/,
  /** `clause`: what follows « uso già », up to « ma ». */
  routineClause: /\b(?:uso (?:gia )?|sto usando |ho gia |la mia routine (?:attuale )?(?:e |include |comprende )?)(?<clause>.{0,120}?)(?:\bma\b|$)/,
  routineSteps: {
    night_cream: /\bcrema (da |per la )?notte\b/,
    eye_care: /\b(contorno (occhi|degli occhi)|crema (per gli )?occhi)\b/,
    cleanser: /\b(detergente|struccante|latte detergente|acqua micellare|gel detergente|sapone)\b/,
    serum: /\b(siero|elisir)\b/,
    lotion: /\b(tonico|lozione)\b/,
    mask: /\bmascher[ae]\b/,
    moisturiser: /\b(crema|idratante|crema da giorno|crema viso)\b/
  },

  // « il mio problema principale sono le rughe »: the concern they name is the main one.
  // « cosa posso fare per le rughe », « come eliminare le macchie »: asking for a concern.
  asksFor: /\b(cosa (posso|devo|dovrei) (fare|usare|mettere)|come (eliminare|togliere|trattare|ridurre|attenuare|combattere|prevenire|liberarmi d\w*|sbarazzarmi d\w*)|qualcosa (per|contro)|un prodotto (per|contro)|e per (le|la|i|il|mie|miei)|cosa funziona)\b/,
  additive: /\b(anche|inoltre|in piu|pure)\b/,
  concernIs: /\b(la mia |il mio )?(principale )?(preoccupazione|problema) (principale )?(e|sono|sarebbe)\b/,
  wants: /\b(cerco|sto cercando|ho bisogno|vorrei|voglio|mi serve|avete|avreste|mi consigliate|mi consigli|consigliatemi|quale (siero|crema))\b/,
  desired: {
    serum: /\b(un|il|mio) (siero|elisir)\b/,
    night_cream: /\b(una|la|mia) crema (da |per la )?notte\b/,
    eye_care: /\b((un|il|mio) contorno (occhi|degli occhi)|(una|la) crema (per gli )?occhi)\b/,
    cleanser: /\b(un|il|uno|lo) (detergente|struccante)\b/,
    exfoliant: /\b(esfoliant\w*|esfoliazione|peeling|gommage)\b/,
    mask: /\b((una|la|delle|mia) maschera|maschere)\b/,
    moisturiser: /\b(una|la|mia) (crema|crema da giorno|crema idratante)\b/
  },

  scope: {
    complete: /\b(routine completa|tutta la routine|routine intera|dalla a alla z)\b/,
    complete_existing: /\b(completare (la mia|il mio) routine|aggiungere alla mia routine|oltre (alla mia|ai miei))\b/,
    essential: /\b(routine (semplice|essenziale|di base|minima|veloce)|solo l essenziale)\b/,
    targeted: /\b(un solo prodotto|solo un prodotto|un trattamento mirato|un prodotto mirato)\b/
  },

  routineTime: {
    both: /\b(mattina e sera|sera e mattina|giorno e notte|notte e giorno|entrambe le routine)\b/,
    day: /\b(routine (del |della )?(mattina|giorno)|routine mattutina|routine per la mattina)\b/,
    night: /\b(routine (della |del )?(sera|notte)|routine serale|routine per la sera|prima di dormire|prima di andare a letto)\b/
  },

  requests: {
    basic_routine: /\b(routine (di base|basica|semplicissima)|le basi)\b/,
    gift: /\b(regalo|da regalare|idea regalo|compleanno|festa della mamma|festa del papa|natale|san valentino)\b/,
    spa: /\b(serata spa|momento spa|spa a casa|rituale spa|coccolarmi)\b/
  },
  moreOptions: /\b(qualcos altro|altre (opzioni|proposte|alternative|scelte)|altri prodotti|un altro prodotto|un altra (opzione|proposta)|cos altro)\b/,
  budgetSmall: /\b(piccolo budget|budget (limitato|ridotto)|economic[oaie]|poco costos[oa]|non troppo car[oa]|troppo car[oa]|(un po|molto|abbastanza) car[oa]|costa troppo|meno car[oa]|piu economic[oa]|non posso permettermel[oa]|fuori (dal mio )?budget|sopra il mio budget)\b/,
  budgetAmount: [
    /\b(?:meno di|non piu di|massimo|max|fino a|budget di|sotto i|sotto)\s(\d{1,4})\b(?! (?:anni|ml|giorni|settimane|mesi|minuti|min|ore|volte|prodotti|passaggi|years?|days?|weeks?|months?|ans?|jours?|mois))/,
    /\b(\d{1,4}) (?:euro )?(?:max|massimo)\b/
  ],

  /** Group 1: the age in years. */
  age: [/\b(\d{2}) anni\b/],
  ageWords: [[/\b(ventenne|vent anni)\b/, 25], [/\b(trentenne|trent anni|trentina)\b/, 35], [/\b(quarantenne|quarantina)\b/, 45], [/\b(cinquantenne|cinquantina)\b/, 55], [/\b(sessantenne|settantenne|sessantina)\b/, 65]],

  routineWord: /\b(rituale|rituali|regime di cura|programma di (cura|bellezza)|(dalla )?mattina (alla|e) (la )?sera|giorno e notte)\b/,
  routineAsk: /\b(vorrei|voglio|cerco|sto cercando|mi serve|ho bisogno di|mi (proponete|consigliate|suggerite)|potete (propormi|consigliarmi|farmi)|avete) (una |un )?((nuova|nuovo|vera|buona|semplice|completa|personalizzata|quotidiana|di bellezza|viso)\s){0,3}(routine|rituale)\b/,
  routineBuilder: /\b((costruire|creare|preparare|comporre|fare|farmi|costruiamo|creiamo|prepariamo|facciamo|aiutarmi a (costruire|creare|fare)) (insieme )?(una|la|mia|la mia) ((nuova|vera|buona|piccola) )?routine|(rifare|ricominciare|ripetere|ricostruire) (da zero )?(la |la mia |una )?(routine|questionario|diagnosi)|nuova routine)\b/,
  dontKnow: /\b(non (lo )?so|non saprei|nessuna idea|non sono sicur[ao])\b/,
  // A medical situation, a treatment, an allergy or a reaction (owner's notes v4): no cards, no routine offer.
  caution: /\b((trattamento|cura|terapia) (dermatologic[oa]|medic[oa]|farmacologic[oa])|sono in (trattamento|cura|terapia)|prendo (un |dei |degli )?(farmac[oi]|medicin\w*|antibiotic\w*)|farmac[oi]|ricetta medica|prescritt[oa]|isotretinoina|roaccutan\w*|antibiotic\w*|neo|allergi\w*|ustion\w*|scottatur\w*|chiazze rosse|reazione (allergica|cutanea)|ho avuto una reazione|eczema|psoriasi|dermatite|incinta|gravidanza|allatt\w*)\b/,
  accessoryAsk: /\b(accessori[oi]?|strument[oi]|dispositiv[oi]|apparecchi[oi]?|gua sha|rull[oi]|roller|pietr[ae]|quarzo|giada|maschera led|led)\b/
};
