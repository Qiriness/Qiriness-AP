/**
 * French: every sentence the server writes itself, never the model. A function takes the parts it
 * says, already in this language (a product's name, their concern's label). en/messages.mjs and every
 * other language have the same keys and arguments (i18n.test.mjs).
 */

// « vos rides », « votre déshydratation »: the concern's first word in the plural or not.
const possessive = (concern) => (/[sx]$/i.test(concern.split(/\s+/)[0]) ? 'vos' : 'votre');

export default {
  code: 'fr',

  /** routine-flow.mjs: the routine offer, the purchase question, the treat, the cart question. */
  /** A label inside a sentence starts in lower case (« vos rides »); German keeps its nouns' capitals. */
  /** The language's English name, and its formal « you » (empty where the prompt says it itself), for the model's instructions. */
  languageName: 'French',
  formalAddress: '',
  lowercaseInSentence: true,

  flow: {
    offer: 'Souhaitez-vous que je vous construise une routine personnalisée ?',
    yes: 'Oui, avec plaisir',
    no: 'Non merci',
    purchase: (name) => `Je vois que vous avez déjà acheté ${name}. Souhaitez-vous construire votre routine autour, vous en reste-t-il peu, ou préférez-vous vous concentrer sur votre préoccupation ?`,
    runningLow: (name) => `Vous pouvez retrouver ${name} ici, ou l'ajouter directement à votre panier.`,
    // With their concern (owner, 2026-10-19): « parfait pour atténuer vos imperfections ».
    treatAfterRoutine: (concern) => concern ? `Et pour un moment de douceur, parfait pour atténuer ${possessive(concern)} ${concern}, ce petit plaisir pourrait vous plaire :` : 'Et pour un moment de douceur, ce petit plaisir pourrait vous plaire :',
    treatAfterNo: "Très bien. Si l'envie vous prend d'un petit plaisir, celui-ci pourrait vous plaire :",
    cartOne: (name) => `Souhaitez-vous que j'ajoute ${name} à votre panier ?`,
    cartRoutine: 'Souhaitez-vous que j\'ajoute cette routine à votre panier ?',
    cartRoutineDiscount: 'Souhaitez-vous que j\'ajoute cette routine à votre panier ? Votre remise routine s\'y appliquera automatiquement.',
    cartYes: 'Oui, ajouter',
    cartYesDiscount: 'Oui, ajouter avec la remise',
    cartDiscount: 'Votre remise routine est appliquée à votre panier.',
    cartNo: 'Je cherche encore',
    cartDone: (names) => `C'est noté, j'ajoute à votre panier : ${names}.`,
    cartSize: (names) => `Pour ${names}, choisissez la taille sur sa page.`,
    cartRoutineDone: "C'est noté, j'ajoute à votre panier les soins inclus dans votre routine.",
    cartNoDone: 'Très bien, prenez votre temps.',
    routineReady: 'Voici votre routine personnalisée, matin et soir.',
  },

  /** purchase-turn.mjs: the buttons under « Je vois que vous avez déjà acheté… ». */
  purchase: { around: 'Construire ma routine autour', running_low: "Il m'en reste peu", focus: 'Me concentrer sur ma préoccupation' },

  /**
   * repurchase-opening.mjs: the owner's wording (2026-10-29). « en reprendre »: a product's name does
   * not say « le » or « la ». The days in bold (`**…**`, which the widget renders); the offer by its
   * reward only, never its name.
   */
  repurchase: (name, days, promo) => `Nous avons remarqué que vous aviez déjà apprécié « ${name} ». Cela fait maintenant **${days} jours** que vous ne l’avez pas commandé. Souhaitez-vous en reprendre ?${promo ? ` On a même une promo de ${promo} sur ce produit en ce moment.` : ''}`,
  /** A percentage as written in a sentence (« 20 % »). */
  percent: (n) => `${n} %`,

  /** llm-agent.mjs: after the contact form, for a message about an order (the form never sees this chat). */
  orderReminder: "N'oubliez pas d'indiquer votre numéro de commande dans le formulaire.",

  /** shopping-tools.mjs: said in place of a code that is never named. */
  thatCode: 'ce code',

  /** agent.mjs: the demo replies, when no model is connected. */
  mock: {
    default: 'Merci pour votre message. Ceci est une réponse de démonstration : le conseiller n\'est pas encore connecté.',
    find_product: 'Avec plaisir. Pour vous orienter, dites-m\'en un peu plus sur votre peau : plutôt sèche, mixte, grasse ou sensible ? (Réponse de démonstration.)',
    build_routine: 'Construisons votre routine ensemble. Souhaitez-vous une routine du matin, du soir, ou les deux ? (Réponse de démonstration.)',
    compare: 'Indiquez-moi les soins que vous hésitez à choisir, je vous aiderai à les comparer. (Réponse de démonstration.)',
    delivery_returns: 'Les informations de livraison et de retour seront bientôt disponibles ici. (Réponse de démonstration.)',
    offers: 'Les offres du moment seront bientôt disponibles ici. (Réponse de démonstration.)',
    product_title: 'Exemple de soin',
    product_rationale: 'Carte de démonstration : les vraies suggestions arriveront avec le catalogue.',
  },
};
