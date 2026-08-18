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
 *     decided whether this ticket can be answered or has to ask; a drafting
 *     model that talks itself out of asking produces a confident reply resting
 *     on nothing. This matters more here than it looks, because a good brand
 *     voice tells the model to prefer answering over asking — correct advice
 *     about how to write, wrong if applied to the decision itself.
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
  'Le dossier a déjà décidé s’il faut répondre ou demander une information. ' +
    'Ne pas revenir sur cette décision : ne pas répondre à la place d’une question à poser, ' +
    'et ne pas poser de question lorsque le dossier permet de répondre.',
  'Lorsque le dossier indique une information à demander, reprendre la question telle qu’elle est écrite. ' +
    'Ne pas la reformuler et ne pas en ajouter d’autres.',
  'N’affirmer que ce qui figure sous « Établi ». Ce qui figure sous « Non vérifié » ' +
    'peut être mentionné comme une chose que le client rapporte, jamais comme un fait.',
  'Ne jamais citer de référence interne : identifiant technique, référence produit, ' +
    'adresse e-mail d’un client, numéro de suivi non fourni par le dossier.',
  'Écrire uniquement le corps de l’e-mail. Aucun objet, aucun commentaire, aucune note sur la démarche.'
];

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
export function composeSystemPrompt(voice, { language = 'fr' } = {}) {
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
