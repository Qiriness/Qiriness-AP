// What one message did to a case: the closed vocabulary the Case Manager
// reads into, and the labelled set is written in (eval/casework-vocabulary.mjs
// re-exports these). One list for both, so a value the labels use is one the
// Case Manager can say.

/** What a message RECEIVED on the thread did to the case. */
export const INBOUND_EFFECTS = {
  continuation: 'Même demande, qui avance',
  // A CHASE IS ITS OWN VALUE because the labeller kept needing it: four notes in
  // the first batch say « relance », filed as continuation twice and as new
  // information twice. It is what the delay apology keys on, and the pipeline
  // reads it as `continuation`.
  chase: 'Relance (même demande, rien de nouveau)',
  new_information: "Apporte un élément (réponse, preuve, correction)",
  new_issue: 'Nouvelle demande dans le même fil',
  closes_case: 'Clôt la demande (merci, reçu, plus besoin)',
  internal_note: 'Échange interne / prestataire, sans le client',
  noise: 'Rien (accusé automatique, doublon, hors sujet)'
};

/** What a message WE SENT did to the case. */
export const OUTBOUND_EFFECTS = {
  answers: 'Répond à la demande',
  asks_customer: 'Demande quelque chose au client',
  holding: 'Fait patienter (vérification en cours)',
  closes_case: 'Clôt le dossier',
  internal_request: 'Demande à un collègue ou à un prestataire'
};

/** The effects a message can have, given who wrote it. */
export function effectsFor(actor) {
  return actor === 'support' ? OUTBOUND_EFFECTS : INBOUND_EFFECTS;
}
