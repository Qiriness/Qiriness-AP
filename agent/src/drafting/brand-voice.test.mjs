import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
    signature: ''
  });
  assert.ok(!prompt.includes('## Structure de la réponse'));
  assert.ok(!prompt.includes('## Règles absolues'));
  assert.ok(!prompt.includes('## Signature'));
  assert.ok(!prompt.includes('## Contexte général'));
});
