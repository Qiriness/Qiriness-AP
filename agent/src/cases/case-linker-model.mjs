// The Case Linker: a cheap model asked ONE question, only when the
// deterministic rules (case-link-rules.mjs) found plausible cases and could not
// choose. Does this new message concern the same underlying problem as one of
// these few cases?
//
// IT ANSWERS `LINK:<case_id>` OR `NEW_CASE`, AND NOTHING ELSE COUNTS. Anything
// it returns that is not exactly one of those, or names a case it was not
// shown, is NEW_CASE: a thread wrongly left on its own costs the investigation
// some context; one wrongly attached to a stranger's problem costs the
// customer a reply about the wrong thing.
//
// WHAT IT IS SHOWN: the new message (cut), its identifiers, and per candidate
// its family, situation, order and parcel numbers, a short summary built
// from subjects and states, and the opening of what its customer first wrote
// (cut). Without that excerpt it saw only subjects, mostly « Nouveau message de
// client le … », and kept identical resends apart (replay 2026-10-02). No
// names or addresses as fields: whose case it is was settled before this was
// asked.
//
// OFF BY DEFAULT (CASE_LINKER_ENABLED). The runner then records the ambiguous
// thread as a new case with its candidates (method `model_off`), which is what
// `cases:replay` reads before anyone switches this on.

export const NEW_CASE = 'NEW_CASE';
const MAX_BODY_CHARS = 1500;

export const CASE_LINKER_SYSTEM = `Tu aides un service client à regrouper des emails par dossier.
Un client a écrit un NOUVEAU message, sur un nouveau fil. On te montre quelques DOSSIERS existants du même client.
Décide si le nouveau message concerne le MÊME problème qu'un de ces dossiers.

Réponds LINK:<id du dossier> quand le message poursuit le même problème : une relance, une mise à jour, une escalade, une répétition, ou son évolution naturelle (un retard de livraison devenu colis perdu puis demande de remboursement, pour la même commande).
Réponds NEW_CASE quand :
- le message concerne une autre commande ;
- il s'agit clairement d'un autre problème ;
- rien ne permet de rattacher le message avec certitude.

Ne rattache JAMAIS seulement parce que c'est le même client, que les mots se ressemblent ou que le sujet est proche. En cas de doute : NEW_CASE.
Ignore les emails cités sous le message et les signatures.`;

export function linkerSchema(caseIds) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['answer'],
    properties: {
      answer: { type: 'string', enum: [...caseIds.map((id) => `LINK:${id}`), NEW_CASE] }
    }
  };
}

const line = (label, value) => (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0) ? null : `${label} : ${Array.isArray(value) ? value.join(', ') : value}`);

export function buildLinkerUser({ subject, body, identifiers = {}, candidates = [] }) {
  const thread = [
    'NOUVEAU MESSAGE',
    `Objet : ${String(subject ?? '').trim() || '(aucun)'}`,
    line('Commande', identifiers.orderNumber),
    line('Suivi colis', identifiers.trackingNumbers),
    line('Famille', identifiers.family),
    String(body ?? '').slice(0, MAX_BODY_CHARS)
  ].filter(Boolean);

  const blocks = candidates.map((candidate) =>
    [
      `[${candidate.caseId}]`,
      line('Famille', candidate.family),
      line('Situation', candidate.situationKey),
      line('Commandes', candidate.orderNumbers),
      line('Suivi colis', candidate.trackingNumbers),
      line('Dernier échange', candidate.lastMessageAt),
      line('Résumé', candidate.summary),
      line('Premier message du client', candidate.opening),
      line('Retenu parce que', candidate.reasons)
    ]
      .filter(Boolean)
      .join('\n')
  );

  return `${thread.join('\n')}\n\nDOSSIERS EXISTANTS\n${blocks.join('\n\n')}`;
}

/**
 * Strict: `LINK:<id>` for an id it was shown, or NEW_CASE. Everything else,
 * a malformed answer included, is NEW_CASE.
 */
export function parseLinkerAnswer(answer, caseIds = []) {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (text === NEW_CASE) return { decision: 'new_case', caseId: null };
  const match = /^LINK:\s*([0-9a-f-]{36})$/i.exec(text);
  if (match && caseIds.includes(match[1])) return { decision: 'link', caseId: match[1] };
  return { decision: 'new_case', caseId: null, malformed: true };
}

/**
 * @param openai the agent's OpenAI client (`completeJson`)
 * @returns linkCase({ ticketId, subject, body, identifiers, candidates })
 *   -> { decision, caseId, answer, model }
 * THROWS ON A FAILED CALL; the runner decides that a failure is a new case.
 */
export function createCaseLinker(openai, { model } = {}) {
  if (!openai || !model) throw new Error('createCaseLinker needs an OpenAI client and a model.');
  return async function linkCase({ ticketId, subject, body, identifiers, candidates }) {
    const caseIds = candidates.map((candidate) => candidate.caseId);
    const response = await openai.completeJson({
      model,
      system: CASE_LINKER_SYSTEM,
      user: buildLinkerUser({ subject, body, identifiers, candidates }),
      schema: linkerSchema(caseIds),
      schemaName: 'case_link',
      maxTokens: 60,
      pass: 'case_link',
      ticketId
    });
    const answer = typeof response?.answer === 'string' ? response.answer : null;
    return { ...parseLinkerAnswer(answer, caseIds), answer, model };
  };
}
