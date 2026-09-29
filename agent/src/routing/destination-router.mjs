// Which destination a ticket goes to, if any.
//
// Two halves. `planRoute` is pure: the ticket's category and kind against the
// configured destinations decide whether there is nothing to do, one obvious
// destination, or a choice. Only a choice reaches `createDestinationChooser`,
// which asks the cheap model to pick from the destinations' own descriptions —
// or to keep the ticket.
//
// A CHOICE IS RARE BY CONSTRUCTION. careers, partnerships and cosmetovigilance
// have one destination each and never reach the model. On the measured corpus
// the choice is b2b: 19 tickets over two and a half months, 11 of them Nocibé
// reorder POs that no destination owns.
//
// « KEEP » IS ALWAYS AN ANSWER, and the one to give when unsure. A ticket kept
// is one the contact team reads, which is what happens today; a ticket forwarded
// to the wrong colleague, with an acknowledgement telling the sender it went to
// the right one, is worse than that.

import { candidatesFor } from '../../../scripts/lib/forwarding-destinations.mjs';

/**
 * @returns {{ route: 'stays' | 'fixed' | 'choose', candidates: object[] }}
 *
 * `fixed` takes the lone destination without reading the mail, unless that
 * destination only takes mail matching its description — then it is a choice
 * between it and keeping the ticket.
 */
export function planRoute({ ticket, destinations }) {
  const candidates = candidatesFor(destinations, {
    category: ticket?.category,
    requestKind: ticket?.request_kind
  });
  if (candidates.length === 0) {
    return { route: 'stays', candidates };
  }
  if (candidates.length === 1 && !candidates[0].match_description) {
    return { route: 'fixed', candidates };
  }
  return { route: 'choose', candidates };
}

const SYSTEM_PROMPT = [
  "Tu reçois un e-mail arrivé dans la boîte du service client. Seul le service client travaille dans cette boîte : ce qui relève d'un autre service doit lui être transmis.",
  "On te donne la liste des services qui peuvent le recevoir, chacun avec ce qu'il traite, décrit par l'entreprise elle-même. Choisis celui dont la description correspond à la demande.",
  "Si aucun ne correspond clairement, réponds « garder » : le message reste au service client, qui le lira. C'est la bonne réponse en cas de doute. Un message transmis au mauvais service est pire qu'un message gardé.",
  "Le domaine de l'expéditeur et la langue aident à situer l'expéditeur (France ou étranger), sans suffire à eux seuls.",
  "reason : une seule ligne très courte (15 mots maximum) justifiant le choix.",
  "Tu ne réponds pas à l'expéditeur : tu ne fais que choisir."
].join('\n');

/**
 * @param {object} openai  the shared client (`completeJson`)
 * @param {{ model: string, maxBodyChars?: number }} options
 */
export function createDestinationChooser(openai, { model, maxBodyChars = 2000 } = {}) {
  /**
   * @param {{ subject?: string, messages: Array<{ subject?: string, body_text?: string }>, senderDomain?: string|null, senderLabel?: string|null, language?: string|null }} input
   * @param {object[]} candidates  destination rows, from `planRoute`
   * @param {{ ticketId?: string|null }} [context]
   * @returns {Promise<{ destination: object|null, reason: string, model: string }>}
   *
   * The sender's DOMAIN is shown, never the address or a name: it is what tells
   * `tgertrading.co.uk` from a French institute, and a consumer's `gmail.com`
   * identifies nobody. The same minimisation the review set applies.
   */
  async function choose(input, candidates, { ticketId = null } = {}) {
    const ids = candidates.map((_, index) => `S${index + 1}`);
    const raw = await openai.completeJson({
      model,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(input, candidates, ids, maxBodyChars),
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // Ids rather than labels: a label is whatever a person typed, and an
          // enum of free text is one accent away from a mismatch.
          destination: { type: 'string', enum: [...ids, 'garder'] },
          reason: { type: 'string' }
        },
        required: ['destination', 'reason']
      },
      schemaName: 'destination_choice',
      maxTokens: 120,
      pass: 'other',
      ticketId
    });
    const index = ids.indexOf(raw?.destination);
    return {
      destination: index >= 0 ? candidates[index] : null,
      reason: String(raw?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      model
    };
  }

  return { choose };
}

/** Exported for tests: the whole of what the model is shown. */
export function buildUserPrompt(input, candidates, ids, maxBodyChars = 2000) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const first = messages[0];
  const latest = messages.length > 1 ? messages[messages.length - 1] : null;

  const lines = ['Services possibles :'];
  candidates.forEach((candidate, index) => {
    lines.push(`- ${ids[index]} — ${candidate.label} : ${candidate.description || '(pas de description)'}`);
  });
  lines.push('- garder — aucun ne correspond clairement : le service client garde le message.');

  lines.push(
    '',
    `Domaine de l'expéditeur : ${input?.senderDomain || 'inconnu'}` +
      (input?.senderLabel ? ` (connu de nous : ${SENDER_LABELS[input.senderLabel] || input.senderLabel})` : ''),
    `Langue : ${input?.language || 'inconnue'}`,
    `Objet : ${input?.subject || first?.subject || '(aucun)'}`,
    '',
    'Premier message :',
    truncate(first?.body_text, maxBodyChars) || '(vide)'
  );
  if (latest) {
    lines.push('', 'Dernier message du fil :', truncate(latest.body_text, maxBodyChars) || '(vide)');
  }
  return lines.join('\n');
}

/** How a Senders-directory label reads to the model. */
const SENDER_LABELS = {
  retailer: 'enseigne qui revend nos produits',
  distributor: 'distributeur',
  supplier: 'fournisseur',
  partner: 'partenaire',
  logistics: 'prestataire logistique',
  courier: 'transporteur',
  contractor: 'prestataire',
  internal: 'collègue',
  other: 'contact connu'
};

function truncate(text, maxChars) {
  return String(text || '').slice(0, maxChars);
}
