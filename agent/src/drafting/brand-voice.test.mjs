import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTENT_RULES,
  STRUCTURAL_RULES,
  brandVoiceProblem,
  composeSystemPrompt,
  toBrandVoice
} from './brand-voice.mjs';

const APPROVED = {
  approvalStatus: 'approved',
  roleDescription: '## Rôle\n\nVous êtes l’agent de rédaction du Service Client Qiriness.',
  toneAndVoice: 'Professionnel, chaleureux, concis.',
  responseFramework: ['Salutation appropriée', 'Appliquer la signature approuvée'],
  guidelinesAndGuardrails: ['Ne jamais inventer de faits.'],
  closingLine: 'N’hésitez pas à revenir vers nous si vous avez d’autres questions.',
  signature: 'Bien cordialement,\nService Client Qiriness',
  generalContext: 'À éviter : les excuses excessives.'
};

// --- reading the row ---------------------------------------------------------

test('a row with no voice_profile reads as empty rather than undefined', () => {
  const voice = toBrandVoice({ approval_status: 'draft', voice_profile: null, content_text: null });
  assert.equal(voice.roleDescription, '');
  assert.deepEqual(voice.responseFramework, []);
  assert.equal(voice.generalContext, '');
});

test('whitespace-only fields count as empty', () => {
  // A textarea somebody opened and closed again is not a written brand voice.
  const voice = toBrandVoice({
    approval_status: 'approved',
    voice_profile: { roleDescription: '   \n  ', toneAndVoice: 'x' }
  });
  assert.equal(voice.roleDescription, '');
});

test('non-string entries are dropped from the stored lists', () => {
  const voice = toBrandVoice({
    voice_profile: { responseFramework: ['ok', null, 42, '  ', 'aussi'] }
  });
  assert.deepEqual(voice.responseFramework, ['ok', 'aussi']);
});

// --- the approval gate -------------------------------------------------------

test('a missing article is a named problem, not a crash', () => {
  assert.match(brandVoiceProblem(null), /No Brand voice article/);
});

test('an unapproved voice cannot be drafted from, and the reason says so', () => {
  // Approval gates the prompt exactly as it gates the vector elsewhere: the
  // failure is invisible otherwise — the drafts read fine, they are just not
  // in a voice anybody signed off.
  const problem = brandVoiceProblem({ ...APPROVED, approvalStatus: 'in_review' });
  assert.match(problem, /"in_review", not approved/);
});

test('an approved but half-written voice names which section is empty', () => {
  const problem = brandVoiceProblem({ ...APPROVED, toneAndVoice: '' });
  assert.match(problem, /Agent tone and voice is empty/);
});

test('a complete approved voice has no problem', () => {
  assert.equal(brandVoiceProblem(APPROVED), null);
});

test('composing refuses rather than producing a promptless prompt', () => {
  assert.throws(
    () => composeSystemPrompt({ ...APPROVED, approvalStatus: 'draft' }),
    /Cannot compose a drafting prompt/
  );
});

// --- the composed prompt -----------------------------------------------------

test('every stored section reaches the prompt', () => {
  const prompt = composeSystemPrompt(APPROVED);
  assert.ok(prompt.includes(APPROVED.roleDescription));
  assert.ok(prompt.includes('Professionnel, chaleureux, concis.'));
  assert.ok(prompt.includes('- Salutation appropriée'));
  assert.ok(prompt.includes('- Ne jamais inventer de faits.'));
  assert.ok(prompt.includes('À éviter : les excuses excessives.'));
  assert.ok(prompt.includes('Bien cordialement,\nService Client Qiriness'));
});

test('the role description leads, verbatim', () => {
  // It is written as a prompt, not as a field. Re-wrapping it would fight
  // whoever wrote it.
  assert.ok(composeSystemPrompt(APPROVED).startsWith(APPROVED.roleDescription));
});

test('the structural rules come last and say they outrank the rest', () => {
  const prompt = composeSystemPrompt(APPROVED);
  for (const rule of STRUCTURAL_RULES) {
    assert.ok(prompt.includes(rule), `missing structural rule: ${rule.slice(0, 40)}…`);
  }
  assert.ok(prompt.indexOf('prioritaires sur tout ce qui précède') > prompt.indexOf('Ton et voix'));
});

test('the verdict is protected against the brand voice, not just against the model', () => {
  // A good brand voice tells the model to prefer answering over asking. That is
  // correct advice about writing and wrong if applied to the decision, so the
  // prompt has to say the decision is already made.
  assert.match(composeSystemPrompt(APPROVED), /Ne pas revenir sur cette décision/);
});

test('the stored question wording is protected too', () => {
  assert.match(composeSystemPrompt(APPROVED), /reprendre la question telle qu’elle est écrite/);
});

test('the reply language is named in the prompt, per ticket', () => {
  assert.match(composeSystemPrompt(APPROVED, { language: 'en' }), /en anglais/);
  assert.match(composeSystemPrompt(APPROVED, { language: 'fr' }), /en français/);
});

