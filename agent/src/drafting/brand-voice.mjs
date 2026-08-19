import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

// The drafting agent's system prompt, assembled from the Brand voice article.
//
// WHY THE PROMPT IS A DATABASE ROW. Every other prompt in this worker is a
// string literal beside the code that sends it, and that is right for the
// categoriser and the investigation: those describe a taxonomy and a procedure,
// which are engineering decisions. How Qiriness sounds is not. It is edited by
// the people who answer the mail, in `/agent-setup`, and a prompt they cannot
// change without a deploy is one they will stop maintaining.
//
// WHAT IS EDITABLE AND WHAT IS NOT. Five fields come from the row — role, tone,
// framework, guardrails, signature — plus the article body as general context.
// The rules in STRUCTURAL_RULES below do not, because they are not style: they
// are the seams between this stage and the ones around it, and a reply that
// breaks one is wrong however well it reads.
//
// APPROVAL GATES THE PROMPT, exactly as it gates the vector for knowledge and
// exemplars. A half-written brand voice produces replies in a voice nobody
// signed off, and the failure is invisible — the drafts read fine, they just
// are not Qiriness.

/**
 * The rules code owns, appended after everything the row supplies.
 *
 * Each one exists because breaking it costs something specific:
 *
 *   - The VERDICT is not the model's to revisit. The investigation already
 *     decided whether this ticket can be answered, has to ask, or can only be
 *     acknowledged; a drafting model that talks itself out of asking produces a
 *     confident reply resting on nothing, and one that talks itself into
 *     answering an acknowledgement produces the same thing with a customer's
 *     name on it. This matters more than it looks, because a good brand voice
 *     tells the model to prefer answering over asking — correct advice about how
 *     to write, wrong if applied to the decision itself. What each verdict's
 *     reply may do is in `INTENT_RULES`.
 *   - The QUESTIONS are looked up, not composed. `MISSING_FIELDS` holds one
 *     sentence per fact a customer can be asked for, so the same question is
 *     worded the same way on every ticket.
 *   - LANGUAGE follows the customer, not the corpus. The library is French and
 *     so is most of the mail, which is exactly why an English email gets
 *     answered in French unless something says otherwise.
 *   - The BODY ONLY. Anything the model adds around the reply — a preamble, a
 *     note about what it did — is text a customer would read.
 */
export const STRUCTURAL_RULES = [
  'Le dossier a déjà décidé ce que cette réponse doit faire : répondre, demander une ' +
    'information, ou seulement accuser réception. Ne pas revenir sur cette décision — ' +
    'voir « Objet de cette réponse ».',
  'Lorsque le dossier indique une information à demander, reprendre la question telle qu’elle est écrite. ' +
    'Ne pas la reformuler et ne pas en ajouter d’autres.',
  'N’affirmer que ce qui figure sous « Établi ». Ce qui figure sous « Non vérifié » ' +
    'peut être mentionné comme une chose que le client rapporte, jamais comme un fait.',
  'Ne jamais citer de référence interne : identifiant technique, référence produit, ' +
    'adresse e-mail d’un client, numéro de suivi non fourni par le dossier.',
  'Ne pas inventer de formule de politesse finale (« merci de votre patience », « nous restons à ' +
    'votre disposition », « votre satisfaction est notre priorité »). La formule de clôture ' +
    'approuvée, lorsqu’elle est fournie, est la seule autorisée.',
  'Écrire uniquement le corps de l’e-mail. Aucun objet, aucun commentaire, aucune note sur la démarche.'
];

/**
 * The rules that depend on WHAT THIS REPLY IS FOR, keyed by verdict.
 *
 * Separate from STRUCTURAL_RULES because those hold for every draft, and these
 * differ by design: only one set travels, chosen by the verdict, so the model is
 * never handed a prompt that argues with itself.
 *
 * ALL THREE ANSWER WHAT THEY CAN. That is the correction of 2026-08-19 and it is
 * the whole shape of this table. The first version told `needs_human` to resolve
 * nothing and to stay to three or four sentences, and it obeyed: 49 drafts that
 * said « votre demande est en cours de traitement » and nothing else, while the
 * case file in front of them held the product, its two-year warranty and exactly
 * what could not be confirmed. **The material for a specific reply was already
 * in the prompt; the instructions forbade using it.** A reply that tells the
 * customer nothing they did not already know is not a safe reply, it is a
 * useless one — and it costs the same to send.
 *
 * WHAT CHANGED IS THE ORDER, NOT THE PERMISSIONS. Nothing here loosens what may
 * be claimed: `established` is still the only source of facts, `unverified` is
 * still only ever attributed to the customer, and the prohibitions still hold.
 * What changed is that answering comes FIRST in all three, and the unresolved
 * part — a question, or a point going to a colleague — comes after it rather
 * than instead of it.
 *
 * THE HANDOFF IS STILL WITHHELD, and this table is why it does not need to be.
 * "What requires attention" is derivable from `unverified` (what could not be
 * confirmed, and why), which is factual and proposes no remedy. The handoff's
 * `action` proposes one: measured 2026-08-19, **10 of 49 name a refund or a
 * replacement**, and a commercial gesture is a merchant decision the model may
 * never invent. So the model is told to describe what needs checking, from
 * evidence it already has, and is never shown what we might do about it.
 */
