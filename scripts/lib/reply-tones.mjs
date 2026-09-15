// The tones a rule may ask its reply to take.
//
// THE CATALOGUE IS CODE, as `parameters.mjs` is: these are the tones the drafting
// prompt knows how to word, and a tone the dashboard offered that the prompt could
// not render would be a choice that saves and changes nothing. The check
// constraint on `support_answers.tones` holds the same keys, and
// `05_exemplars.test.mjs` asserts the two agree.
//
// A TONE ADJUSTS THE BRAND VOICE, IT DOES NOT REPLACE IT. The Brand voice article
// says how Qiriness always sounds; a tone says how this case should land. None of
// them may change a fact, the verdict, or a structural rule — which is why the
// apology is worded as regret for the inconvenience and never as fault, the line
// the chase rule in `brand-voice.mjs` already draws.
//
// ORDER IS THE CATALOGUE'S, whatever order they were picked in, so the union of
// two requests' tones reads the same whichever request came first.

export const REPLY_TONES = Object.freeze({
  reassuring: {
    label: 'Reassuring',
    hint: 'Settle a worried customer, on the facts only.',
    name: 'Rassurant',
    instruction:
      'rassurer le client sur la prise en charge de sa demande, en s’appuyant uniquement sur les faits ' +
      'établis. Ne rien promettre que le dossier ne permet pas d’affirmer.'
  },
  empathetic: {
    label: 'Empathetic',
    hint: 'Acknowledge how the customer feels before the answer.',
    name: 'Empathique',
    instruction:
      'reconnaître brièvement ce que vit le client — gêne, inquiétude ou déception — avant d’entrer dans ' +
      'le fond, sans excès ni formule toute faite.'
  },
  factual: {
    label: 'Factual & brief',
    hint: 'Straight to the point, in short sentences.',
    name: 'Factuel et bref',
    instruction:
      'aller droit au fait : phrases courtes, aucune formule d’amabilité superflue, uniquement ce qui ' +
      'répond à la demande.'
  },
  firm: {
    label: 'Firm',
    hint: 'State the rule or decision clearly, without hedging.',
    name: 'Ferme',
    instruction:
      'énoncer clairement la règle ou la décision, sans hésiter ni laisser entendre qu’une exception est ' +
      'possible, tout en restant courtois.'
  },
  apologetic: {
    label: 'Apologetic',
    hint: 'Regret for the inconvenience — never an admission of fault.',
    name: 'Désolé',
    instruction:
      'exprimer une fois, sobrement, nos regrets pour le désagrément vécu par le client. S’excuser de la ' +
      'gêne n’est pas reconnaître une faute : ne rien admettre ni promettre que le dossier n’établit pas.'
  },
  understanding: {
    label: 'Understanding',
    hint: 'Show the request and its reasons are understood, without judgement.',
    name: 'Compréhensif',
    instruction:
      'montrer que la demande et ses raisons sont comprises, sans jugement ni reproche, en reformulant ' +
      'brièvement le besoin du client lorsque c’est utile.'
  }
});

export const TONE_KEYS = Object.freeze(Object.keys(REPLY_TONES));

/**
 * Tone keys as the catalogue knows them: unknown ones dropped, each once, in
 * catalogue order. A bare string is accepted as a one-element list.
 *
 * DROPPED, NOT PRESERVED, on the read side — a tone removed from the catalogue
 * cannot be worded, and keeping its key would put nothing in the prompt anyway.
 * The save path refuses unknown keys outright instead, so dropping here only
 * ever meets a row older than the catalogue.
 */
export function normaliseTones(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const picked = new Set(list.map((value) => String(value ?? '').trim()));
  return TONE_KEYS.filter((key) => picked.has(key));
}

/**
 * The prompt lines for a set of tones, or null when there are none.
 *
 * Several tones are told to combine rather than being ranked: somebody picked
 * each one deliberately, and « compréhensif » plus « désolé » is one reply, not a
 * choice between two.
 */
export function toneInstructions(tones) {
  const keys = normaliseTones(tones);
  if (keys.length === 0) {
    return null;
  }
  const lines = keys.map((key) => `- ${REPLY_TONES[key].name} : ${REPLY_TONES[key].instruction}`);
  const combine =
    keys.length > 1
      ? '\n\nCes tons se cumulent : les concilier dans une même réponse cohérente, sans en forcer les marques.'
      : '';
  return lines.join('\n') + combine;
}
