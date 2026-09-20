// Does this ticket already carry the photo a damage claim will need?
//
// IT LIVES IN `scripts/lib` because it has three readers — the investigation
// agent (`agent/src/investigation/photo-evidence.mjs`, which re-exports every
// name below), the attachment backfill, and the tickets dashboard. The same
// argument as `llm-rates.mjs` and `tracking-number.mjs`: a rule the agent and
// the dashboard both apply belongs to neither of them. (`web/lib/server` can
// and does import from `agent/src`, so this is about ownership rather than
// about reach.) The failure it avoids is a second copy of the furniture rules
// drifting, and showing an operator a signature logo as a customer's photo.
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
  /\bimages?\b/i,
  // NOT A FRENCH MAILBOX. 119 of the last 1 000 orders shipped outside France —
  // Belgium, Italy, the Netherlands, Spain, Portugal, Switzerland — and a
  // customer writes in their own language. « les adjunto foto de la caja »
  // (ticket d48f1c08) matched nothing above: `photos?` does not match "foto",
  // and the mention check is the backstop for exactly that message, whose
  // attachment was inline and therefore invisible to every other signal.
  //
  // Kept to the words that mean a picture in Spanish, Italian and Portuguese,
  // plus the two ways of saying "attached". `adjunt` and `allegat` inflect
  // (adjunto/adjunta/adjuntos, allegato/allegata), and every inflection means
  // the same thing here.
  /\bfotos?\b/i,
  /\bfotograf[íi]as?\b/i,
  /\bimagens?\b/i,
  /\bimm[aá]gini?\b/i,
  /\badjunt[oa]s?\b/i,
  /\ballegat[oaie]\b/i,
  /\banexos?\b/i
];

/**
 * Attachment names that are never evidence.
 *
 * A mailbox this size collects the same half-dozen corporate furniture files on
 * every message — the logo in a signature, the Outlook-generated placeholder for
 * an inline image. Matching on the NAME rather than only on `isInline` matters
 * because a customer who pastes a photo into the body also produces an inline
 * part, and excluding all inline parts would drop exactly the evidence we want.
 *
 * `(?![a-z0-9])` RATHER THAN `\b`, and it is the same trap `cliché` set above:
 * `_` is a word character, so `\b` does not exist between `Signature` and `_`
 * and `Signature_6C20675392446.png` — a 12 KB, non-inline signature image —
 * was classified as a customer's photo. Measured over the corpus's 115 image
 * parts, this changes exactly one: that file, on ticket `6ad65501`, which is a
 * `delivery/problem` whose case file therefore read `photo_evidence: attached`
 * with no photo anywhere. A negative lookahead is what the name pattern meant
 * all along; `\b` was the shorthand that did not survive an underscore.
 */
