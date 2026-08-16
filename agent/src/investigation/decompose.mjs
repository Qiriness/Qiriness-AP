import { REQUEST_KINDS, TICKET_SUBJECTS } from '../../../scripts/lib/support-taxonomy.mjs';

import { MAX_TASKS, normaliseDecomposition } from './decompose-rules.mjs';
import { NEED_KEYS, needLabel, normaliseNeeds } from './evidence-rules.mjs';

// Reads one email and answers two questions before any tool runs: WHAT IS BEING
// ASKED (the tasks) and WHAT ANSWERING IT WILL REQUIRE (the needs). The model
// half; the judgement is in decompose-rules.mjs and evidence-rules.mjs.
//
// ONE CALL FOR BOTH, because they are the same act of reading. Splitting them
// would pay twice to have a model read the same three paragraphs, and the second
// reader would have to be told what the first concluded anyway.
//
// WHERE THIS RUNS, AND WHY NOT IN THE CATEGORISER. The obvious home is the
// categorisation call — it already reads the email and emits structured output,
// so this would be nearly free in the same forward pass. It belongs here instead
// because the categoriser runs on EVERY ticket while investigation runs only on
// the in-scope ones: doing it at categorisation means paying for forwarded mail,
// level 4 and `contact` kind, none of which is ever investigated.
//
// NO PERSONAL DATA. Subject and body only — the same text the categoriser
// already reads. The sender's name and address are never part of the prompt.

const DECOMPOSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'entities', 'needs'],
  properties: {
    // The facts a correct reply would have to rest on. A closed enum, because
    // code — not a second model call — decides whether the ledger satisfied each.
    needs: {
      type: 'array',
      items: { type: 'string', enum: [...NEED_KEYS] }
    },
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
  'needs : ce qu’une bonne réponse devra pouvoir AFFIRMER pour traiter ce message.',
  "Choisis uniquement dans cette liste, et uniquement ce qui est vraiment nécessaire — pas tout ce qui pourrait servir :",
  NEED_KEYS.map((key) => `- ${key} : ${needLabel(key)}`).join('\n'),
  '',
  "Si ce message exige un élément que cette liste ne sait pas nommer, ajoute other_fact. Ne force jamais un besoin approchant à la place : other_fact est là pour ça.",
  '',
  "N'invente rien et ne réponds pas au client : tu ne fais que analyser la demande."
].join('\n');

export function createDecomposer(openai, { model, maxBodyChars = 3000 } = {}) {
  /**
   * @param ticket { text, category, request_kind, secondary_category }
   * @returns { tasks[], entities, needs[], read }
   */
  async function decompose(ticket = {}) {
    try {
      const raw = await openai.completeJson({
        model,
        system: SYSTEM_PROMPT,
        user: String(ticket.text ?? '').slice(0, maxBodyChars),
        schema: DECOMPOSITION_SCHEMA,
        schemaName: 'ticket_decomposition',
        maxTokens: 500,
        pass: 'decompose',
        ticketId: ticket.id ?? null
      });
      return { ...normaliseDecomposition(raw, ticket), needs: normaliseNeeds(raw?.needs), read: true };
    } catch {
      // A failed read must never fail the investigation. One task with the
      // ticket's own labels is exactly the behaviour before this existed, so the
      // worst case is the old cost, not a lost ticket.
      //
      // NO NEEDS ARE INVENTED ON FAILURE. An empty list reports as "nobody said
      // what this required", which is true; guessing from the category would put
      // fabricated requirements into the very numbers this exists to measure.
      return { ...normaliseDecomposition(null, ticket), needs: [], read: false };
    }
  }

  return { decompose };
}

export { DECOMPOSITION_SCHEMA, SYSTEM_PROMPT };
