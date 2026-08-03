// Shapes a `customers` row into the facts support actually answers from.
//
// Pure: a row in, a bundle out. No database, no clock.
//
// WHY THIS IS ITS OWN MODULE. This shaping was born inside the order-context
// bundle, where a customer is only ever reached through their order. But half
// the questions that need it — "combien de commandes ai-je passées ?", "mon
// compte est-il bien actif ?" — arrive with no order number at all, and under
// the old arrangement they could not be answered: the customer bundle only
// existed as a by-product of resolving an order. Extracting it lets the standalone
// lookup and the order bundle return the *same* customer shape, so a drafting
// step reads one contract however the customer was found.
//
// PERSONAL DATA. The bundle carries the buyer's name and email because support
// cannot confirm an account without them. It carries NO phone and NO street
// address — the sync stores only a coarse city/country and nothing here reaches
// past that. `toPromptText` goes further and withholds the email unless the
// caller asks for it; see the note there.

/**
 * The customer facts that change how a reply is written, and nothing else.
 *
 * No phone, no street address, no order history beyond the aggregate — a first
 * order and a fortieth are answered differently, but the list of the other
 * thirty-nine is not needed to answer this one.
 *
 * This is the exact shape already stored in `tickets.resolved_context.customer`.
 * Changing it changes every bundle written so far, so add to the standalone
 * sections below rather than widening this one.
 */
export function buildCustomerContext(customer) {
  if (!customer) {
    return null;
  }
  return {
    name: customer.display_name || [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null,
    email: customer.email || null,
    locale: customer.locale || null,
    ordersCount: customer.number_of_orders ?? null,
    amountSpent: num(customer.amount_spent),
    amountSpentCurrency: customer.amount_spent_currency || null,
    rfmGroup: customer.rfm_group || null,
    subscribedToNewsletter: customer.on_email_marketing_list ?? null,
    location: {
      city: customer.default_address_city || null,
      country: customer.default_address_country || null
    },
    lastOrder: {
      name: customer.last_order_name || null,
      at: customer.last_order_at || null,
      total: num(customer.last_order_total)
    },
    tags: Array.isArray(customer.tags) ? customer.tags : []
  };
}

/**
 * Account state, which only the standalone lookup needs.
 *
 * Deliberately NOT part of `buildCustomerContext`: someone writing in about an
 * order is not asking whether their account is enabled, and adding it there
 * would rewrite the shape of every context bundle already stored.
 *
 * `state` is Shopify's own account status. The distinction that matters to
 * support is `INVITED` versus `ENABLED` — an invited customer has an order but
 * has never activated the account, which is the actual answer to "je n'arrive
 * pas à me connecter" and is otherwise indistinguishable from a forgotten
 * password.
 */
export function buildAccountState(customer) {
  if (!customer) {
    return null;
  }
  const state = customer.state || null;
  return {
    state,
    // Spelled out rather than left as a raw enum: a model handed `INVITED` tends
    // to report it verbatim to the customer.
    canSignIn: state === 'ENABLED',
    neverActivated: state === 'INVITED',
    disabled: state === 'DISABLED' || state === 'DECLINED',
    emailVerified: customer.verified_email ?? null,
    emailUsable: customer.valid_email_address ?? null,
    marketing: {
      state: customer.email_marketing_state || null,
      subscribed: customer.on_email_marketing_list ?? null,
      updatedAt: customer.email_marketing_consent_updated_at || null
    }
  };
}

/**
 * Renders the bundle as the text a model receives.
 *
 * THE EMAIL IS WITHHELD BY DEFAULT. The drafting step is replying *to* that
 * address; restating it in the prompt adds a personal identifier to the model's
 * context for no gain, and AGENTS.md asks for exactly that to be minimised. The
 * one case that genuinely needs it — "sous quelle adresse est mon compte ?" —
 * opts in explicitly, so the exception is visible at the call site rather than
 * being the silent default.
 */
export function toPromptText(context, account = null, { includeEmail = false } = {}) {
  if (!context) {
    return 'Aucun compte client ne correspond à cette adresse.';
  }

  const parts = [`# Client : ${context.name || 'nom inconnu'}`];

  if (includeEmail && context.email) {
    parts.push(`Compte enregistré sous : ${context.email}`);
  }

  const history = [
    `Commandes passées : ${context.ordersCount ?? 'inconnu'}`,
    context.amountSpent !== null
      ? `Total dépensé : ${context.amountSpent} ${context.amountSpentCurrency || ''}`.trim()
      : null,
    context.lastOrder.name
      ? `Dernière commande : ${context.lastOrder.name}` +
        (context.lastOrder.at ? ` (${context.lastOrder.at.slice(0, 10)})` : '')
      : 'Aucune commande enregistrée',
    context.location.country ? `Pays : ${context.location.country}` : null
  ].filter(Boolean);
  parts.push(`## Historique\n${history.map((line) => `- ${line}`).join('\n')}`);

  if (account) {
    const lines = [`Statut du compte : ${describeState(account)}`];
    if (account.emailVerified === false) {
      lines.push('Adresse e-mail non vérifiée.');
    }
    lines.push(
      account.marketing.subscribed
        ? 'Inscrit à la newsletter.'
        : 'Non inscrit à la newsletter.'
    );
    parts.push(`## Compte\n${lines.map((line) => `- ${line}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

function describeState(account) {
  if (account.neverActivated) {
    return 'invité — le compte existe mais n’a jamais été activé par le client';
  }
  if (account.disabled) {
    return 'désactivé';
  }
  if (account.canSignIn) {
    return 'actif';
  }
  return 'inconnu';
}

function num(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
