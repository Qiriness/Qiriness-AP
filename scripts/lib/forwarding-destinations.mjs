// Where mail that the contact team does not own is sent, and what the sender is
// told when it goes.
//
// Pure: a destination row in, a validated row or a sentence out. The dashboard
// writes destinations and previews the acknowledgement; the worker will route
// on them and send it. The rules live here once so the two cannot disagree.
//
// It lives in `scripts/lib` because `web/` and `agent/` both read it, and it has
// node tests here because `web/` has no test runner (the order-link.mjs rule).
//
// NOTHING HERE NAMES A BUSINESS. Destinations, their descriptions and the
// acknowledgement text are data per shop; the only literals are the default
// templates, which say « the relevant team » and sign with the shop's own name.

import { REQUEST_KINDS, TICKET_SUBJECTS } from './support-taxonomy.mjs';

/**
 * When a destination receives the thread.
 *
 * `immediate`: forwarded as soon as the router picks it, and the sender gets the
 * fixed acknowledgement. `after_first_reply`: the contact team answers first
 * (cosmetovigilance and defects ask for the batch number, photos and the place
 * of purchase), and the thread is forwarded once that reply has gone out.
 */
export const FORWARD_TIMINGS = Object.freeze(['immediate', 'after_first_reply']);

/** The two languages an acknowledgement is written in. Anything else reads English. */
export const ACK_LANGUAGES = Object.freeze(['fr', 'en']);

/**
 * The defaults, used whenever a shop has not written its own.
 *
 * `{service}` is the destination's customer-facing name, or the generic phrase
 * when it has none. IN FRENCH IT CARRIES ITS OWN PREPOSITION (« au service
 * comptabilité », « à notre équipe RH »): a template writing « à {service} »
 * produces « à le service », and the contraction depends on the noun. `{note}` is the
 * destination's extra paragraph and disappears with its blank line when empty.
 * `{shop}` is the shop's name, so the signature is never a hard-coded brand.
 */
export const DEFAULT_ACK_TEMPLATES = Object.freeze({
  fr:
    'Bonjour,\n\n' +
    'Merci pour votre message. Nous l\'avons transmis {service}, qui reviendra vers vous directement.\n\n' +
    '{note}\n\n' +
    'Bien cordialement,\n' +
    'Le service client {shop}',
  en:
    'Hello,\n\n' +
    'Thank you for your message. We have passed it on to {service}, who will get back to you directly.\n\n' +
    '{note}\n\n' +
    'Kind regards,\n' +
    '{shop} Customer Service'
});

/** What `{service}` reads when a destination has no customer-facing name. */
export const GENERIC_SERVICE = Object.freeze({
  fr: 'au service concerné',
  en: 'the relevant team'
});

const LIMITS = Object.freeze({ label: 80, description: 1000, publicName: 120, note: 1000, template: 4000 });

/**
 * Validates and normalises one destination as a person typed it.
 *
 * Returns `{ ok: true, value }` with the row to store (snake_case, the table's
 * own columns) or `{ ok: false, error }` with one sentence a person can act on.
 *
 * AN EMPTY ADDRESS IS ALLOWED: a destination can be described before anyone
 * knows its address. It cannot be switched on until it has one.
 *
 * `active_since` is not here on purpose. Switching a destination on or off is
 * its own action (like the global switch), so saving the form can never move
 * the moment it started receiving mail.
 */
export function normaliseDestination(input = {}) {
  const label = clean(input.label);
  if (!label) {
    return fail('Give the destination a name.');
  }
  if (label.length > LIMITS.label) {
    return fail(`The name is longer than ${LIMITS.label} characters.`);
  }

  const rawEmail = clean(input.forwardEmail).toLowerCase();
  const forwardEmail = rawEmail || null;
  if (forwardEmail && !isEmailAddress(forwardEmail)) {
    return fail(`"${rawEmail}" is not a valid email address.`);
  }

  const categories = uniqueIn(input.categories, TICKET_SUBJECTS);
  if (categories === null) {
    return fail('One of the categories is not a ticket category.');
  }
  if (categories.length === 0) {
    return fail('Choose at least one category this destination receives.');
  }

  const requestKinds = uniqueIn(input.requestKinds, REQUEST_KINDS);
  if (requestKinds === null) {
    return fail('One of the request kinds is not a request kind.');
  }

  const timing = input.timing ?? 'immediate';
  if (!FORWARD_TIMINGS.includes(timing)) {
    return fail(`"${timing}" is not a forwarding timing.`);
  }

  // The acknowledgement tells the sender their mail has been handed over. A
  // destination that waits for our first reply has already written to them, so
  // a second, templated message would only repeat it.
  const acknowledge = timing === 'immediate' && input.acknowledge !== false;

  const description = clean(input.description);
  if (description.length > LIMITS.description) {
    return fail(`The description is longer than ${LIMITS.description} characters.`);
  }

  const texts = {
    public_name_fr: clean(input.publicNameFr),
    public_name_en: clean(input.publicNameEn),
    ack_note_fr: cleanBlock(input.ackNoteFr),
    ack_note_en: cleanBlock(input.ackNoteEn)
  };
  for (const [column, value] of Object.entries(texts)) {
    const limit = column.startsWith('public_name') ? LIMITS.publicName : LIMITS.note;
    if (value.length > limit) {
      return fail(`A text in the acknowledgement is longer than ${limit} characters.`);
    }
  }

  const position = Number.isInteger(input.position) && input.position >= 0 ? input.position : 0;
  const matchDescription = input.matchDescription === true;
  if (matchDescription && !description) {
    return fail('Describe what this destination handles: the agent checks the mail against it.');
  }

  return {
    ok: true,
    value: {
      label,
      forward_email: forwardEmail,
      description,
      categories,
      request_kinds: requestKinds,
      match_description: matchDescription,
      timing,
      acknowledge,
      public_name_fr: texts.public_name_fr || null,
      public_name_en: texts.public_name_en || null,
      ack_note_fr: texts.ack_note_fr || null,
      ack_note_en: texts.ack_note_en || null,
      position
    }
  };
}

