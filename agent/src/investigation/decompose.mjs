import { REQUEST_KINDS, TICKET_SUBJECTS } from '../../../scripts/lib/support-taxonomy.mjs';

import { MAX_TASKS, normaliseDecomposition, shouldDecompose } from './decompose-rules.mjs';

// Splits one email into the separate requests it contains, and pulls out the
// entities that let the router act on them. The model half; the judgement is in
// decompose-rules.mjs.
//
// WHERE THIS RUNS, AND WHY NOT IN THE CATEGORISER. The obvious home is the
// categorisation call — it already reads the email and emits structured output,
// so sub-questions would be nearly free in the same forward pass. It belongs
// here instead because the categoriser runs on EVERY ticket while investigation
// runs only on the in-scope ones: decomposing at categorisation means paying for
// forwarded mail, level 4 and `contact` kind, none of which is ever
// investigated. `shouldDecompose()` narrows it further, so an ordinary
// one-question ticket costs nothing at all.
//
// NO PERSONAL DATA. Subject and body only — the same text the categoriser
// already reads. The sender's name and address are never part of the prompt.

const DECOMPOSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'entities'],
  properties: {
    tasks: {
      type: 'array',
      maxItems: MAX_TASKS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'category', 'request_kind'],
        properties: {
          question: { type: 'string' },
          // Constrained by the schema AND clamped again in normalisation:
          // Structured Outputs is a strong guarantee, not a total one, and the
          // tool table has no row for a value outside this list.
          category: { type: 'string', enum: [...TICKET_SUBJECTS] },
          request_kind: { type: 'string', enum: [...REQUEST_KINDS] }
        }
      }
    },
    entities: {
      type: 'object',
      additionalProperties: false,
      required: ['order_numbers', 'products', 'codes'],
      properties: {
        order_numbers: { type: 'array', items: { type: 'string' } },
        products: { type: 'array', items: { type: 'string' } },
        codes: { type: 'array', items: { type: 'string' } }
      }
    }
  }
};

const SYSTEM_PROMPT = [
  "Tu découpes un e-mail de service client en les demandes distinctes qu'il contient.",
  '',
  "UNE SEULE DEMANDE EST LE CAS NORMAL. La plupart des e-mails ne contiennent qu'une demande, même longs, même polis, même s'ils posent la même question de deux façons. Dans ce cas, renvoie UNE seule tâche.",
  '',
  'Ne crée une deuxième tâche que si les deux demandes pourraient être traitées séparément par deux personnes différentes.',
  "Exemple de DEUX tâches : « le masque LED convient-il aux peaux sensibles ? » et « ma commande #4854 n'est pas arrivée » — l'une se répond avec la fiche produit, l'autre avec le suivi de commande.",
  "Exemple d'UNE seule tâche : « ma commande est arrivée abîmée, je voudrais un remboursement » — c'est une seule situation, vue de deux angles.",
  '',
  `Maximum ${MAX_TASKS} tâches.`,
  '',
  'Pour chaque tâche :',
  '- question : la demande reformulée en une phrase claire, dans la langue du client.',
  "- category : le sujet, parmi la liste imposée.",
  '- request_kind : question | problem | complaint | contact.',
  '',
  'entities : ce que le client a ÉCRIT, jamais ce que tu déduis.',
  "- order_numbers : uniquement des numéros de commande explicites (#4854, « commande n° 3985 »). Une date, un montant, un code postal ou une référence interne commençant par Q00 ne sont PAS des numéros de commande. Dans le doute, laisse vide.",
  '- products : les noms de produits cités, tels quels.',
  '- codes : les codes promotionnels cités, tels quels.',
  '',
  "N'invente rien et ne réponds pas au client : tu ne fais que découper."
].join('\n');

export function createDecomposer(openai, { model, maxBodyChars = 3000 } = {}) {
  /**
   * @param ticket { text, category, request_kind, secondary_category }
   * @returns { tasks[], entities, decomposed }
   */
  async function decompose(ticket = {}) {
    // Not worth a model call: a short single question is one task by
    // construction. Returns the same shape so callers never branch.
    if (!shouldDecompose(ticket)) {
      return { ...normaliseDecomposition(null, ticket), decomposed: false };
    }

    try {
      const raw = await openai.completeJson({
        model,
        system: SYSTEM_PROMPT,
        user: String(ticket.text ?? '').slice(0, maxBodyChars),
        schema: DECOMPOSITION_SCHEMA,
        schemaName: 'ticket_decomposition',
        maxTokens: 400
      });
      return { ...normaliseDecomposition(raw, ticket), decomposed: true };
    } catch {
      // A failed decomposition must never fail the investigation. Falling back
      // to one task is exactly the behaviour before this existed, so the worst
      // case is the old cost, not a lost ticket.
      return { ...normaliseDecomposition(null, ticket), decomposed: false };
    }
  }

  return { decompose };
}

export { DECOMPOSITION_SCHEMA, SYSTEM_PROMPT };
