import { splitQuotedReply } from '../../../scripts/lib/quoted-reply.mjs';

import { senderRole, senderRoleName } from '../ingestion/sender-directory.mjs';

// Does the customer's latest message close their request?
//
// THE CHEAP HALF IS CODE AND RUNS FIRST. `closureAllowed` in `draft-rules.mjs`
// asks whether anything is still outstanding on OUR side — a named question, a
// point handed to a colleague — and that is answered from the case file with no
// model call. Only when nothing is outstanding is this asked, so the call
// happens on a small minority of tickets and never on the ones where the answer
// could not matter.
//
// THE ORDER IS THE WHOLE DESIGN, and `d6d0d1c3` is why. « J'ai bien réceptionné
// le colis. Merci encore » closes the DELIVERY question and the free mask is
// still missing, so the case file reads `needs_human`. Asked first, a model
// reading that message alone would say the case is closed, and it would be
// closing a case that owes the customer something. The code gate never lets the
// question be asked there.
//
// WHY A MODEL AT ALL. Measured over the 16 threads where a customer wrote after
// our reply: 5 are closures. A keyword rule cannot find them — « merci » opens
// as many messages as it ends, and « Merci de votre réponse. Je vous confirme
// que j'ai bien reçu ma commande » differs from « Merci d'avance » by meaning
// and not by vocabulary. Two of the seven shortest also carry NEW information
// (`5836ab80`, `bdc3f08c`) while looking structurally identical.
//
// IT NEVER DECIDES ALONE AND IT NEVER CLOSES A TICKET. It returns a boolean that
// selects a shorter reply. The status a ticket moves to is the verdict's, exactly
// as before.

export const CLOSURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['closes', 'why'],
  properties: {
    // `closes` first, because Structured Outputs emits fields in order and the
    // reason is worth having written AFTER the judgement rather than as a
    // rationalisation of one already committed to. The same ordering trap that
    // made `categorisation_confidence` a constant.
    closes: { type: 'boolean' },
    why: { type: 'string' }
  }
};

const SYSTEM = [
  "Tu lis le DERNIER message d'un client dans un échange de service client déjà traité.",
  "Une seule question : ce message clôt-il sa demande, ou attend-il encore quelque chose de nous ?",
  '',
  "`closes` = true uniquement si le message ne fait que confirmer que tout est réglé,",
  "remercier, ou les deux. Le client n'attend plus rien.",
  '',
  "`closes` = false dès que le message :",
  "- pose une question, même indirecte ;",
  "- apporte une information nouvelle sur un problème ;",
  "- signale que quelque chose ne va toujours pas ;",
  "- conteste, relance, ou demande une suite.",
  '',
  '',
  "L'ÉMETTEUR EST INDIQUÉ AU-DESSUS DU MESSAGE. Seul un message DU CLIENT peut",
  "clore sa demande. Un collègue ou un prestataire qui annonce qu'une commande",
  "est partie, qu'une réclamation est ouverte ou qu'un retour est arrivé ne clôt",
  "rien : le client, lui, n'a rien dit. Pour tout autre émetteur que « client »,",
  "réponds false.",
  '',
  "Dans le doute, réponds false : une demande close par erreur laisse un client sans réponse.",
  "`why` : une phrase courte, en français."
].join('\n');

/** How a refusal reads in the log and on the draft row. */
const SENDER_NOUN = {
  qiriness: 'de notre côté',
  internal: 'interne (collègue)',
  logistics: 'du prestataire logistique',
  courier: 'du transporteur',
  contractor: 'd’un prestataire',
  retailer: 'd’un revendeur'
};

export function buildClosurePrompt(message, senderDirectory = null) {
  const own = splitQuotedReply(message?.body_text || '').own?.trim() || '';
  // WHO SENT IT, NOT JUST WHAT IT SAYS. Given the text alone the model read
  // `fcf4ca11` — a colleague telling another colleague an order had shipped — as
  // « le client confirme que la commande a été traitée ». The role is resolved
  // from the address and the address itself never travels.
  return `Émetteur : ${senderRoleName(message, senderDirectory)}\n\nDernier message reçu :\n\n${own || '(vide)'}`;
}

/**
 * One cheap call, and a failure is never a closure.
 *
 * A throw resolves to `closes: false`, which is the behaviour before this
 * existed: the ordinary reply gets written. The failure mode in the other
 * direction — a rate limit quietly shortening a reply to a customer who was
 * still waiting on us — is the one worth engineering against.
 */
export async function readsAsClosure({ openai, model, message, senderDirectory = null, logger = null, ticketId = null }) {
  const own = splitQuotedReply(message?.body_text || '').own?.trim() || '';
  if (!own) {
    // Nothing of their own to read — a bare quoted forward closes nothing.
    return { closes: false, why: 'message vide hors citation' };
  }

  // A NON-CUSTOMER SENDER IS REFUSED IN CODE, not argued with in the prompt.
  // The instruction above is the belt; this is the braces, and it is the half
  // that cannot be talked out of it. 38 inbound messages in this corpus are
  // colleagues and 14 are the 3PL — none of them can close a customer's
  // request, and none is worth a model call to find that out.
  const role = senderRole(message, senderDirectory);
  if (role !== 'customer') {
    return { closes: false, why: `message ${SENDER_NOUN[role] || 'hors client'}` };
  }

  try {
    const answer = await openai.completeJson({
      model,
      system: SYSTEM,
      user: buildClosurePrompt(message, senderDirectory),
      schema: CLOSURE_SCHEMA,
      schemaName: 'closure',
      maxTokens: 120,
      pass: 'closure',
      ticketId
    });
    return {
      closes: answer?.closes === true,
      why: typeof answer?.why === 'string' ? answer.why.trim() : ''
    };
  } catch (error) {
    logger?.warn?.('closure.failed', { ticketId, reason: error.message });
    return { closes: false, why: `non déterminé : ${error.message}` };
  }
}
