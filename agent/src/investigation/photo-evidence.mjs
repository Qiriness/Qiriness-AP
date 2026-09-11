// The photo-evidence check, as the investigation agent sees it.
//
// THE RULES THEMSELVES MOVED to `scripts/lib/photo-evidence-rules.mjs` when the
// tickets dashboard became a third reader: what counts as furniture rather than
// evidence is now applied by the agent and rendered by the panel, and a rule
// both apply belongs to neither. Everything this module exported still exports
// from here, so no caller had to change.
//
// WHAT STAYS HERE is `toPromptText`: the French line the model is shown. Prompt
// wording is the agent's business and no dashboard reads it.

export {
  classifyAttachments,
  detectPhotoMention,
  listTicketAttachments,
  summarisePhotoEvidence
} from '../../../scripts/lib/photo-evidence-rules.mjs';


/**
 * The French line the model is shown.
 *
 * Says what is known and stops. No instruction to ask for a photo lives here —
 * what to do about a gap is `answer-selection`'s call, and wording it twice is
 * how two parts of a pipeline start disagreeing.
 */
export function toPromptText(evidence) {
  if (!evidence) return 'Preuve photo : non vérifiée.';

  switch (evidence.outcome) {
    case 'attached':
      return (
        `Preuve photo : ${evidence.images} image(s) jointe(s) par le client` +
        (evidence.nonImages > 0 ? `, plus ${evidence.nonImages} autre(s) fichier(s).` : '.')
      );
    case 'mentioned_not_attached':
      return (
        `Preuve photo : le client mentionne une photo (« ${evidence.matchedTerm} ») ` +
        'mais aucune image n’est jointe au message.'
      );
    case 'attachment_type_unknown':
      return (
        'Preuve photo : le message porte une pièce jointe, mais son type n’a pas été ' +
        'enregistré à l’ingestion. Impossible de dire s’il s’agit d’une photo.'
      );
    default:
      return 'Preuve photo : aucune image jointe et aucune mention de photo.';
  }
}