export const INTENT_RULES = {
  answerable: [
    'Objectif : résoudre entièrement la demande dans cette réponse.',
    'Répondre directement à la question posée, à partir des faits établis, de façon précise et concrète.',
    'Ne pas introduire de doute lorsque les éléments du dossier permettent de répondre.',
    'Ne pas demander d’information supplémentaire : le dossier permet de répondre.',
    'Ne pas ajouter de question de relance destinée seulement à poursuivre l’échange.',
    'Le client ne devrait avoir aucune raison de répondre, sauf s’il a besoin d’une aide supplémentaire.'
  ],
  needs_customer_input: [
    'Objectif : faire avancer le dossier vers sa résolution, tout en rendant la réponse utile en elle-même.',
    'Dans cet ordre : (1) répondre et expliquer tout ce qui peut déjà l’être à partir des faits établis ; ' +
      '(2) expliquer, lorsque c’est utile au client, pourquoi l’information manquante est nécessaire ; ' +
      '(3) demander uniquement cette information ; (4) indiquer clairement la suite.',
    // MEASURED 2026-08-19: with the reordering alone, only 4 of 24 established
    // facts reached the reply. Answering « what can be answered » is not a strong
    // enough instruction — the model reads it as « acknowledge the topic ». This
    // names the obligation.
    'Reprendre les faits établis qui ont une valeur pour le client : garantie applicable, '+
      'politique en vigueur, état connu de la commande, délai déjà constaté. Un fait établi utile '+
      'qui n’est pas transmis est une information que le client devra redemander.',
    'Ne pas transformer toute la réponse en une demande d’information : le client doit comprendre la ' +
      'situation avant qu’une question lui soit posée.',
    'Ne demander que ce qui bloque réellement la résolution, et regrouper les questions plutôt que de ' +
      'multiplier les échanges.',
    'Ne jamais redemander une information déjà présente dans le message du client ou dans le dossier.',
    'Poser les questions du dossier telles qu’elles sont écrites, sans en ajouter d’autres.'
  ],
  needs_human: [
    'Objectif : répondre sur tout ce qui est déjà établi, puis confier le point non résolu à l’équipe concernée.',
    'Dans cet ordre : (1) répondre à ce qui peut déjà l’être ; (2) nommer précisément le point qui demande ' +
      'une vérification ou une décision de notre part ; (3) indiquer que l’équipe concernée prend ce point en charge.',
    // The failure this replaced. « En cours de traitement » is what a model
    // writes when it has been told to say nothing, and it reads as a brush-off.
    // MEASURED 2026-08-19: with the reordering alone, only 4 of 24 established
    // facts reached the reply. Answering « what can be answered » is not a strong
    // enough instruction — the model reads it as « acknowledge the topic ». This
    // names the obligation.
    'Reprendre les faits établis qui ont une valeur pour le client : garantie applicable, '+
      'politique en vigueur, état connu de la commande, délai déjà constaté. Un fait établi utile '+
      'qui n’est pas transmis est une information que le client devra redemander.',
    'Expliquer ce qui doit être vérifié, plutôt que d’écrire vaguement que la demande « est en cours de ' +
      'traitement ». Une réponse qui ne dit rien de précis n’apporte rien au client.',
    'Ne jamais laisser entendre qu’une vérification, une décision ou une action a déjà été effectuée.',
    'Ne rien inventer : aucune décision, aucun accord, aucun remboursement, aucun remplacement, ' +
      'aucun résultat de vérification, aucun délai ni aucune date.',
    'N’employer aucun vocabulaire interne : ni « escalade », ni « traitement manuel », ni « niveau 3 », ni « agent ».',
    'Ne demander une information au client que si le dossier en nomme une explicitement.'
  ]
};

/** What a usable brand voice must carry before anything can be drafted from it. */
const REQUIRED_TEXT_FIELDS = [
  ['roleDescription', 'Agent role description'],
  ['toneAndVoice', 'Agent tone and voice']
];

/**
 * Reads the singleton Brand voice article.
 *
 * `core_topic = 'brand'` is unique per shop (03_knowledge.sql), so this is a
 * lookup and not a search. The article body is the "General context" section —
 * it is deliberately NOT chunked or embedded (see knowledge-service), because
 * it applies to every reply rather than being retrieved for some of them.
 */
export function createBrandVoiceStore(supabase) {
  return {
    async load(shopId) {
      const rows = await supabaseSelect(
        supabase,
        T.KNOWLEDGE_DOCUMENTS,
        { shop_id: shopId, core_topic: 'brand', deleted_at: { operator: 'is', value: 'null' } },
        'id,title,approval_status,voice_profile,content_text',
        { limit: 1 }
      );
      return rows[0] ? toBrandVoice(rows[0]) : null;
    }
  };
}