const FURNITURE_NAME =
  /^(image\d{3,}|logo|signature|oledata|outlook-[a-z0-9]+)(?![a-z0-9])|\.(?:emz|wmf|vml)$/i;

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
    if (isFurniture(name, size, isInline)) {
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
 * TWO DIFFERENT IGNORANCES, AND THEY ARE NOT INTERCHANGEABLE. `attachmentsKnown`
 * is false when a message SAYS it carries something we never identified — a
 * person should look. `attachmentsChecked` is false when we never asked Graph at
 * all, which until 2026-09-20 was silently folded into "nothing attached": the
 * `null` the column keeps precisely to record "not learned" was coerced to `[]`
 * one frame later. Collapsing them cost ticket d48f1c08 two months parked on a
 * 3.6 MB inline photo the customer sent in July.
 *
 * Neither is a dash for the sake of it — the same rule the Insights panels
 * follow, where an unmeasured figure is never a zero.
 *
 * Outcomes, and what a drafting step would do with each:
 *   `attached`                 — a photo is here. Proceed.
 *   `mentioned_not_attached`   — they meant to. Ask them to resend it.
 *   `attachment_type_unknown`  — something is attached, type unrecorded. A person looks.
 *   `not_checked`              — we never asked the mailbox. Nothing may be concluded.
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
  let attachmentsChecked = true;
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
    // NO METADATA MEANS WE NEVER LOOKED, WHATEVER THE FLAG SAYS. The stronger
    // claim — something IS attached and we could not identify it — still needs
    // the flag. The weaker one does not, and used to require it: an unflagged
    // row with no metadata fell through to `classifyAttachments(null)`, which
    // coerces null to `[]` and reports zero images as fact. Exchange sets
    // `hasAttachments: false` when the only attachment is inline, so that path
    // was exactly the one a customer's pasted photo took.
    if (!Array.isArray(raw)) {
      attachmentsChecked = false;
      if (flagged) attachmentsKnown = false;
      continue;
    }

    const summary = classifyAttachments(raw);
    totals.images += summary.images;
    totals.nonImages += summary.nonImages;
    totals.furniture += summary.furniture;
    names.push(...summary.names);
  }

  const outcome = decide({
    images: totals.images,
    mentioned,
    flaggedAttachments,
    attachmentsKnown,
    attachmentsChecked
  });

  return {
    outcome,
    mentioned,
    matchedTerm,
    attachmentsFlagged: flaggedAttachments,
    attachmentsKnown,
    attachmentsChecked,
    images: totals.images,
    nonImages: totals.nonImages,
    furniture: totals.furniture,
    imageNames: names
  };
}

function decide({ images, mentioned, flaggedAttachments, attachmentsKnown, attachmentsChecked }) {
  if (images > 0) return 'attached';
  // Unknown beats "not attached": claiming nothing came through when the
  // metadata was never fetched would tell a customer to resend a photo they
  // already sent, which is worse than admitting the gap.
  if (!attachmentsKnown) return 'attachment_type_unknown';
  // AHEAD OF `mentioned`, because it is the stronger statement. "They mentioned
  // a photo and none arrived" is a claim about what arrived; here we do not know
  // what arrived, and a mention does not make the gap smaller.
  if (!attachmentsChecked) return 'not_checked';
  if (mentioned) return 'mentioned_not_attached';
  if (flaggedAttachments) return 'none';
  return 'none';
}

/**
 * The attachment list the ticket panel renders, beside the verdict.
 *
 * WHY A SECOND FUNCTION AND NOT A FIELD ON THE VERDICT. `summarisePhotoEvidence`
 * answers "is there a photo" in counts, which is all a drafting decision needs
 * and deliberately all it carries. A person looking at the ticket is asking a
 * different question — *what* is attached — and that needs the parts themselves:
 * a `facture.pdf` and a `CV.pdf` are the same `nonImages: 1` to the agent and
 * two completely different tickets to an operator.
 *
 * FURNITURE IS COUNTED, NEVER LISTED. The name pattern and the 50 KB inline
 * floor exist because a signature logo arrives on a large share of business
 * mail; listing them would put `image001.png` under a "Photos" heading on
 * hundreds of tickets and teach the reader to ignore the block. The count still
 * travels so the panel can say "2 inline images ignored" rather than pretend
 * they did not exist.
 *
 * ORDER IS ARRIVAL ORDER, oldest message first, as the caller passes them. A
 * damage claim's photos read as a sequence — the parcel, then the label, then
 * the product — and sorting by name or size would break the only ordering the
 * customer actually chose.
 *
 * NO BYTES, STILL. Every field here is Graph metadata; nothing in this file has
 * ever opened an attachment. What the panel shows today is the file's name,
 * type and size. See DECISIONS.md § "The photo itself is not stored" for why
 * showing the image is a separate decision with a separate blocker.
 *
 * @param {Array<object>} messages  ticket messages, inbound and outbound.
 * @returns {{images: object[], others: object[], furniture: number,
 *   known: boolean, mentioned: boolean, matchedTerm: string|null,
 *   outcome: string}}
 */