/**
 * Validates the shop-wide acknowledgement settings. An empty template stores
 * null, which means « use the default » — so clearing the box restores it.
 */
export function normaliseAckSettings(input = {}) {
  const out = { ack_enabled: input.ackEnabled === true };
  for (const language of ACK_LANGUAGES) {
    const key = language === 'fr' ? 'ackTemplateFr' : 'ackTemplateEn';
    const value = cleanBlock(input[key]);
    if (value.length > LIMITS.template) {
      return fail(`The ${language.toUpperCase()} template is longer than ${LIMITS.template} characters.`);
    }
    out[`ack_template_${language}`] = value || null;
  }
  return { ok: true, value: out };
}

/**
 * Whether a destination receives mail: switched on (`active_since`, the moment
 * it was) and with an address to send to.
 *
 * A DATE, NOT A FLAG, for the same reason as the global switch: a destination
 * receives only mail that arrived after it was switched on. Switching one back
 * on must not deliver everything that arrived while it was off.
 */
export function isActive(destination) {
  return Boolean(destination?.forward_email && destination?.active_since);
}

/**
 * Which destinations a ticket of this category and kind may go to.
 *
 * Only active destinations count: one switched off must not turn a fixed route
 * into a model choice, nor be offered to the model.
 */
export function candidatesFor(destinations, { category, requestKind } = {}) {
  return (destinations ?? []).filter(
    (d) =>
      isActive(d) &&
      (d.categories ?? []).includes(category) &&
      ((d.request_kinds ?? []).length === 0 || d.request_kinds.includes(requestKind))
  );
}

/**
 * How each category is routed today, for the settings page and the router.
 *
 * `stays`: no active destination, the contact team handles it. `fixed`: exactly
 * one, taken without a model call. `choice`: the router reads the mail and picks
 * from the descriptions — or keeps the ticket. That is several destinations, or
 * one marked `match_description`, which only takes the mail that fits it.
 *
 * Request kinds are ignored here on purpose: this answers « can mail of this
 * category leave », and a destination limited to problems still makes the
 * category partly routable.
 *
 * @returns {Record<string, { mode: 'stays' | 'fixed' | 'choice', destinations: string[] }>}
 */
export function routingModeByCategory(destinations) {
  /** @type {Record<string, { mode: 'stays' | 'fixed' | 'choice', destinations: string[] }>} */
  const modes = {};
  for (const category of TICKET_SUBJECTS) {
    const active = (destinations ?? []).filter((d) => isActive(d) && (d.categories ?? []).includes(category));
    modes[category] = {
      mode:
        active.length === 0
          ? 'stays'
          : active.length === 1 && !active[0].match_description
            ? 'fixed'
            : 'choice',
      destinations: active.map((d) => d.label)
    };
  }
  return modes;
}

/** The language an acknowledgement is written in: French stays French, the rest reads English. */
export function ackLanguage(ticketLanguage) {
  return ticketLanguage === 'fr' || !ticketLanguage ? 'fr' : 'en';
}

/**
 * The acknowledgement, as it will be sent. Fixed text, never model-written.
 *
 * Tokens the template does not use are simply not filled; a token the template
 * misspells stays visible in the preview, which is where it gets noticed.
 */
export function renderAcknowledgement({ destination, settings, shopName, language } = {}) {
  const lang = ACK_LANGUAGES.includes(language) ? language : 'en';
  const template = cleanBlock(settings?.[`ack_template_${lang}`]) || DEFAULT_ACK_TEMPLATES[lang];
  const service = clean(destination?.[`public_name_${lang}`]) || GENERIC_SERVICE[lang];
  const note = cleanBlock(destination?.[`ack_note_${lang}`]);
  const shop = clean(shopName);

  return template
    // An empty note takes its own paragraph break with it, not a blank gap.
    .replace(/\n*\{note\}\n*/g, note ? `\n\n${note}\n\n` : '\n\n')
    .replaceAll('{service}', service)
    .replaceAll('{shop}', shop)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Whether an address is a machine rather than a person, and so must never get
 * an acknowledgement: replying to a noreply is at best a bounce, at worst a
 * loop with another system's autoresponder.
 *
 * Read off the local part only. Shopify's contact-form relay is not here
 * because ingestion already stores the customer's own address for those.
 */
export function isAutomatedAddress(email) {
  const local = String(email ?? '').trim().toLowerCase().split('@')[0] ?? '';
  return AUTOMATED_LOCAL_PART.test(local);
}

const AUTOMATED_LOCAL_PART =
  /^(no-?reply|do-?not-?reply|donotreply|ne-?pas-?repondre|nepasrepondre|mailer-daemon|postmaster|bounces?|notifications?|mailer|automated|auto-?reply)([+._-]|$)/;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Like `clean`, but keeps line breaks: templates and notes are paragraphs. */
function cleanBlock(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .trim();
}

/**
 * Deliberately loose: something before an @, a dotted domain after it. Whether
 * the mailbox exists is decided by Graph accepting the send.
 */
function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Deduplicated, in the vocabulary's own order; null when anything is outside it. */
function uniqueIn(values, vocabulary) {
  const list = Array.isArray(values) ? values.map(String) : [];
  if (list.some((value) => !vocabulary.includes(value))) {
    return null;
  }
  return vocabulary.filter((value) => list.includes(value));
}

function fail(error) {
  return { ok: false, error };
}
