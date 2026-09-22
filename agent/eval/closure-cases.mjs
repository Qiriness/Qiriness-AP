// The labelled set for closure detection: does the customer's last message end
// their request?
//
// IDS AND BOOLEANS ONLY, NEVER BODIES. Every other eval corpus in this
// directory is invented dummy mail, because AGENTS.md forbids real customer
// messages in the repo. That rule is about the TEXT: a ticket id and a label are
// not personal data, and the runner reads the bodies from the database at run
// time. `diagnose-exemplars.mjs` already scores live tickets the same way.
//
// THE POPULATION IS EVERY THREAD WHERE A CUSTOMER WROTE AFTER OUR REPLY — all 16
// of them as of 2026-09-21, not a sample. That is the only population where a
// closure can occur, and it is small enough to take whole. Nothing is excluded
// for being awkward; the awkward ones are the point.
//
// THESE LABELS ARE MINE, NOT THE DESK'S. They were read once, by the author of
// the check they score, which is the weakest kind of labelled set there is — a
// judge marking its own homework, and the exact failure `evidence-rules.mjs`
// warns about. They are checked in so a person can disagree with them in a diff.
// Treat a score against them as a regression signal, never as an accuracy claim.
//
// `expectedClosure` is whether PRODUCTION should write a closing reply — the two
// layers together, not the model alone. `gateOpen` is
// whether `closureAllowed` lets it be asked at all, and on most of these it does
// not — which is the two-layer design working, and the reason both are scored
// separately.

export const CLOSURE_CASES = [
  // --- genuine closures ------------------------------------------------------
  {
    ticketId: '1e4890dd-e5cf-47d8-887b-bb5b2a2e93d1',
    expectedClosure: true,
    note: '« La commande a effectivement été livrée. Mes inquiétudes n’étaient pas fondées. » Rien de plus attendu.'
  },
  {
    ticketId: 'b781cfba-43b7-4cb3-a2a4-5f272fc3bfd7',
    expectedClosure: true,
    note: 'Confirme la réception de sa commande et remercie.'
  },
  {
    ticketId: '1d38908b-9a9f-4ea7-b36a-c19870c5cef6',
    expectedClosure: true,
    note: 'Confirme avoir reçu l’information du transporteur.'
  },
  {
    ticketId: 'e8903620-abf4-4488-b5cc-706dc8c9e2bc',
    // RELABELLED 2026-09-21, and the first label was wrong. « Bonne nouvelle !
    // Merci pour votre message » reads as a customer closing — and it is from
    // `dnouali@lap-groupe.com`. The customer (a yahoo.com address) wrote once,
    // at the start, and never closed anything. Read on the text alone this is a
    // closure; read with the sender it is a colleague, and the reply would have
    // gone to the customer on the strength of internal chatter.
    expectedClosure: false,
    note: 'Dernier message d’un collègue (lap-groupe.com), pas du client.'
  },

  // --- the traps -------------------------------------------------------------
  {
    ticketId: 'd6d0d1c3-6176-4923-9c82-7c2a1407fd82',
    // FALSE, because this scores what PRODUCTION should do, not what a model
    // reading the message alone would say. Read in isolation this message closes;
    // read against the dossier it does not, and the gate is what knows the
    // difference. Labelling it `true` scored the two-layer design as a miss for
    // working exactly as intended.
    expectedClosure: false,
    gateOpen: false,
    // THE CASE THE TWO-LAYER DESIGN EXISTS FOR. The message closes the delivery
    // question and the free mask is still missing, so the case file reads
    // `needs_human` and the gate never opens. The model is right and must not
    // be asked.
    note: 'Clôt la livraison, pas le dossier : le masque offert manque toujours. Le garde-fou code doit l’arrêter avant l’appel.'
  },
  {
    ticketId: '5836ab80-4474-4ee6-bc3a-4b7f6fe1e486',
    expectedClosure: false,
    gateOpen: false,
    note: 'Court et sans point d’interrogation, mais apporte une information nouvelle : le lien mène à un panier vide.'
  },
  {
    ticketId: 'fcf4ca11-d842-4fda-8436-2575d7b5fd79',
    expectedClosure: false,
    // NO `sender_label` on the ticket, so nothing upstream stops this and the
    // A colleague telling another colleague that an order shipped is not the
    // customer ending their request, and a « ravis que tout soit réglé » written
    // from it would go to the customer on the strength of an internal note.
    note: 'Message interne entre collègues annonçant l’expédition — le client n’a rien dit.'
  },
  {
    ticketId: 'bdc3f08c-db6a-4245-b0e8-456b821f6762',
    expectedClosure: false,
    gateOpen: false,
    note: 'Avoir créé, mais un écart Divalto/Shopify reste ouvert.'
  },
  {
    ticketId: 'e27ef32d-0fea-463e-be0a-cd31735d450e',
    expectedClosure: false,
    gateOpen: false,
    note: 'Conteste nos explications — l’opposé d’une clôture.'
  },
  {
    ticketId: '718086fd-8d5a-4045-8bfe-eda9e4ddde0e',
    expectedClosure: false,
    gateOpen: false,
    note: 'Remercie longuement ET explique pourquoi il a insisté ; le dossier reste chez un humain.'
  },
  {
    ticketId: 'd48f1c08-16dd-4554-af55-7006e1bf439b',
    expectedClosure: false,
    gateOpen: false,
    note: 'Envoie les photos demandées : c’est une réponse à notre question, pas une clôture.'
  },

  // --- 3PL and internal coordination, all gate-shut --------------------------
  {
    ticketId: '039f758f-d97d-4bc9-ae75-c07b06a69e28',
    expectedClosure: false,
    gateOpen: false,
    note: 'Deret, pièce jointe sans texte.'
  },
  {
    ticketId: '1317b335-de1d-42ac-8101-ca38cc7009b8',
    expectedClosure: false,
    gateOpen: false,
    note: 'Deret : le colis est en cours de retour.'
  },
  {
    ticketId: '8236165a-4720-4ba7-a39f-e46dd554f214',
    expectedClosure: false,
    gateOpen: false,
    note: 'Deret transmet un numéro de suivi et une réclamation.'
  },
  {
    ticketId: '90046ff6-1c47-47f5-abd7-29502afaffa1',
    expectedClosure: false,
    gateOpen: false,
    note: 'Deret explique un écart d’inventaire.'
  },
  {
    ticketId: '926d9a0f-b452-4f3d-9ab8-c1a7cc6ec074',
    expectedClosure: false,
    gateOpen: false,
    note: 'Deret : réclamation ouverte auprès de GLS.'
  }
];