export function listTicketAttachments(messages = []) {
  const inbound = (Array.isArray(messages) ? messages : []).filter(
    (message) => message && message.direction !== 'outbound'
  );

  const images = [];
  const others = [];
  let furniture = 0;

  for (const message of inbound) {
    const raw = message.attachments ?? message.attachmentMetadata ?? null;
    if (!Array.isArray(raw)) continue;

    const messageId = message.graph_message_id ?? message.graphMessageId ?? null;

    raw.forEach((part, partIndex) => {
      const name = String(part?.name || '');
      const contentType = String(part?.contentType || '');
      const size = Number(part?.size) || 0;
      const isInline = Boolean(part?.isInline);
      // `messageId` and `partIndex` are the fetch handle, and they are the whole
      // reason a part knows where it came from: Graph addresses an attachment as
      // (message, attachment id), and the id is not stored — see
      // `resolveAttachment` in the dashboard's attachment service, which asks
      // Graph for the message's parts and matches this name and size back.
      const entry = {
        name: name || null,
        contentType: contentType || null,
        size,
        messageId,
        partIndex
      };

      if (!/^image\//i.test(contentType)) {
        others.push(entry);
        return;
      }
      if (isFurniture(name, size, isInline)) {
        furniture += 1;
        return;
      }
      images.push(entry);
    });
  }

  // The verdict is not recomputed here — it is the same function the agent
  // reads, so the panel and the case file can never disagree about whether a
  // photo arrived.
  const evidence = summarisePhotoEvidence(messages);

  return {
    images,
    others,
    furniture,
    known: evidence.attachmentsKnown,
    mentioned: evidence.mentioned,
    matchedTerm: evidence.matchedTerm,
    outcome: evidence.outcome
  };
}

/**
 * The furniture test, shared by the classifier and the list.
 *
 * Extracted so the two cannot disagree: `classifyAttachments` counting a part as
 * furniture while `listTicketAttachments` rendered it as a photo is precisely
 * the drift that made this file shared in the first place.
 */
function isFurniture(name, size, isInline) {
  return FURNITURE_NAME.test(name) || (isInline && size <= INLINE_EVIDENCE_MIN_BYTES);
}

/**
 * The same list, as the BROWSER may see it.
 *
 * THIS FUNCTION IS A BOUNDARY, not a formatting step. `listTicketAttachments`
 * puts `messageId` — an Exchange item id — and `partIndex` on every entry so the
 * image proxy can find the file again. Both are server-side addressing: shipped
 * to a page they would be useless to the reader and a durable identifier for one
 * customer's email, sitting in the HTML source of a dashboard that has no
 * authentication yet.
 *
 * NAMING THE FIELDS THAT CROSS, rather than deleting the two that must not, is
 * the point. A blocklist has to be updated every time the projection above gains
 * a field; this way a new field stays server-side until somebody decides
 * otherwise, which is the direction the mistake should fall in.
 *
 * `src` REPLACES THEM on images: a path under the dashboard's own origin that
 * `attachment-service.mjs` resolves back to a message and an attachment id.
 * `others` get null — that route serves images only, and a link that 404s by
 * design is worse than no link.
 */
export function toPublicAttachments(ticketId, listed) {
  const publicFile = (file, src) => ({
    name: file?.name ?? null,
    contentType: file?.contentType ?? null,
    size: Number(file?.size) || 0,
    src
  });

  return {
    images: (listed?.images ?? []).map((file, index) =>
      publicFile(file, `/api/tickets/${encodeURIComponent(ticketId)}/attachments/${index}`)
    ),
    others: (listed?.others ?? []).map((file) => publicFile(file, null)),
    furniture: Number(listed?.furniture) || 0,
    known: Boolean(listed?.known),
    mentioned: Boolean(listed?.mentioned),
    matchedTerm: listed?.matchedTerm ?? null,
    outcome: listed?.outcome ?? 'none'
  };
}
