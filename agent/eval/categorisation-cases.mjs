// Labelled review set for the categoriser (AGENT_INTEGRATION_PLAN Phase 3 exit
// criterion: "agrees with human labelling on a review set").
//
// All content is INVENTED dummy data — realistic French support mail written for
// this file, never a real customer email (AGENTS.md: dummy data in development
// and tests). Replace or extend with anonymised real mail once the live support
// mailbox is connected; the harness does not care where a case came from.
//
// Each case:
//   expect  - the human label. `level` follows defaultLevel() for the pair, so a
//             level mismatch means the model picked a different pair OR escalated.
//   accept  - alternative values a human reviewer would also accept. Real support
//             mail is genuinely ambiguous (a damaged parcel is an order problem
//             *and* a delivery problem); scoring without this measures agreement
//             with one arbitrary reading rather than correctness.
//   note    - what the case is actually testing, so a regression is diagnosable.

export const CASES = [
  // --- order ---------------------------------------------------------------
  {
    id: 'order-status',
    subject: 'Où en est ma commande ?',
    body: "Bonjour,\n\nJ'ai passé la commande #1042 il y a une semaine et je n'ai aucune nouvelle. Pouvez-vous me dire où elle en est ?\n\nMerci d'avance,\nCamille",
    expect: { category: 'order', request_kind: 'problem', level: 2 },
    accept: { category: ['delivery'], request_kind: ['question'] },
    note: 'the most common email there is. Answering needs THIS customer record open, so problem, not question — and looking it up changes nothing, so level 2.'
  },
  {
    id: 'order-add-item',
    subject: 'Ajout à ma commande',
    body: "Bonjour, je viens de commander le sérum et j'aimerais ajouter la crème de nuit à la même commande avant l'expédition. Est-ce possible ?",
    expect: { category: 'order', request_kind: 'problem', level: 3 },
    accept: { request_kind: ['question'], level: [2] },
    note: 'asks a question but needs a state-changing action to satisfy'
  },
  {
    id: 'order-cancel',
    subject: 'Annulation',
    body: "Je souhaite annuler ma commande passée ce matin, je me suis trompée de produit. Merci de me confirmer l'annulation.",
    expect: { category: 'order', request_kind: 'problem', level: 3 },
    accept: { level: [2] },
    note: 'cancellation changes something -> 3, not a lookup'
  },
  {
    id: 'order-wrong-item',
    subject: 'Erreur dans ma commande',
    body: "Bonjour, j'ai reçu le baume lèvres alors que j'avais commandé le contour des yeux. Comment fait-on ?",
    expect: { category: 'delivery', request_kind: 'problem', level: 3 },
    accept: { category: ['order', 'return_exchange'], level: [2] },
    note: 'discovered AFTER dispatch, so delivery under the dispatch boundary; needs a resend'
  },

  // --- delivery ------------------------------------------------------------
  {
    id: 'delivery-stuck',
    subject: 'Colis bloqué',
    body: "Le suivi de mon colis n'a pas bougé depuis 5 jours, il est toujours marqué « en transit ». Est-ce normal ?",
    expect: { category: 'delivery', request_kind: 'problem', level: 2 },
    accept: { level: [3] },
    note: 'look up the tracking and reply — nothing is changed, so level 2 not 3'
  },
  {
    id: 'delivery-lost',
    subject: 'Colis jamais reçu',
    body: "Bonjour,\n\nLe transporteur indique que mon colis a été livré vendredi mais je n'ai rien reçu, ni dans ma boîte ni chez mes voisins. Que puis-je faire ?",
    expect: { category: 'delivery', request_kind: 'problem', level: 3 },
    accept: { level: [2] },
    note: 'lost parcel: a resend or refund changes something -> 3'
  },
  {
    id: 'delivery-wrong-address',
    subject: 'Erreur adresse',
    body: "Je me suis trompée dans l'adresse de livraison, j'ai mis mon ancienne adresse. La commande n'est pas encore partie je pense. Pouvez-vous la corriger ?",
    expect: { category: 'delivery', request_kind: 'problem', level: 3 },
    accept: { category: ['order'], level: [2] },
    note: 'address correction changes something -> 3. Before dispatch, so order is defensible.'
  },
  {
    id: 'delivery-angry',
    subject: 'INADMISSIBLE',
    body: "Trois semaines que j'attends ce colis. Personne ne répond à mes mails. C'est un manque de respect total pour vos clients, je suis extrêmement déçue de votre service.",
    expect: { category: 'delivery', request_kind: 'complaint', level: 3 },
    accept: { request_kind: ['problem'], level: [2] },
    note: 'ANGRY BUT NOT LEVEL 4 — no legal threat, no injury. The main false-4 trap. Borderline kind: no concrete request is made, so complaint, but reading the implied "where is it" as a problem is defensible.'
  },

  // --- return / exchange ---------------------------------------------------
  {
    id: 'return-request',
    subject: 'Retour produit',
    body: "Bonjour, le produit ne me convient pas du tout, je souhaite le retourner et être remboursée. Comment dois-je procéder ?",
    expect: { category: 'return_exchange', request_kind: 'problem', level: 3 },
    accept: { request_kind: ['question'] },
    note: 'return request'
  },
  {
    id: 'return-policy',
    subject: 'Délai de rétractation',
    body: "Bonjour, quel est votre délai de rétractation ? Je voudrais offrir un coffret mais je ne suis pas sûre qu'il plaise.",
    expect: { category: 'return_exchange', request_kind: 'question', level: 1 },
    note: 'answerable from knowledge alone — the level 1 case'
  },
  {
    id: 'refund-missing',
    subject: 'Remboursement non reçu',
    body: "J'ai renvoyé mon colis il y a trois semaines, vous l'avez bien reçu d'après le suivi, mais je n'ai toujours pas été remboursée.",
    expect: { category: 'return_exchange', request_kind: 'problem', level: 3 },
    accept: { category: ['payment'] },
    note: 'return vs payment is a legitimate split'
  },

  // --- product -------------------------------------------------------------
  {
    id: 'product-advice',
    subject: 'Conseil peau sèche',
    body: "Bonjour, j'ai la peau très sèche et réactive en hiver. Quel produit me conseillez-vous dans votre gamme ?",
    expect: { category: 'product', request_kind: 'question', level: 1 },
    note: 'advice is a product question, no lookup needed'
  },
  {
    id: 'product-ingredients',
    subject: 'Composition du sérum',
    body: "Est-ce que votre sérum contient du parfum ou des huiles essentielles ? Je suis enceinte et je fais attention.",
    expect: { category: 'product', request_kind: 'question', level: 1 },
    note: 'ingredient question; pregnancy is context, not a severity trigger'
  },
  {
    id: 'product-usage',
    subject: 'Utilisation',
    body: "Combien de fois par jour faut-il appliquer la crème ? Et avant ou après le sérum ?",
    expect: { category: 'product', request_kind: 'question', level: 1 },
    note: 'usage instructions'
  },
  {
    id: 'product-quality-complaint',
    subject: 'Flacon à moitié vide',
    body: "J'ai ouvert mon flacon et il était à moitié vide. Pour ce prix je trouve ça vraiment décevant.",
    expect: { category: 'product', request_kind: 'complaint', level: 3 },
    accept: { category: ['order', 'delivery'] },
    note: 'dissatisfaction about the product itself'
  },

  // --- stock ---------------------------------------------------------------
  {
    id: 'stock-restock',
    subject: 'Réapprovisionnement',
    body: "Bonjour, le baume réparateur est en rupture depuis un moment. Savez-vous quand il sera de nouveau disponible ?",
    expect: { category: 'product_stock', request_kind: 'question', level: 2 },
    note: 'stock question needs a lookup -> level 2'
  },

  // --- payment -------------------------------------------------------------
  {
    id: 'payment-double-charge',
    subject: 'Double débit',
    body: "J'ai été débitée deux fois du même montant pour une seule commande. Merci de me rembourser la seconde transaction.",
    expect: { category: 'payment', request_kind: 'problem', level: 3 },
    accept: { level: [2] },
    note: 'a refund changes something -> 3'
  },
  {
    id: 'payment-methods',
    subject: 'Moyens de paiement',
    body: "Bonjour, acceptez-vous les paiements en plusieurs fois ou PayPal ?",
    expect: { category: 'payment', request_kind: 'question', level: 2 },
    note: 'payment questions floor at 2 by the lookup rule even when knowledge would answer'
  },
  {
    id: 'invoice-request',
    subject: 'Facture',
    body: "Pourriez-vous m'envoyer la facture de ma commande du mois dernier ? J'en ai besoin pour ma comptabilité.",
    expect: { category: 'payment', request_kind: 'question', level: 2 },
    accept: { request_kind: ['problem'], level: [3] },
    note: 'invoice request'
  },

  // --- account -------------------------------------------------------------
  {
    id: 'account-login',
    subject: 'Connexion impossible',
    body: "Impossible de me connecter à mon compte, le mot de passe est refusé et je ne reçois pas le mail de réinitialisation.",
    expect: { category: 'account', request_kind: 'problem', level: 3 },
    accept: { level: [2] },
    note: 'a password reset changes something -> 3'
  },
  {
    id: 'account-newsletter',
    subject: 'Désinscription',
    body: "Merci de me désinscrire de votre newsletter, je reçois trop de mails.",
    expect: { category: 'account', request_kind: 'problem', level: 3 },
    accept: { category: ['legal_privacy'], request_kind: ['contact'] },
    note: 'unsubscribe sits between account and privacy; both defensible'
  },

  // --- promotions ----------------------------------------------------------
  {
    id: 'promo-code-broken',
    subject: 'Code promo refusé',
    body: "Mon code BIENVENUE10 ne fonctionne pas au moment de payer, il me dit qu'il est invalide alors qu'il est encore valable.",
    expect: { category: 'promotions', request_kind: 'problem', level: 2 },
    accept: { level: [3] },
    note: 'look up why the code was refused (often not stackable) and reply — level 2'
  },
  {
    id: 'promo-question',
    subject: 'Offres à venir',
    body: "Bonjour, prévoyez-vous des offres pour le Black Friday cette année ?",
    expect: { category: 'promotions', request_kind: 'question', level: 2 },
    note: 'general question, but promotions is a lookup subject so the floor is 2'
  },

  // --- cosmetovigilance: the level rule that changed -----------------------
  {
    id: 'cosmeto-mild-reaction',
    subject: 'Rougeurs',
    body: "Bonjour, j'ai appliqué la crème hier soir et ce matin j'ai des rougeurs et ça me démange un peu sur les joues. Est-ce que je dois arrêter ?",
    expect: { category: 'cosmetovigilance', request_kind: 'problem', level: 2 },
    accept: { category: ['product'], request_kind: ['question'], level: [1] },
    note: 'MUST NOT BE LEVEL 4 — natural formulation, mild reaction, answerable with advice'
  },
  {
    id: 'cosmeto-hospital',
    subject: 'Réaction grave',
    body: "Ma fille a utilisé votre masque samedi et a fait un œdème du visage. Elle a été hospitalisée dimanche et est sous corticoïdes. Je veux savoir ce qu'il y a dans ce produit.",
    expect: { category: 'cosmetovigilance', request_kind: 'problem', level: 4 },
    note: 'ESCALATION: hospitalisation is one of the three level-4 triggers'
  },
  {
    id: 'cosmeto-allergy-question',
    subject: 'Allergie nickel',
    body: "Je suis allergique au nickel, est-ce que vos produits sont sans risque pour moi ?",
    expect: { category: 'product', request_kind: 'question', level: 1 },
    accept: { category: ['cosmetovigilance'] },
    note: 'a preventive question is not an adverse-reaction report'
  },

  // --- legal / privacy -----------------------------------------------------
  {
    id: 'rgpd-erasure',
    subject: 'Suppression de mes données',
    body: "Conformément au RGPD, je vous demande la suppression de l'ensemble des données personnelles me concernant ainsi que la confirmation de cette suppression.",
    expect: { category: 'legal_privacy', request_kind: 'problem', level: 3 },
    note: 'MUST NOT BE LEVEL 4 — routine compliance work, a human acts'
  },
  {
    id: 'legal-threat',
    subject: 'Dernier rappel avant procédure',
    body: "Sans remboursement sous 8 jours, je transmets le dossier à mon avocat et je saisis la répression des fraudes. J'ai également prévenu un journaliste qui suit ce genre d'affaires.",
    expect: { category: 'payment', request_kind: 'problem', level: 4 },
    accept: { category: ['order', 'return_exchange', 'legal_privacy', 'other'], request_kind: ['complaint'] },
    note: 'ESCALATION: explicit legal threat + public exposure. A refund IS demanded, so problem rather than complaint — anger shows in the level, not the kind.'
  },

  // --- inbound relationships (the `contact` kind) --------------------------
  {
    id: 'b2b-reseller',
    subject: 'Demande de partenariat revendeur',
    body: "Bonjour,\n\nNous sommes une pharmacie à Lyon et souhaiterions référencer votre gamme. Pourriez-vous nous communiquer vos conditions revendeur et votre tarif professionnel ?\n\nCordialement",
    expect: { category: 'b2b', request_kind: 'contact', level: 2 },
    accept: { request_kind: ['question'], level: [1] },
    note: 'the contact kind on a relationship subject'
  },
  {
    id: 'b2b-invoice-missing',
    subject: 'Facture manquante commande grossiste',
    body: "Bonjour, nous n'avons pas reçu la facture correspondant à notre commande de 40 unités du mois dernier. Notre comptabilité en a besoin rapidement.",
    expect: { category: 'b2b', request_kind: 'problem', level: 3 },
    accept: { category: ['payment'] },
    tolerateSecondary: ['payment'],
    note: 'a B2B email that is not an approach but a problem; a payment secondary is defensible'
  },
  {
    id: 'influencer',
    subject: 'Collaboration',
    body: "Hello ! Je suis créatrice de contenu beauté (42k abonnés sur Instagram), j'adore votre univers et j'aimerais beaucoup collaborer avec vous. Je vous joins mon media kit.",
    expect: { category: 'partner_collaboration', request_kind: 'contact', level: 2 },
    note: 'influencer approach'
  },
  {
    id: 'press',
    subject: 'Demande presse',
    body: "Bonjour, je suis journaliste pour un magazine beauté et je prépare un article sur les marques de soin naturelles. Seriez-vous disponible pour répondre à quelques questions ?",
    expect: { category: 'partner_collaboration', request_kind: 'contact', level: 2 },
    note: 'press is a partnership approach, NOT a level-4 exposure threat'
  },
  {
    id: 'careers',
    subject: 'Candidature spontanée',
    body: "Bonjour, je vous adresse ma candidature spontanée pour un poste en marketing digital. Vous trouverez mon CV en pièce jointe.",
    expect: { category: 'careers', request_kind: 'contact', level: 2 },
    note: 'job application'
  },

  // --- two subjects in one email -------------------------------------------
  {
    id: 'secondary-delivery-stock',
    subject: 'Colis abîmé + question',
    body: "Bonjour, mon colis est arrivé avec le flacon cassé et de la crème partout dans la boîte. Par ailleurs, savez-vous si le sérum vitamine C sera bientôt réapprovisionné ? J'aimerais le commander.",
    expect: { category: 'delivery', request_kind: 'problem', level: 3 },
    expectSecondary: { category: 'product_stock', request_kind: 'question' },
    accept: { category: ['order'], level: [2] },
    note: 'the secondary pair: two subjects, two different kinds'
  },
  {
    id: 'secondary-order-advice',
    subject: 'Commande et conseil',
    body: "Bonjour, je voulais savoir où en est ma commande passée mardi. Et tant que je vous ai : quelle huile me conseillez-vous pour les cheveux bouclés ?",
    expect: { category: 'order', request_kind: 'problem', level: 2 },
    expectSecondary: { category: 'product', request_kind: 'question' },
    accept: { request_kind: ['question'] },
    note: 'a status chase (problem: needs the record) plus a general advice question — the two kinds genuinely differ'
  },

  // --- form and language robustness ----------------------------------------
  {
    id: 'english-order',
    subject: 'Shipping to Belgium',
    body: "Hi, I placed an order two days ago and I haven't received any shipping confirmation. Could you tell me when it will be dispatched? Thanks!",
    expect: { category: 'order', request_kind: 'problem', level: 2 },
    accept: { category: ['delivery'], request_kind: ['question'] },
    note: 'not every customer writes French; same status-chase shape as order-status'
  },
  {
    id: 'informal-typos',
    subject: 'commande',
    body: "bjr jai tjr pa recu ma commande sa fai 2 semene maintenan c long la merci de me repondre",
    expect: { category: 'delivery', request_kind: 'problem', level: 2 },
    accept: { category: ['order'], request_kind: ['complaint', 'question'], level: [3] },
    note: 'phonetic French with no punctuation — the realistic worst case. Look up first, so 2.'
  },
  {
    id: 'contact-phrasing-not-contact-kind',
    subject: 'Je vous contacte au sujet de ma commande',
    body: "Bonjour, je me permets de vous contacter au sujet de ma commande #1234 qui n'est jamais arrivée. Pouvez-vous m'aider ?",
    expect: { category: 'delivery', request_kind: 'problem', level: 2 },
    accept: { category: ['order'], level: [3] },
    note: 'the words "je vous contacte" must not produce the contact KIND (coerced anyway)'
  },
  {
    id: 'praise',
    subject: 'Bravo',
    body: "Juste un petit mot pour vous dire que j'adore vos produits et votre packaging. Continuez comme ça !",
    expect: { category: 'other', request_kind: 'question', level: 1 },
    accept: { category: ['product'], request_kind: ['contact'] },
    note: 'nothing is asked; contact on a non-relationship subject is coerced to question'
  },
  {
    id: 'vague',
    subject: '(sans objet)',
    body: "Bonjour, pouvez-vous me rappeler ? Merci. 06 12 34 56 78",
    expect: { category: 'other', request_kind: 'question', level: 1 },
    accept: { category: ['order'], request_kind: ['problem', 'contact'], level: [2, 3] },
    note: 'no signal at all — checks it degrades to other rather than inventing a subject'
  }
];
