import { MISSING_FIELDS } from './case-file.mjs';
import { needLabel } from './evidence-rules.mjs';

// What a follow-up investigation starts from: the case as the Case Manager left
// it after reading THIS message.
//
// THE DELTA, IN THE PROMPT. « Information required for the next decision minus
// valid information already known » — this is the second half, handed to the
// model before it chooses a tool: what earlier runs established and may stand,
// what moves on its own and must be looked at again, what belonged to another
// order, what this message brought, and what we are still waiting for.
//
// NOTHING IS ENFORCED HERE. The model is told what is known and asked not to
// look it up again; every tool stays offered and the opening moves still run.
// Whether the section changes what the run does is measured first — skipping a
// call is a separate decision with its own replay.
//
// ONLY WHEN THE READING IS ABOUT THIS MESSAGE. A case state written for an
// older message describes reuse relative to an older run, and a stale account
// of what is known is worse than none: then there is no section, and the run
// is exactly the one that happened before this existed.
//
// OUTCOME BUCKETS ONLY. `evidence_reuse` carries a need, the tool that settled
// it and the closed-vocabulary finding — never what the tool returned — so the
// section cannot reintroduce the personal data the ledger drops.

/**
 * The delta for this run, or null when there is none to give.
 *
 * `new_issue` gives none either: the previous run's evidence was gathered for
 * the first request, and presenting it as "already known" invites the model to
 * answer the new one from it.
 */
export function caseDeltaFrom({ reading = null, triggerMessageId = null } = {}) {
  if (!reading || !triggerMessageId || reading.trigger_message_id !== triggerMessageId) return null;
  if (reading.case_relationship === 'new_issue') return null;

  const reuse = Object.values(reading.evidence_reuse ?? {}).filter((entry) => entry?.need);
  const byStatus = (status) =>
    reuse
      .filter((entry) => entry.status === status)
      .map((entry) => ({ need: entry.need, finding: entry.finding ?? null, tool: entry.tool ?? null, runAt: entry.run_at ?? null }));

  const delta = {
    relationship: reading.case_relationship ?? 'unclear',
    established: byStatus('valid'),
    toRefresh: byStatus('stale'),
    invalidated: byStatus('invalidated'),
    newFacts: strings(reading.new_facts),
    answered: known(reading.resolved_inputs),
    stillWaiting: known(reading.pending_customer_inputs),
    promised: (Array.isArray(reading.commitments) ? reading.commitments : [])
      .filter((row) => row?.what && row.status !== 'done')
      .map((row) => String(row.what))
  };

  const empty = ['established', 'toRefresh', 'invalidated', 'newFacts', 'answered', 'stillWaiting', 'promised'].every(
    (key) => delta[key].length === 0
  );
  return empty ? null : delta;
}

const RELATIONSHIP = {
  continuation: 'la même demande, qui avance',
  new_information: 'la même demande, avec un élément nouveau',
  unclear: 'lien avec le dossier incertain'
};

/** The section, in the prompt's language. Null renders nothing. */
export function renderCaseDelta(delta) {
  if (!delta) return null;
  const lines = [
    '## Dossier connu (suivi d’un échange en cours)',
    `Ce message : ${RELATIONSHIP[delta.relationship] ?? RELATIONSHIP.unclear}.`
  ];

  if (delta.established.length > 0) {
    lines.push(
      '',
      'Déjà établi lors d’une enquête précédente, toujours valable — ne relance pas un outil pour cela :',
      ...delta.established.map((row) => `- ${needLabel(row.need)} : ${row.finding}${row.tool ? ` (via ${row.tool}${dateOf(row.runAt)})` : ''}`)
    );
  }
  if (delta.toRefresh.length > 0) {
    lines.push(
      '',
      'Établi précédemment mais susceptible d’avoir changé depuis — à revérifier :',
      ...delta.toRefresh.map((row) => `- ${needLabel(row.need)} (était : ${row.finding}${dateOf(row.runAt, ' le ')})`)
    );
  }
  if (delta.invalidated.length > 0) {
    lines.push(
      '',
      'Établi pour une AUTRE commande que celle du dossier aujourd’hui — ne pas réutiliser :',
      ...delta.invalidated.map((row) => `- ${needLabel(row.need)}`)
    );
  }
  if (delta.newFacts.length > 0) {
    lines.push('', 'Ce que ce message apporte :', ...delta.newFacts.map((fact) => `- ${fact}`));
  }
  if (delta.answered.length > 0) {
    lines.push(
      '',
      'Ce que le client vient de nous donner (nous le lui avions demandé) :',
      ...delta.answered.map((field) => `- ${MISSING_FIELDS[field].label}`)
    );
  }
  if (delta.stillWaiting.length > 0) {
    lines.push(
      '',
      'Toujours attendu du client :',
      ...delta.stillWaiting.map((field) => `- ${MISSING_FIELDS[field].label}`)
    );
  }
  if (delta.promised.length > 0) {
    lines.push('', 'Ce que nous avons promis et pas encore fait :', ...delta.promised.map((what) => `- ${what}`));
  }
  lines.push(
    '',
    'Enquête uniquement sur ce qui manque pour répondre à ce message, et sur ce qui est à revérifier.'
  );
  return lines.join('\n');
}

function strings(values) {
  return (Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value.trim()).map((v) => v.trim());
}

function known(fields) {
  return (Array.isArray(fields) ? fields : []).filter((field) => typeof field === 'string' && Object.hasOwn(MISSING_FIELDS, field));
}

function dateOf(value, prefix = ', ') {
  const day = typeof value === 'string' ? value.slice(0, 10) : null;
  return day ? `${prefix}${day}` : '';
}
