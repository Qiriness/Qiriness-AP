// Which recurring situation is this, when the embedding cannot say?
//
// THE MATCHER DECIDES WHEN IT IS SURE; THIS DECIDES WHEN IT IS NOT. A score of
// 0.65 or more stays mechanical. Between 0.55 and 0.65 (`near`), and on a tie
// the margin could not separate (`ambiguous`), a small model reads the opening
// message beside the candidates the matcher already found and picks one — or
// none. Below 0.55 there is nothing plausible to choose between.
//
// WHY A MODEL IS BETTER PLACED THAN THE SCORE HERE. Measured 2026-09-15 on 56
// near misses and ties: the misses were a quoted carrier or Shopify notification
// setting the score instead of the customer's one line, a message in Italian
// against French phrasings, and the right situation sitting second. It committed
// a situation on 35 of the 56, about 80% of them right, where the matcher had
// committed none. See DECISIONS.md § "A near miss is settled by a model".
//
// "NONE" IS A REAL ANSWER AND THE SAFE ONE. A wrong situation sends the
// investigation after the wrong evidence; no situation is simply what happened
// before this existed. The prompt says so, and the schema always offers it.
//
// IT NEVER WIDENS THE SEARCH. It chooses among the matcher's candidates, which
// are already filtered to the ticket's subject — so a right situation filed under
// another subject is still out of reach, and that is a categorisation problem.

/** How many authored phrasings to show per candidate, beside its canonical question. */
const VARIANTS_PER_CANDIDATE = 3;
/** The opening message is cut here: long threads carry quoted history, not the request. */
const MAX_BODY_CHARS = 1800;
/** Phrasings change when the document is re-imported, which is rare; a poll reuses them. */
const VARIANT_CACHE_MS = 10 * 60 * 1000;

export const NONE = 'none';

export const SITUATION_CHOOSER_SYSTEM = `Tu aides un service client de cosmétiques à classer le premier message d'un client.
On te donne le message et quelques SITUATIONS candidates (une question type et des formulations réelles de clients).
Choisis la situation qui décrit ce que le client DEMANDE ou CONSTATE lui-même.

Règles :
- Juge sur la demande du client, pas sur les mots partagés.
- Une situation couvre la demande même quand le client la formule comme une question (« comment bénéficier de… ? ») plutôt que comme un problème (« … ne fonctionne pas »).
- Ignore les emails cités en dessous (notifications transporteur, confirmations Shopify, réponses précédentes) et les signatures : seul ce que le client écrit compte.
- Le message peut être dans n'importe quelle langue.
- Si aucune situation ne correspond clairement, réponds "none". Un mauvais choix coûte plus cher que "none".
- "reason" : une phrase courte, en français, qui ne cite que ce que le message dit.`;

export function chooserSchema(keys) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['choice', 'reason'],
    properties: {
      choice: { type: 'string', enum: [...keys, NONE] },
      reason: { type: 'string' }
    }
  };
}

export function buildChooserUser({ subject, body, candidates, variantsByKey = new Map() }) {
  const blocks = candidates.map((candidate) => {
    const variants = (variantsByKey.get(candidate.exemplarKey) ?? []).slice(0, VARIANTS_PER_CANDIDATE);
    return [
      `[${candidate.exemplarKey}] ${candidate.question ?? ''}`.trim(),
      ...variants.map((text) => `  - « ${text} »`)
    ].join('\n');
  });

  return `MESSAGE DU CLIENT
Objet : ${String(subject ?? '').trim() || '(aucun)'}
${String(body ?? '').slice(0, MAX_BODY_CHARS)}

SITUATIONS CANDIDATES
${blocks.join('\n\n')}`;
}

/**
 * @param openai  the agent's OpenAI client (`completeJson`)
 * @param options.model         the cheap tier; the caller turns the chooser off by not building it
 * @param options.loadVariants  () => Map<exemplarKey, string[]>, authored phrasings; optional
 * @returns chooseSituation({ subject, body, candidates, ticketId })
 *   → { choice: exemplarKey | null, reason, model, candidates: exemplarKey[] }
 *
 * THROWS ON A FAILED CALL. The caller decides what a failure means — for the
 * investigation it means "no situation", exactly as before this existed — and a
 * swallowed error here would be indistinguishable from the model saying none.
 */
export function createSituationChooser(openai, { model, loadVariants = null, logger = null } = {}) {
  if (!openai || !model) {
    throw new Error('createSituationChooser needs an OpenAI client and a model.');
  }

  return async function chooseSituation({ subject, body, candidates, ticketId = null }) {
    const usable = (candidates ?? []).filter((candidate) => candidate?.exemplarKey);
    const keys = [...new Set(usable.map((candidate) => candidate.exemplarKey))];
    if (keys.length === 0) {
      return { choice: null, reason: null, model, candidates: [] };
    }

    // Phrasings make the candidates legible, and the choice is still possible
    // without them — so a failed load narrows the prompt rather than the run.
    let variantsByKey = new Map();
    if (loadVariants) {
      try {
        variantsByKey = (await loadVariants()) ?? new Map();
      } catch (error) {
        logger?.warn?.('situation_chooser.variants_failed', { reason: error.message });
      }
    }

    const answer = await openai.completeJson({
      model,
      system: SITUATION_CHOOSER_SYSTEM,
      user: buildChooserUser({ subject, body, candidates: usable, variantsByKey }),
      schema: chooserSchema(keys),
      schemaName: 'situation_choice',
      maxTokens: 200,
      pass: 'situation',
      ticketId
    });

    // The schema constrains the enum; this is the belt to its braces, because a
    // key outside the candidates would be a situation nobody retrieved.
    const choice = keys.includes(answer?.choice) ? answer.choice : null;
    const reason = typeof answer?.reason === 'string' ? answer.reason.trim() || null : null;

    return { choice, reason, model, candidates: keys };
  };
}

/**
 * The authored phrasings of every live situation, keyed by exemplar key, cached.
 *
 * AUTHORED ONLY (`phrasing_index < 100`): the translations say the same thing in
 * four more languages, and showing them would multiply the prompt to tell the
 * model nothing new. The canonical question travels separately.
 *
 * `select` is injected so the cache can be tested without a database.
 */
export function createVariantLoader({ selectExemplars, selectPhrasings, now = () => Date.now() }) {
  let cached = null;
  let loadedAt = 0;

  return async function loadVariants() {
    if (cached && now() - loadedAt < VARIANT_CACHE_MS) {
      return cached;
    }

    const [exemplars, phrasings] = await Promise.all([selectExemplars(), selectPhrasings()]);
    const keyById = new Map((exemplars ?? []).map((row) => [row.id, row.exemplar_key]));
    const canonicalById = new Map((exemplars ?? []).map((row) => [row.id, row.canonical_question]));

    const byKey = new Map();
    const ordered = [...(phrasings ?? [])].sort((a, b) => a.phrasing_index - b.phrasing_index);
    for (const row of ordered) {
      const key = keyById.get(row.support_exemplar_id);
      if (!key || row.phrasing_kind === 'canonical') continue;
      if (row.phrasing_text === canonicalById.get(row.support_exemplar_id)) continue;
      const list = byKey.get(key) ?? [];
      if (list.length < VARIANTS_PER_CANDIDATE) list.push(row.phrasing_text);
      byKey.set(key, list);
    }

    cached = byKey;
    loadedAt = now();
    return cached;
  };
}
