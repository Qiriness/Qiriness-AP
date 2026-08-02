// Tells our own mail apart from customer mail, by sender domain.
//
// WHY THIS EXISTS. `direction` records which way a message travelled through the
// support mailbox, not who wrote it. A colleague emailing the support address is
// `inbound` by that definition — correct for threading, wrong for any question
// of the form "what are customers asking?".
//
// It is not a rounding error. Measured on the corpus at 1111 embedded inbound
// messages, 331 of them (30%) came from our own domain, and they dominated the
// topic clusters: five of the top ten `delivery` topics were staff chasing the
// carrier ("Ci-joint les POD", "peux-tu vérifier la quantité livrée"). The
// clustering report ranks topics by demand to decide which knowledge article to
// write next, so that noise was recommending customer-facing articles about
// internal logistics chasing.
//
// Pure: no I/O, no config loading. The caller supplies the domains.

/**
 * The internal domains, derived from the support mailbox rather than hardcoded.
 *
 * The mailbox address is already configured (`SUPPORT_MAILBOX`), and its domain
 * is by definition ours — so this stays correct if the company or the address
 * changes, and no business fact is baked into source. `extra` carries
 * `INTERNAL_EMAIL_DOMAINS` for the cases config cannot infer: a second corporate
 * domain, or a logistics provider whose mail is operational rather than a
 * customer question.
 */
export function resolveInternalDomains({ supportMailbox, extra = [] } = {}) {
  const domains = new Set();
  const mailboxDomain = emailDomain(supportMailbox);
  if (mailboxDomain) {
    domains.add(mailboxDomain);
  }
  for (const domain of extra) {
    const normalised = String(domain || '').trim().toLowerCase().replace(/^@/, '');
    if (normalised) {
      domains.add(normalised);
    }
  }
  return [...domains];
}

/** Lowercased domain part of an address, or null if there isn't one. */
export function emailDomain(email) {
  const at = String(email || '').trim().toLowerCase().lastIndexOf('@');
  if (at < 0) {
    return null;
  }
  const domain = String(email).trim().toLowerCase().slice(at + 1);
  return domain || null;
}

/**
 * Subdomains count as internal: mail from `mail.example.com` is still ours when
 * `example.com` is. A sender with no parseable address is treated as external,
 * because the safe failure is to over-report customer demand rather than to hide
 * a real customer question from the report.
 */
export function isInternalSender(fromEmail, internalDomains) {
  const domain = emailDomain(fromEmail);
  if (!domain) {
    return false;
  }
  return internalDomains.some(
    (internal) => domain === internal || domain.endsWith(`.${internal}`)
  );
}

/**
 * Splits messages into the two audiences. Both sides are returned rather than
 * filtering in place, so a caller can report on internal threads deliberately —
 * a recurring internal thread is an ops-automation signal, just not a knowledge
 * -library one.
 */
export function partitionByAudience(messages, internalDomains, key = 'from_email') {
  const customer = [];
  const internal = [];
  for (const message of messages) {
    (isInternalSender(message[key], internalDomains) ? internal : customer).push(message);
  }
  return { customer, internal };
}