/** The stored row, in the shape the composer reads. */
export function toBrandVoice(row) {
  const profile = row?.voice_profile || {};
  return {
    approvalStatus: row?.approval_status || 'draft',
    roleDescription: text(profile.roleDescription),
    toneAndVoice: text(profile.toneAndVoice),
    responseFramework: list(profile.responseFramework),
    guidelinesAndGuardrails: list(profile.guidelinesAndGuardrails),
    closingLine: text(profile.closingLine),
    signature: text(profile.signature),
    generalContext: text(row?.content_text)
  };
}

/**
 * Why this brand voice cannot be drafted from, or null when it can.
 *
 * A REASON RATHER THAN A BOOLEAN. The three ways this fails are "nobody has
 * written it", "it is written but not approved" and "approved but a required
 * section is empty", and an operator seeing `false` learns none of them. The
 * runner puts this string in front of them instead of drafting.
 */
export function brandVoiceProblem(voice) {
  if (!voice) {
    return 'No Brand voice article exists for this shop. Write one in /agent-setup.';
  }
  if (voice.approvalStatus !== 'approved') {
    return (
      `The Brand voice article is "${voice.approvalStatus}", not approved. ` +
      'Approving it is the sign-off that this is how Qiriness sounds; drafting will not ' +
      'run against an unapproved voice.'
    );
  }
  const empty = REQUIRED_TEXT_FIELDS.filter(([key]) => !voice[key]).map(([, label]) => label);
  if (empty.length > 0) {
    return `The Brand voice article is approved but ${empty.join(' and ')} ${
      empty.length === 1 ? 'is' : 'are'
    } empty.`;
  }
  return null;
}

/**
 * The system prompt: the brand voice, then the rules code owns.
 *
 * THE ORDER IS THE PRECEDENCE, said plainly at the end rather than implied by
 * position. The editable half describes how to write; the structural half
 * describes what this stage is allowed to decide, and a tone instruction can
 * never license breaking one.
 *
 * `roleDescription` leads and is copied verbatim, headings and all — it is
 * written as a prompt, not as a field, and re-wrapping it in our own structure
 * would fight whoever wrote it.
 */
export function composeSystemPrompt(voice, { language = 'fr', verdict = 'answerable' } = {}) {
  const problem = brandVoiceProblem(voice);
  if (problem) {
    throw new Error(`Cannot compose a drafting prompt: ${problem}`);
  }

  const parts = [voice.roleDescription, section('Ton et voix', voice.toneAndVoice)];

  if (voice.responseFramework.length > 0) {
    parts.push(section('Structure de la réponse', bullets(voice.responseFramework)));
  }
  if (voice.guidelinesAndGuardrails.length > 0) {
    parts.push(section('Règles absolues', bullets(voice.guidelinesAndGuardrails)));
  }
  if (voice.generalContext) {
    parts.push(section('Contexte général', voice.generalContext));
  }
  // BEFORE THE SIGNATURE, because that is where it goes in the email and the
  // prompt reads in the order the reply is written.
  //
  // APPROVED RATHER THAN FORBIDDEN. Left to the model, 31 of 81 drafts invented
  // a closing courtesy and worded it 31 different ways. The line is worth saying
  // — it tells the customer the door is open — so the fix is one approved
  // wording reproduced exactly, checked the same way the signature is. An empty
  // field means no closing line, and the structural rule against inventing one
  // still applies.
  if (voice.closingLine) {
    parts.push(
      section(
        'Formule de clôture',
        'Avant la signature, terminer par cette phrase, reproduite exactement, sans rien y ' +
          `changer et sans en ajouter d’autre :

${voice.closingLine}`
      )
    );
  }

  if (voice.signature) {
    // Reproduced exactly, and said twice: this is the one piece of the prompt
    // whose output is compared character by character (see draft-checks), so a
    // model that "improves" it fails a check rather than shipping a signature
    // nobody approved.
    parts.push(
      section(
        'Signature',
        `Terminer par cette signature, reproduite exactement, sans rien y changer :\n\n${voice.signature}`
      )
    );
  }

  // Before the language and the structural rules, because it is the instruction
  // most specific to this ticket and the two below it are the same on every one.
  const intentRules = INTENT_RULES[verdict];
  if (intentRules) {
    parts.push(section('Objet de cette réponse', bullets(intentRules)));
  }

  parts.push(
    section(
      'Langue',
      `Rédiger la réponse en ${LANGUAGE_NAMES[language] || LANGUAGE_NAMES.fr}, ` +
        'la langue du message du client.'
    )
  );

  parts.push(
    section(
      'Contraintes de fonctionnement (prioritaires sur tout ce qui précède)',
      bullets(STRUCTURAL_RULES)
    )
  );

  return parts.join('\n\n');
}

/** For the prompt's own sentence about which language to answer in. */
const LANGUAGE_NAMES = {
  fr: 'français',
  en: 'anglais',
  es: 'espagnol',
  de: 'allemand',
  it: 'italien',
  nl: 'néerlandais',
  pt: 'portugais',
  other: 'la langue du message du client'
};

function section(heading, body) {
  return `## ${heading}\n\n${body}`;
}

function bullets(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
}
