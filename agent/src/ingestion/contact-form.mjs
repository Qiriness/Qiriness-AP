// Parses the Shopify storefront contact-form notification into the customer it
// is actually about.
//
// Shopify sends these from its own infrastructure, so the envelope is useless as
// identity: `from` is mailer@shopify.com / "Qiriness (Shopify)", and on a real
// inbox that made 95 tickets collapse onto 2 requester hashes. The customer's
// name, address, country and message are all in the BODY, as labelled fields:
//
//     Vous avez reçu un nouveau message du formulaire de contact de votre boutique en ligne.
//
//     Indicatif de pays:
//     FR
//
//     Name:
//     Dominique RAVAUX
//
//     E-mail:
//     doravaux@orange.fr
//
//     Phone:
//
//     Corps:
//     Bonjour, ...
//
// Reading them is strictly better than inferring them: `requester_email_hash` is
// the join key to orders.customer_email_hash, so a wrong address breaks order
// lookup outright, and no amount of model accuracy recovers an address that was
// never in the prompt.
//
// Deliberately tolerant. Shopify localises the labels and merchants reorder the
// form, so this matches on a set of known labels in any order, accepts the value
// on the same line or the next, and returns `null` rather than guessing when the
// wrapper is not recognised. A parse failure must degrade to today's behaviour,
// never to a wrong customer.

/**
 * Labels this parser understands, each mapped to the field it fills. Lower-cased
 * and compared without the trailing colon. Several spellings per field because
 * the form is localised and merchant-editable.
 *
 * `category` and `order_number` are not on the Qiriness form yet — they are the
 * planned dropdown and its conditional order-number input. Listing them now
 * means the parser starts filling them the day the form ships, with no code
 * change and no re-ingest.
 */
const FIELD_LABELS = new Map([
  ['name', 'name'],
  ['nom', 'name'],
  ['nom complet', 'name'],
  ['e-mail', 'email'],
  ['email', 'email'],
  ['adresse e-mail', 'email'],
  ['courriel', 'email'],
  ['phone', 'phone'],
  ['téléphone', 'phone'],
  ['telephone', 'phone'],
  ['numéro de téléphone', 'phone'],
  ['indicatif de pays', 'countryCode'],
  ['country code', 'countryCode'],
  ['pays', 'countryCode'],
  ['corps', 'body'],
  ['body', 'body'],
  ['message', 'body'],
  ['comments', 'body'],
  // Planned form fields (see above).
  ['catégorie', 'declaredCategory'],
  ['categorie', 'declaredCategory'],
  ['category', 'declaredCategory'],
  ['sujet', 'declaredCategory'],
  ['numéro de commande', 'orderNumber'],
  ['numero de commande', 'orderNumber'],
  ['order number', 'orderNumber'],
  ['commande', 'orderNumber']
]);

// The wrapper sentence Shopify puts at the top. Matched loosely (any of these
// phrases) so a localised or lightly reworded template still registers.
const WRAPPER_MARKERS = [
  /formulaire de contact/i,
  /contact form/i,
  /nouveau message du formulaire/i
];

/** `body` is the customer's own text, so it runs to the end rather than to the next blank line. */
const BODY_FIELD = 'body';

/**
 * @param {string|null|undefined} bodyText cleaned plain-text email body
 * @returns {null | {
 *   name: string|null, email: string|null, phone: string|null, countryCode: string|null,
 *   body: string|null, declaredCategory: string|null, orderNumber: string|null
 * }} null when this is not a recognisable contact-form notification
 */
export function parseContactForm(bodyText) {
  if (typeof bodyText !== 'string' || bodyText.length === 0) {
    return null;
  }
  if (!WRAPPER_MARKERS.some((marker) => marker.test(bodyText))) {
    return null;
  }

  const lines = bodyText.split(/\r?\n/);
  const fields = {
    name: null,
    email: null,
    phone: null,
    countryCode: null,
    body: null,
    declaredCategory: null,
    orderNumber: null
  };

  for (let i = 0; i < lines.length; i += 1) {
    const label = matchLabel(lines[i]);
    if (!label) {
      continue;
    }

    if (label.field === BODY_FIELD) {
      // Everything after the body label belongs to the customer, blank lines and
      // sign-off included — stopping at the next blank line would truncate every
      // multi-paragraph message.
      const rest = [label.inlineValue, ...lines.slice(i + 1)].filter((line) => line !== null);
      fields.body = trimBlank(rest.join('\n')) || null;
      break;
    }

    // Shopify puts the value on the line after the label; a merchant-edited
    // template may put it on the same line. Accept both, and treat an empty
    // value as absent (Phone: is routinely blank).
    fields[label.field] = label.inlineValue || nextNonEmpty(lines, i + 1) || null;
  }

  // A wrapper with no recoverable identity is not a parse — better to fall back
  // to the envelope than to write half a customer.
  if (!fields.email && !fields.name) {
    return null;
  }

  return {
    ...fields,
    email: normaliseEmail(fields.email),
    countryCode: normaliseCountry(fields.countryCode)
  };
}

/** True when this body is a contact-form notification at all, parseable or not. */
export function isContactFormEmail(bodyText) {
  return typeof bodyText === 'string' && WRAPPER_MARKERS.some((marker) => marker.test(bodyText));
}

function matchLabel(line) {
  if (typeof line !== 'string') {
    return null;
  }
  const colon = line.indexOf(':');
  if (colon < 0) {
    return null;
  }
  const label = line.slice(0, colon).trim().toLowerCase();
  const field = FIELD_LABELS.get(label);
  if (!field) {
    return null;
  }
  return { field, inlineValue: line.slice(colon + 1).trim() || null };
}

/**
 * The next line carrying something, skipping blanks. Stops at another label so a
 * blank field cannot swallow the following field's value — `Phone:` immediately
 * followed by `Corps:` must leave the phone null, not set it to "Corps:".
 */
function nextNonEmpty(lines, from) {
  for (let i = from; i < lines.length; i += 1) {
    const value = (lines[i] || '').trim();
    if (!value) {
      continue;
    }
    return matchLabel(lines[i]) ? null : value;
  }
  return null;
}

function normaliseEmail(value) {
  if (!value) {
    return null;
  }
  // The value may arrive decorated ("Name <a@b.com>") depending on the template.
  const match = value.match(/[^\s<>()[\],;:]+@[^\s<>()[\],;:]+\.[^\s<>()[\],;:]+/);
  return match ? match[0].trim().toLowerCase() : null;
}

/** Two-letter ISO country code, or null. Never used to infer language — see below. */
function normaliseCountry(value) {
  if (!value) {
    return null;
  }
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function trimBlank(text) {
  return text.replace(/^\s*\n/, '').replace(/\s+$/, '');
}
