/**
 * Dutch: every sentence the server writes itself. The same keys as fr/messages.mjs, which documents
 * each one. The formal « u », as the French « vous ». Written 2026-10-30, not yet reviewed by a
 * native speaker (VALIDATION_LOG).
 */
export default {
  code: 'nl',

  languageName: 'Dutch',
  formalAddress: 'u',
  lowercaseInSentence: true,

  flow: {
    offer: 'Zal ik een persoonlijke huidverzorgingsroutine voor u samenstellen?',
    yes: 'Ja, graag',
    no: 'Nee, dank u',
    purchase: (name) => `Ik zie dat u ${name} al eerder hebt gekocht. Wilt u uw routine daaromheen opbouwen, is het bijna op, of richt u zich liever op uw huidprobleem?`,
    runningLow: (name) => `Hier vindt u ${name} terug, of u voegt het meteen toe aan uw winkelmandje.`,
    // Their concern without an article (« ideaal bij rimpels »): right whatever its gender.
    treatAfterRoutine: (concern) => concern ? `En voor een moment van ontspanning, ideaal bij ${concern}, valt dit kleine verwenmoment misschien in de smaak:` : 'En voor een moment van ontspanning valt dit kleine verwenmoment misschien in de smaak:',
    treatAfterNo: 'Prima. Als u zin hebt in een klein verwenmoment, valt dit misschien in de smaak:',
    cartOne: (name) => `Zal ik ${name} aan uw winkelmandje toevoegen?`,
    cartRoutine: 'Zal ik deze routine aan uw winkelmandje toevoegen?',
    cartRoutineDiscount: 'Zal ik deze routine aan uw winkelmandje toevoegen? Uw routinekorting wordt automatisch toegepast.',
    cartYes: 'Ja, toevoegen',
    cartYesDiscount: 'Ja, toevoegen met korting',
    cartDiscount: 'Uw routinekorting is toegepast in uw winkelmandje.',
    cartNo: 'Ik kijk nog even rond',
    cartDone: (names) => `Prima, ik voeg toe aan uw winkelmandje: ${names}.`,
    cartSize: (names) => `Kies voor ${names} de maat op de productpagina.`,
    cartRoutineDone: 'Prima, ik voeg de producten uit uw routine toe aan uw winkelmandje.',
    cartNoDone: 'Natuurlijk, neem gerust de tijd.',
    routineReady: 'Hier is uw persoonlijke routine, voor de ochtend en de avond.',
  },

  purchase: { around: 'Routine eromheen opbouwen', running_low: 'Het is bijna op', focus: 'Richten op mijn huidprobleem' },

  repurchase: (name, days, promo) => `We zagen dat u eerder tevreden was over „${name}”. Uw laatste bestelling is nu **${days} dagen** geleden. Wilt u het opnieuw bestellen?${promo ? ` Er is op dit moment zelfs ${promo} korting op dit product.` : ''}`,
  percent: (n) => `${n}%`,

  orderReminder: 'Vergeet niet uw bestelnummer in het formulier te vermelden.',

  thatCode: 'die code',

  mock: {
    default: 'Bedankt voor uw bericht. Dit is een demo-antwoord: het advies is nog niet gekoppeld.',
    find_product: 'Graag. Om u op weg te helpen: vertel me iets over uw huid. Eerder droog, gemengd, vet of gevoelig? (Demo-antwoord.)',
    build_routine: 'Laten we samen uw routine samenstellen. Wilt u een ochtendroutine, een avondroutine of allebei? (Demo-antwoord.)',
    compare: 'Laat me weten tussen welke producten u twijfelt, dan help ik u ze te vergelijken. (Demo-antwoord.)',
    delivery_returns: 'Informatie over levering en retourneren vindt u hier binnenkort. (Demo-antwoord.)',
    offers: 'De actuele aanbiedingen vindt u hier binnenkort. (Demo-antwoord.)',
    product_title: 'Voorbeeldproduct',
    product_rationale: 'Demokaart: de echte suggesties komen met de catalogus.',
  },
};