test('an unknown language falls back to French rather than to nothing', () => {
  assert.match(composeSystemPrompt(APPROVED, { language: 'zz' }), /en français/);
});

test('an empty optional section is omitted, not rendered as an empty heading', () => {
  const prompt = composeSystemPrompt({
    ...APPROVED,
    responseFramework: [],
    guidelinesAndGuardrails: [],
    generalContext: '',
    closingLine: '',
    signature: ''
  });
  assert.ok(!prompt.includes('## Formule de clôture'));
  assert.ok(!prompt.includes('## Structure de la réponse'));
  assert.ok(!prompt.includes('## Règles absolues'));
  assert.ok(!prompt.includes('## Signature'));
  assert.ok(!prompt.includes('## Contexte général'));
});

// --- what each verdict's reply is allowed to do ------------------------------

test('the prompt carries the rules for THIS verdict and no other', () => {
  // The three sets contradict each other by design: the reply that must ask is
  // forbidden from answering. Sending all three would hand the model a prompt
  // that argues with itself and let it pick.
  const ack = composeSystemPrompt(APPROVED, { verdict: 'needs_human' });
  assert.ok(ack.includes(INTENT_RULES.needs_human[0]));
  assert.ok(!ack.includes(INTENT_RULES.needs_customer_input[0]));
  assert.ok(!ack.includes(INTENT_RULES.answerable[0]));

  const ask = composeSystemPrompt(APPROVED, { verdict: 'needs_customer_input' });
  assert.ok(ask.includes(INTENT_RULES.needs_customer_input[0]));
  assert.ok(!ask.includes(INTENT_RULES.needs_human[0]));
});

test('a handover reply answers what it can before handing over', () => {
  // THE CORRECTION OF 2026-08-19. The first version said the reply resolved
  // nothing and capped it at three sentences; it produced 49 drafts saying
  // "en cours de traitement" and nothing else, from case files holding the
  // product, its warranty and exactly what could not be confirmed.
  const prompt = composeSystemPrompt(APPROVED, { verdict: 'needs_human' });
  assert.match(prompt, /répondre sur tout ce qui est déjà établi/);
  assert.match(prompt, /nommer précisément le point/);
  assert.doesNotMatch(prompt, /ne résout rien/);
});

test('a handover reply is told to name what needs checking, not to say it is being processed', () => {
  assert.match(composeSystemPrompt(APPROVED, { verdict: 'needs_human' }), /en cours de/);
  assert.match(composeSystemPrompt(APPROVED, { verdict: 'needs_human' }), /n’apporte rien au client/);
});

test('a handover reply may not invent an outcome, a date or a completed check', () => {
  const prompt = composeSystemPrompt(APPROVED, { verdict: 'needs_human' });
  assert.match(prompt, /Ne rien inventer/);
  assert.match(prompt, /aucun délai ni aucune date/);
  assert.match(prompt, /a déjà été effectuée/);
  assert.match(prompt, /vocabulaire interne/);
});

test('a question reply answers before it asks', () => {
  const prompt = composeSystemPrompt(APPROVED, { verdict: 'needs_customer_input' });
  assert.match(prompt, /tout ce qui peut déjà l’être/);
  assert.match(prompt, /Ne pas transformer toute la réponse en une demande/);
});

test('an answer is told to finish the exchange', () => {
  const prompt = composeSystemPrompt(APPROVED, { verdict: 'answerable' });
  assert.match(prompt, /résoudre entièrement la demande/);
  assert.match(prompt, /aucune raison de répondre/);
});

test('every verdict has a set, so none silently drafts without one', () => {
  for (const verdict of ['answerable', 'needs_customer_input', 'needs_human']) {
    assert.ok(INTENT_RULES[verdict]?.length > 0, `${verdict} has no INTENT_RULES`);
    assert.ok(composeSystemPrompt(APPROVED, { verdict }).includes('Objet de cette réponse'));
  }
});

test('the intent rules sit above the structural rules, which still outrank them', () => {
  const prompt = composeSystemPrompt(APPROVED, { verdict: 'needs_human' });
  assert.ok(prompt.indexOf('Objet de cette réponse') < prompt.indexOf('prioritaires sur tout ce qui précède'));
});

test('the approved closing line is reproduced, and sits above the signature', () => {
  // Left to the model it invented one per email and worded it 31 ways across 81
  // drafts. Approving a wording is what makes it consistent.
  const prompt = composeSystemPrompt(APPROVED, { verdict: 'answerable' });
  assert.ok(prompt.includes(APPROVED.closingLine));
  assert.ok(prompt.indexOf('Formule de clôture') < prompt.indexOf('## Signature'));
});

test('the model is told not to invent a second closing formula', () => {
  assert.match(composeSystemPrompt(APPROVED), /Ne pas inventer de formule de politesse finale/);
  assert.match(composeSystemPrompt(APPROVED), /la seule autorisée/);
});
