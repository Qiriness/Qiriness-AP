/**
 * Spanish skincare phrasing, as data for lexicon.mjs: the same shape and keys as fr/lexicon.mjs.
 * Patterns run on `norm` text: lower case, no accents (« acne », « pequenas »: « ñ » loses its tilde).
 *
 * EVERY TABLE RUNS ON EVERY MESSAGE: no word here may also be an everyday French or English word.
 * Written 2026-10-30; the owner reviews the Spanish (VALIDATION_LOG).
 */

/** « piel » then up to three words then the type: « piel deshidratada y mixta » is combination. */
const SKIN = String.raw`\bpiel(?:es)?\b(?: \w+){0,3}? `;

export default {
  code: 'es',

  /** Words that carry nothing about the skin (see en/lexicon.mjs `fillers`). */
  fillers: ['invierno', 'verano', 'primavera', 'otono', 'temporada', 'frio', 'calor', 'encanta', 'gusta', 'gustaria', 'gama', 'linea', 'detalle', 'detalles', 'adecuado', 'adecuada', 'ver', 'empezar', 'que', 'como', 'donde', 'cual', 'cuales', 'realmente', 'demasiado', 'poco', 'mucho', 'muy', 'bastante', 'siempre', 'veces', 'desde', 'tiempo', 'ultimamente', 'hoy', 'dias', 'dia', 'todos', 'todas', 'todo', 'manana', 'tarde', 'noche', 'todavia', 'aun', 'tambien', 'entonces', 'pues', 'bien', 'si', 'no', 'porque', 'cuando', 'despues', 'antes', 'durante', 'siento', 'parece', 'queda', 'soy', 'es', 'estoy', 'esta', 'son', 'ser', 'estar', 'tener', 'tengo', 'tiene', 'tienen', 'hecho', 'hacer', 'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'a', 'en', 'con', 'por', 'para', 'sobre', 'entre', 'y', 'o', 'pero', 'mi', 'mis', 'me', 'su', 'sus', 'tu', 'te', 'se', 'mas', 'menos', 'algo', 'producto', 'productos', 'rutina', 'cuidado', 'consejo', 'consejos', 'recomendar', 'recomienda', 'recomiendas', 'quiero', 'quisiera', 'necesito', 'uso', 'usar', 'probado', 'puedo', 'puede', 'pueden', 'podria', 'saber', 'se', 'zona', 'tipo', 'construir', 'juntos', 'encontrar', 'elegir', 'mejor', 'hola', 'gracias', 'favor', 'sobre', 'todo', 'principalmente', 'alrededor', 'este', 'esta', 'esto', 'hay'],

  markers: ['tengo', 'piel', 'cara', 'rostro', 'ojos', 'arrugas', 'quiero', 'gracias', 'hola', 'pero', 'muy', 'para', 'tambien', 'tienen', 'cual', 'el', 'los', 'las', 'estoy', 'soy', 'necesito', 'busco', 'algo', 'como', 'puedo', 'hay', 'manchas', 'usted', 'mis', 'tiene', 'son', 'esta', 'eso', 'quisiera', 'gustaria'],

  areas: {
    eyes: /\b(ojos|ojo|contorno de (los )?ojos|parpados?|ojeras|bolsas|debajo de los ojos|alrededor de los ojos)\b/,
    hands: /\b(manos|(la|mi|una) mano|dorso de las manos|cuticulas)\b/,
    lips: /\b(labios|labio)\b/,
    feet: /\b(pies|talones|talon)\b/,
    body: /\b(cuerpo|piernas|pierna|brazos|brazo|espalda|codos|codo|rodillas|rodilla)\b/,
    face: /\b(cara|rostro|frente|mejillas|mejilla|barbilla|menton)\b/
  },

  concerns: {
    deep_wrinkles: /\barrugas (muy )?(profundas|marcadas|pronunciadas)\b/,
    early_signs_of_ageing: /\b(primeras arrugas|primeros signos|lineas finas|lineas de expresion|pequenas arrugas|arruguitas|empiezo a tener arrugas)\b/,
    loss_of_density: /\b(perdida de densidad|falta de densidad|piel (que se )?adelgaza)\b/,
    loss_of_firmness: /\b(flacidez|perdida de firmeza|falta de firmeza|firmeza|reafirma\w*|piel (que se )?descuelga|elasticidad)\b/,
    facial_contours: /\b(ovalo (facial|del rostro)|contornos? (del rostro|de la cara|facial)|papada|doble menton)\b/,
    loss_of_tone: /\b(perdida de tono|falta de tono|tonicidad)\b/,
    global_signs_of_ageing: /\b(signos de la edad|envejecimiento|anti ?edad|antiedad|anti ?envejecimiento|envejecer)\b/,
    mature_skin: /\b(piel madura|pieles maduras)\b/,
    regeneration: /\b(regenera\w+|renovacion celular)\b/,
    wrinkles: /\b(arrugas|arruga|antiarrugas|anti ?arrugas|patas de gallo)\b/,
    // The marks a spot leaves are spots, not blemishes (owner's notes v4).
    dark_spots: /\b((marcas|manchas|cicatrices) (de|del|que dejan|dejadas por) (los |el |mis )?(antiguos? )?(granos|acne|espinillas|imperfecciones)|post ?acne|manchas?( oscuras| solares| de la edad)?|hiperpigmentacion|pigmentacion|melasma)\b/,
    uneven_tone: /\b(tono (desigual|irregular|no uniforme)|piel (desigual|irregular))\b/,
    redness: /\b(rojeces|rojez|enrojecimiento|cuperosis|rosacea|piel roja)\b/,
    irritation: /\b(irritacion(es)?|irritad[ao]s?)\b/,
    lack_of_radiance: /\b(falta de luminosidad|sin luminosidad|poca luminosidad|sin brillo)\b/,
    dullness: /\b(piel apagada|tez apagada|apagad[ao]|opaca|luminosidad|buena cara|mala cara)\b/,
    dark_circles: /\b(ojeras)\b/,
    puffiness: /\b(bolsas( bajo los ojos| debajo de los ojos)?|ojos hinchados|hinchazon)\b/,
    tired_skin: /\b(cansad[ao]s?|cansancio|fatiga\w*|agotad[ao]|falta de sueno)\b/,
    dehydration: /\b(deshidrat\w*|falta de agua|le falta agua)\b/,
    tightness: /\b(tirantez|me tira|piel tirante|sensacion de tension)\b/,
    discomfort: /\b(incomodidad|molestias?|picor|picazon|escozor|ardor|me pica)\b/,
    // A dry hand, lip, foot or body part: no skin type of the face (« manos muy secas », « labios agrietados »).
    dryness: /\b(sequedad|descamacion|se descama|asperas?|agrietad[ao]s?|grietas|cortad[ao]s|(manos|labios|pies|talones|codos|rodillas|piernas|cuerpo|brazos)( \w+){0,2}? (secos?|secas?|asperos?|asperas?))\b/,
    clogged_pores: /\b(puntos negros|poros (dilatados|obstruidos|abiertos|visibles|tapados)|poros)\b/,
    imperfections: /\b(granos?|granitos|imperfecciones|imperfeccion|acne|espinillas?)\b/,
    excess_sebum: /\b(sebo|exceso de sebo|exceso de grasa)\b/,
    shine: /\b(brillos?|brillante|zona t grasa|zona t)\b/
  },

  skinTypes: {
    very_dry: new RegExp(`${SKIN}(muy|extremadamente|super|realmente) secas?\\b|\\bcara (muy|extremadamente) seca\\b`),
    dry: new RegExp(`${SKIN}secas?\\b|\\bcara seca\\b|^ secas? $`),
    normal: new RegExp(`${SKIN}(normal|normales|equilibrada)\\b|^ equilibrada $`),
    combination: new RegExp(`${SKIN}mixtas?\\b|^ mixtas? $`),
    oily: new RegExp(`${SKIN}grasas?\\b|\\bcara grasa\\b|^ grasas? $`)
  },

  men: /\b(para (hombres?|caballeros?)|hombres|masculin[ao]|para mi (marido|esposo|novio|padre|hijo|hermano|pareja)|soy (un )?hombre|barba|afeitado)\b/,
  women: /\b(para mi (mujer|esposa|novia|madre|mama|hija|hermana)|soy (una )?mujer)\b/,

  sensitivity: {
    none: /\b(no (es |soy |tengo )?(para nada |muy )?(sensible|reactiva)|sin sensibilidad)\b/,
    reactive: /\b(piel reactiva|reactiva|reacciona (facilmente|rapido|mal)?)\b/,
    sensitive: /\b(sensibles?|sensibilidad|intolerante|irrit\w*)\b/
  },

  /** Each has an `item` group: the ingredient, as typed. */
  exclusions: [
    /\b(?:sin|nada de|alergic[ao] (?:a|al|a la)|evito(?: el| la| los| las)?) (?<item>perfume|fragancia|alcohol|retinol|aceites esenciales|aceite esencial|aceites?|siliconas?|sulfatos?|parabenos?|niacinamida|vitamina c|acido [a-z]+)\b/g
  ],

  ingredients: {
    fragrance: ['perfume', 'fragancia', 'fragancias'],
    alcohol: ['alcohol'],
    retinol: ['retinol'],
    essential_oils: ['aceites esenciales', 'aceite esencial'],
    oil: ['aceite', 'aceites'],
    silicones: ['silicona', 'siliconas'],
    sulfates: ['sulfato', 'sulfatos'],
    parabens: ['parabeno', 'parabenos'],
    niacinamide: ['niacinamida'],
    vitamin_c: ['vitamina c'],
    salicylic_acid: ['acido salicilico'],
    glycolic_acid: ['acido glicolico'],
    hyaluronic_acid: ['acido hialuronico'],
    lactic_acid: ['acido lactico'],
    azelaic_acid: ['acido azelaico'],
  },

  routineNone: /\b(no tengo rutina|ninguna rutina|no uso nada|nada de nada)\b/,
  /** `clause`: what follows « ya uso », up to « pero ». */
  routineClause: /\b(?:ya uso |uso ya |ya tengo |mi rutina (?:actual )?(?:es |incluye |tiene )?)(?<clause>.{0,120}?)(?:\bpero\b|$)/,
  routineSteps: {
    night_cream: /\bcrema de noche\b/,
    eye_care: /\b(contorno de (los )?ojos|crema (de|para los) ojos)\b/,
    cleanser: /\b(limpiador\w*|desmaquillante|leche limpiadora|agua micelar|gel limpiador|espuma limpiadora|jabon)\b/,
    serum: /\b(serum|elixir)\b/,
    lotion: /\b(tonico|locion|esencia)\b/,
    mask: /\bmascarillas?\b/,
    moisturiser: /\b(crema|hidratante|crema de dia|crema facial)\b/
  },

  // « mi principal preocupación son las arrugas »: the concern they name is the main one.
  // « qué puedo hacer para las arrugas », « cómo quitar las manchas »: asking for a concern.
  asksFor: /\b(que (puedo|debo|deberia) (hacer|usar|ponerme)|como (quitar|eliminar|tratar|reducir|atenuar|borrar|combatir|prevenir|deshacerme de|librarme de)|algo (para|contra)|un producto (para|contra)|y para (las?|los?|mis)|pero para (las?|los?|mis)|que funciona)\b/,
  additive: /\b(tambien|ademas|igualmente|asimismo)\b/,
  concernIs: /\b(mi |mis )?(principal )?(preocupacion|problema) (principal )?(es|son|seria)\b/,
  wants: /\b(busco|estoy buscando|necesito|quiero|quisiera|me gustaria|tienen|teneis|tiene usted|me recomiendas|me recomienda|recomiendame|que (serum|crema)|cual (serum|crema))\b/,
  desired: {
    serum: /\b(un|el|mi) (serum|elixir)\b/,
    night_cream: /\b(una|la|mi) crema de noche\b/,
    eye_care: /\b((un|el|mi) contorno de (los )?ojos|(una|la) crema (de|para los) ojos)\b/,
    cleanser: /\b(un|el|mi) (limpiador|desmaquillante)\b/,
    exfoliant: /\b(exfoliant\w*|exfoliacion|exfoliar|peeling|gommage)\b/,
    mask: /\b(una|la|mi|unas) mascarillas?\b/,
    moisturiser: /\b(una|la|mi) (crema|crema de dia|crema hidratante)\b/
  },

  scope: {
    complete: /\b(rutina completa|toda la rutina|rutina entera|de la a a la z)\b/,
    complete_existing: /\b(completar mi rutina|anadir a mi rutina|ademas de (mi|mis))\b/,
    essential: /\b(rutina (sencilla|simple|basica|esencial|minima|rapida)|lo esencial|solo lo basico)\b/,
    targeted: /\b(un solo producto|solo un producto|un tratamiento especifico|un producto especifico)\b/
  },

  routineTime: {
    both: /\b(manana y noche|noche y manana|dia y noche|noche y dia|las dos rutinas|ambas rutinas)\b/,
    day: /\b(rutina (de |de la )?(manana|dia)|rutina matutina|rutina para la manana)\b/,
    night: /\b(rutina (de |de la )?noche|rutina nocturna|rutina para la noche|antes de (dormir|acostarme))\b/
  },

  requests: {
    basic_routine: /\b(rutina (basica|de base|sencillita)|lo basico)\b/,
    gift: /\b(regalo|para regalar|idea de regalo|cumpleanos|dia de la madre|dia del padre|navidad|san valentin|reyes)\b/,
    spa: /\b(noche de spa|momento spa|spa en casa|ritual spa|mimarme|consentirme)\b/
  },
  moreOptions: /\b(algo mas|otra cosa|otras (opciones|alternativas|propuestas)|otros productos|otro producto|otra opcion|que mas)\b/,
  budgetSmall: /\b(presupuesto (pequeno|ajustado|limitado|reducido)|poco presupuesto|economic[oa]s?|barat[oa]s?|asequible|no muy car[oa]|demasiado car[oa]|(un poco|bastante|muy|algo) car[oa]|es car[oa]|cuesta demasiado|mas barat[oa]|no me lo puedo permitir|fuera de mi presupuesto|por encima de mi presupuesto)\b/,
  budgetAmount: [
    /\b(?:menos de|no mas de|maximo|max|hasta|presupuesto de|por debajo de)\s(\d{1,4})\b(?! (?:anos|ml|dias|semanas|meses|minutos|min|horas|veces|productos|pasos|years?|days?|weeks?|months?|ans?|jours?|mois))/,
    /\b(\d{1,4}) (?:euros? )?(?:max|maximo|como maximo)\b/
  ],

  /** Group 1: the age in years. */
  age: [/\b(\d{2}) anos\b/],
  ageWords: [[/\b(veintitantos|veinteanera)\b/, 25], [/\b(treintena|treintanera|treintaneros|treinta y tantos)\b/, 35], [/\b(cuarentona|cuarenton|cuarenta y tantos)\b/, 45], [/\b(cincuentona|cincuenta y tantos)\b/, 55], [/\b(sesentona|sesenta y tantos|setenta y tantos)\b/, 65]],

  routineWord: /\b(rutinas?|rituales?|regimen de cuidado|plan de cuidado|(de la )?manana (a la|y) noche|dia y noche)\b/,
  routineAsk: /\b(quiero|quisiera|me gustaria|busco|estoy buscando|necesito|me (puedes|puede|podrias|podria) (proponer|recomendar|hacer|dar)|recomiendame|proponme|tienen) (una |un )?((nueva|nuevo|buena|sencilla|completa|personalizada|diaria|de cuidado|facial)\s){0,3}(rutina|ritual)\b/,
  routineBuilder: /\b((construir|crear|armar|hacer|hacerme|montar|ayudarme a (crear|construir|hacer)) (juntos )?(una|mi|la) ((nueva|buena) )?rutina|(rehacer|repetir|empezar de nuevo|volver a empezar|reiniciar) (la |mi )?(rutina|cuestionario|diagnostico)|nueva rutina)\b/,
  // Not « no se » inside a sentence: « mi piel no se descama » says something.
  dontKnow: /\b(no lo se|no se (que|cual|si)|ni idea|no estoy segur[ao])\b|^ no se $/,
  // A medical situation, a treatment, an allergy or a reaction (owner's notes v4): no cards, no routine offer.
  caution: /\b(tratamiento (dermatologico|medico|recetado)|estoy en tratamiento|tomo (un |una )?(medicamento|medicacion|antibiotico)|medicamentos?|medicacion|receta medica|isotretinoina|roacutan\w*|antibioticos?|lunares?|alergi\w*|alergic[ao]s?|quemadura\w*|me quema|placas rojas|reacci(on|ones) (alergica|cutanea)s?|tuve una reaccion|eccema|psoriasis|dermatitis|embarazad[ao]|embarazo|lactancia|amamant\w*)\b/,
  accessoryAsk: /\b(accesorios?|herramientas?|aparatos?|dispositivos?|gadgets?|gua sha|rodillos?|roller|piedras?|cuarzo|jade|led|mascarilla led)\b/
};
