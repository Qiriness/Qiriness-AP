// Does this ticket already carry the photo a damage claim will need?
//
// TWO SIGNALS, KEPT SEPARATE ALL THE WAY OUT, because on real mail they
// disagree far more often than they agree. Measured over the 296 inbound
// messages in the corpus:
//
//   22  say "photo" AND carry an attachment
//   28  say "photo" and carry NO attachment      <- the customer meant to attach
//   16  carry an attachment and never mention it <- usually a signature logo
//
// Collapsing those into one boolean throws away the only case a drafting step
// can act on. "You mentioned a photo but nothing came through" is a different
// reply from "please send a photo", and both are different from saying nothing.
//
// WHAT THIS MODULE IS NOT. It does not open an attachment and it never sees
// pixels. It reads Graph's own metadata — name, contentType, size, isInline —
// and the customer's words. Whether the image actually shows a broken bottle is
// a question for a person, and this module is careful to claim only that
// something image-shaped arrived.
//
// Pure: text and metadata in, a verdict out. No database, no Graph, no clock.

/**
 * The words a French customer uses when they attach, or mean to attach, a photo.
 *
 * Ordered most-specific first so `matchedTerm` reports the strongest evidence
 * rather than whichever alternative happened to be leftmost in the source.
 *
 * `image` is deliberately last and deliberately included despite `image de
 * marque` (brand image) being a real b2b phrase that fires it. The tool reports
 * which term matched, so a false positive is auditable rather than silent — and
 * a missed photo on a damage claim costs a whole round trip with the customer,
 * while a false one costs a sentence the drafter can drop.
 */
const PHOTO_TERMS = [
  /captures?\s+d[’']?\s?[ée]cran/i,
  /pi[èe]ces?\s+jointes?/i,
  /ci-?\s?jointe?s?/i,
  /screenshots?/i,
  /\bphotographies?\b/i,
  /\bphotos?\b/i,
  // `\b` is ASCII-only in JavaScript, so it does not exist after `é` — `cliché`
  // would never match a pattern ending in `\b`. A negative lookahead for another
  // letter does the same job and survives the accents this mailbox is full of.
  /\bclich[ée]s?(?![a-zà-ÿ])/i,
  /\b(?:jpe?g|png|heic|webp)\b/i,
  /\bimages?\b/i
];

/**
 * Attachment names that are never evidence.
 *
 * A mailbox this size collects the same half-dozen corporate furniture files on
 * every message — the logo in a signature, the Outlook-generated placeholder for
 * an inline image. Matching on the NAME rather than only on `isInline` matters
 * because a customer who pastes a photo into the body also produces an inline
 * part, and excluding all inline parts would drop exactly the evidence we want.
 */
const FURNITURE_NAME = /^(image\d{3,}|logo|signature|oledata|outlook-[a-z0-9]+)\b|\.(?:emz|wmf|vml)$/i;

/**
 * Inline images at or under this many bytes are treated as furniture.
 *
 * A signature logo is a few kilobytes; a phone photo of a damaged parcel is
 * megabytes. 50 KB sits well clear of both, and the raw counts travel in the
 * result so a caller that disagrees can apply its own rule instead of being
 * stuck with this one.
 */
const INLINE_EVIDENCE_MIN_BYTES = 50 * 1024;

const IMAGE_TYPE = /^image\//i;

/** Did the customer say a photo was coming? Returns the term that matched. */
export function detectPhotoMention(text) {
  const body = String(text || '');
  for (const term of PHOTO_TERMS) {
    const hit = body.match(term);
    if (hit) {
      return { mentioned: true, term: hit[0].toLowerCase().replace(/\s+/g, ' ') };
    }
  }
  return { mentioned: false, term: null };
}

/**
 * Sorts Graph attachment metadata into what could be evidence and what cannot.
 *
 * `nonImages` is reported rather than discarded: on this mailbox the largest
 * attachment groups are b2b catalogues and careers CVs, and a tool that silently
 * dropped them would leave a caller unable to tell "no photo" from "no
 * attachment at all".
 */
export function classifyAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const summary = { total: list.length, images: 0, nonImages: 0, furniture: 0, names: [] };

  for (const raw of list) {
    const name = String(raw?.name || '');
    const contentType = String(raw?.contentType || '');
    const size = Number(raw?.size) || 0;
    const isInline = Boolean(raw?.isInline);

    if (!IMAGE_TYPE.test(contentType)) {
      summary.nonImages += 1;
      continue;
    }
    if (FURNITURE_NAME.test(name) || (isInline && size <= INLINE_EVIDENCE_MIN_BYTES)) {
      summary.furniture += 1;
      continue;
    }
    summary.images += 1;
    if (name) summary.names.push(name);
  }

  return summary;
}

/**
 * The verdict, over every inbound message on the ticket.
 *
 * `attachmentsKnown` is the honest half of this. Attachment metadata is fetched
 * from Graph at ingestion, so mail stored before that existed carries
 * `has_attachments` and nothing else. For those rows the answer to "is it a
 * photo" is genuinely unknown, and `attachment_type_unknown` says so instead of
 * guessing either way — the same rule the Insights panels follow, where an
 * unmeasured figure is a dash and never a zero.
 *
 * Outcomes, and what a drafting step would do with each:
 *   `attached`                 — a photo is here. Proceed.
 *   `mentioned_not_attached`   — they meant to. Ask them to resend it.
 *   `attachment_type_unknown`  — something is attached, type unrecorded. A person looks.
 *   `none`                     — nothing said, nothing sent. Ask for a photo.
 */
export function summarisePhotoEvidence(messages = []) {
  const inbound = (Array.isArray(messages) ? messages : []).filter(
    (message) => message && message.direction !== 'outbound'
  );

  let mentioned = false;
  let matchedTerm = null;
  let flaggedAttachments = false;
  let attachmentsKnown = true;
  const totals = { images: 0, nonImages: 0, furniture: 0 };
  const names = [];

  for (const message of inbound) {
    const mention = detectPhotoMention(message.body_text ?? message.bodyText ?? '');
    if (mention.mentioned && !mentioned) {
      mentioned = true;
      matchedTerm = mention.term;
    }

    const flagged = Boolean(message.has_attachments ?? message.hasAttachments);
    if (flagged) flaggedAttachments = true;

    const raw = message.attachments ?? message.attachmentMetadata ?? null;
    // A flagged message with no metadata array is a row from before the fetch
    // existed. An unflagged message needs no metadata to be complete.
    if (flagged && !Array.isArray(raw)) {
      attachmentsKnown = false;
      continue;
    }

    const summary = classifyAttachments(raw);
    totals.images += summary.images;
    totals.nonImages += summary.nonImages;
    totals.furniture += summary.furniture;
    names.push(...summary.names);
  }

  const outcome = decide({ images: totals.images, mentioned, flaggedAttachments, attachmentsKnown });

  return {
    outcome,
    mentioned,
    matchedTerm,
    attachmentsFlagged: flaggedAttachments,
    attachmentsKnown,
    images: totals.images,
    nonImages: totals.nonImages,
    furniture: totals.furniture,
    imageNames: names
  };
}

function decide({ images, mentioned, flaggedAttachments, attachmentsKnown }) {
  if (images > 0) return 'attached';
  // Unknown beats "not attached": claiming nothing came through when the
  // metadata was never fetched would tell a customer to resend a photo they
  // already sent, which is worse than admitting the gap.
  if (!attachmentsKnown) return 'attachment_type_unknown';
  if (mentioned) return 'mentioned_not_attached';
  if (flaggedAttachments) return 'none';
  return 'none';
}

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
