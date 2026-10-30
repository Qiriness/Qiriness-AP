/**
 * German: every sentence the server writes itself. The same keys as fr/messages.mjs, which documents
 * each one. The formal « Sie », as the French « vous ». Written 2026-10-30, not yet reviewed by a
 * native speaker (VALIDATION_LOG).
 */
export default {
  code: 'de',

  languageName: 'German',
  formalAddress: 'Sie',
  lowercaseInSentence: false,

  flow: {
    offer: 'Möchten Sie, dass ich Ihnen eine persönliche Pflegeroutine zusammenstelle?',
    yes: 'Ja, gerne',
    no: 'Nein, danke',
    purchase: (name) => `Wie ich sehe, haben Sie bereits ${name} gekauft. Möchten Sie Ihre Routine darum herum aufbauen, geht es Ihnen bald aus, oder möchten Sie sich lieber auf Ihr Hautanliegen konzentrieren?`,
    runningLow: (name) => `Hier finden Sie ${name} wieder, oder Sie legen es direkt in Ihren Warenkorb.`,
    // Their concern without an article (« ideal bei Falten »): right whatever its gender.
    treatAfterRoutine: (concern) => concern ? `Und für einen Moment der Entspannung, ideal bei ${concern}, könnte Ihnen diese kleine Verwöhnpflege gefallen:` : 'Und für einen Moment der Entspannung könnte Ihnen diese kleine Verwöhnpflege gefallen:',
    treatAfterNo: 'Sehr gerne. Falls Sie Lust auf eine kleine Verwöhnpflege haben, könnte Ihnen diese gefallen:',
    cartOne: (name) => `Möchten Sie, dass ich ${name} in Ihren Warenkorb lege?`,
    cartRoutine: 'Möchten Sie, dass ich diese Routine in Ihren Warenkorb lege?',
    cartRoutineDiscount: 'Möchten Sie, dass ich diese Routine in Ihren Warenkorb lege? Ihr Routine-Rabatt wird automatisch abgezogen.',
    cartYes: 'Ja, hinzufügen',
    cartYesDiscount: 'Ja, mit Rabatt hinzufügen',
    cartDiscount: 'Ihr Routine-Rabatt ist in Ihrem Warenkorb berücksichtigt.',
    cartNo: 'Ich schaue noch',
    cartDone: (names) => `Gerne, ich lege in Ihren Warenkorb: ${names}.`,
    cartSize: (names) => `Für ${names} wählen Sie bitte die Größe auf der Produktseite.`,
    cartRoutineDone: 'Gerne, ich lege die Produkte Ihrer Routine in Ihren Warenkorb.',
    cartNoDone: 'Sehr gerne, lassen Sie sich Zeit.',
    routineReady: 'Hier ist Ihre persönliche Routine, morgens und abends.',
  },

  purchase: { around: 'Routine darum aufbauen', running_low: 'Es geht mir bald aus', focus: 'Auf mein Hautanliegen konzentrieren' },

  repurchase: (name, days, promo) => `Wir haben bemerkt, dass Ihnen „${name}“ bereits gefallen hat. Ihre letzte Bestellung ist nun **${days} Tage** her. Möchten Sie es erneut bestellen?${promo ? ` Gerade gibt es sogar ${promo} Rabatt auf dieses Produkt.` : ''}`,
  percent: (n) => `${n} %`,

  orderReminder: 'Bitte geben Sie im Formular Ihre Bestellnummer an.',

  thatCode: 'diesen Code',

  mock: {
    default: 'Vielen Dank für Ihre Nachricht. Dies ist eine Demo-Antwort: Die Beratung ist noch nicht verbunden.',
    find_product: 'Sehr gerne. Damit ich Sie beraten kann, erzählen Sie mir etwas über Ihre Haut: eher trocken, Mischhaut, fettig oder empfindlich? (Demo-Antwort.)',
    build_routine: 'Lassen Sie uns gemeinsam Ihre Routine zusammenstellen. Möchten Sie eine Morgenroutine, eine Abendroutine oder beides? (Demo-Antwort.)',
    compare: 'Nennen Sie mir die Produkte, zwischen denen Sie schwanken, und ich helfe Ihnen beim Vergleich. (Demo-Antwort.)',
    delivery_returns: 'Informationen zu Lieferung und Rücksendung finden Sie bald hier. (Demo-Antwort.)',
    offers: 'Die aktuellen Angebote finden Sie bald hier. (Demo-Antwort.)',
    product_title: 'Beispielprodukt',
    product_rationale: 'Demo-Karte: Die echten Vorschläge kommen mit dem Katalog.',
  },
};
