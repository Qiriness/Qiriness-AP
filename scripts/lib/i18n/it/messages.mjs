/**
 * Italian: every sentence the server writes itself. The same keys as fr/messages.mjs, which documents
 * each one. The formal « Lei », as the French « vous ». Written 2026-10-30, not yet reviewed by a
 * native speaker (VALIDATION_LOG).
 */
export default {
  code: 'it',

  languageName: 'Italian',
  formalAddress: 'Lei',
  lowercaseInSentence: true,

  flow: {
    offer: 'Desidera che Le prepari una routine personalizzata?',
    yes: 'Sì, volentieri',
    no: 'No, grazie',
    purchase: (name) => `Vedo che ha già acquistato ${name}. Desidera costruire la Sua routine attorno a questo prodotto, ne ha quasi finito, oppure preferisce concentrarsi sulla Sua esigenza?`,
    runningLow: (name) => `Può ritrovare ${name} qui, oppure aggiungerlo direttamente al carrello.`,
    // Their concern without an article (« in caso di rughe »): right whatever its gender.
    treatAfterRoutine: (concern) => concern ? `E per un momento di dolcezza, ideale in caso di ${concern}, questo piccolo piacere potrebbe piacerLe:` : 'E per un momento di dolcezza, questo piccolo piacere potrebbe piacerLe:',
    treatAfterNo: 'Va benissimo. Se avesse voglia di un piccolo piacere, questo potrebbe piacerLe:',
    cartOne: (name) => `Desidera che aggiunga ${name} al Suo carrello?`,
    cartRoutine: 'Desidera che aggiunga questa routine al Suo carrello?',
    cartRoutineDiscount: 'Desidera che aggiunga questa routine al Suo carrello? Lo sconto routine verrà applicato automaticamente.',
    cartYes: 'Sì, aggiungi',
    cartYesDiscount: 'Sì, aggiungi con lo sconto',
    cartDiscount: 'Lo sconto routine è applicato al Suo carrello.',
    cartNo: 'Sto ancora guardando',
    cartDone: (names) => `Perfetto, aggiungo al Suo carrello: ${names}.`,
    cartSize: (names) => `Per ${names}, scelga il formato nella pagina del prodotto.`,
    cartRoutineDone: 'Perfetto, aggiungo al Suo carrello i prodotti inclusi nella Sua routine.',
    cartNoDone: 'Certo, si prenda tutto il tempo che vuole.',
    routineReady: 'Ecco la Sua routine personalizzata, mattina e sera.',
  },

  purchase: { around: 'Costruire la routine attorno', running_low: 'Ne ho quasi finito', focus: 'Concentrarmi sulla mia esigenza' },

  repurchase: (name, days, promo) => `Abbiamo notato che ha già apprezzato « ${name} ». Sono passati **${days} giorni** dal Suo ultimo ordine. Desidera riacquistarlo?${promo ? ` In questo momento c'è anche una promozione del ${promo} su questo prodotto.` : ''}`,
  percent: (n) => `${n}%`,

  orderReminder: 'Non dimentichi di indicare il numero dell’ordine nel modulo.',

  thatCode: 'quel codice',

  mock: {
    default: 'Grazie per il Suo messaggio. Questa è una risposta dimostrativa: il consulente non è ancora collegato.',
    find_product: 'Con piacere. Per orientarLa, mi dica qualcosa in più sulla Sua pelle: secca, mista, grassa o sensibile? (Risposta dimostrativa.)',
    build_routine: 'Costruiamo insieme la Sua routine. Desidera una routine per la mattina, per la sera o per entrambe? (Risposta dimostrativa.)',
    compare: 'Mi indichi i prodotti tra cui è indecisa: La aiuterò a confrontarli. (Risposta dimostrativa.)',
    delivery_returns: 'Le informazioni su consegne e resi saranno presto disponibili qui. (Risposta dimostrativa.)',
    offers: 'Le offerte del momento saranno presto disponibili qui. (Risposta dimostrativa.)',
    product_title: 'Prodotto di esempio',
    product_rationale: 'Scheda dimostrativa: i suggerimenti reali arriveranno con il catalogo.',
  },
};
