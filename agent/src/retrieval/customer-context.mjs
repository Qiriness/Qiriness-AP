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
export function toPromptText(
  context,
  account = null,
  { includeEmail = false, storefrontUrl = null } = {}
) {
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
    // WHERE TO SEND THEM, AND ONLY WHERE THE STATE MAKES IT USEFUL. A link is
    // the difference between a reply that resolves a login problem and one that
    // starts a second thread — but the wrong link is worse than none, and the
    // right page is a different one for each state.
    const action = accountAction(account, storefrontUrl);
    if (action) {
      lines.push(action);
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

/**
 * The account state, in words the model may repeat.
 *
 * « DÉSACTIVÉ » WAS HERE UNTIL 2026-08-30 AND IT WAS FALSE. Shopify stores
 * `DISABLED` for any customer with no account, which on this shop is 57,140 of
 * 58,201 — `customerAccounts` is `OPTIONAL`, so every guest checkout and every
 * newsletter signup lands there. The word was reaching the model as a fact and
 * being repeated as one: « Le compte client est désactivé » appeared in a stored
 * case file about a customer who had simply never opened an account.
 *
 * It is spelled out at length rather than named, because the failure was a model
 * reading one adjective and drawing a conclusion. There is no adjective for this
 * state that does not invite the wrong one.
 */
/**
 * The page this customer should be sent to, or null when there is not one.
 *
 * A DIFFERENT PAGE PER STATE, WHICH IS THE WHOLE REASON THE STATES EXIST. An
 * active account is sent to the login page, where this shop's theme carries the
 * « mot de passe oublié » form inline — `/account/recover` is a 404 here, so a
 * reply naming it would send somebody to a dead page. No account at all is sent
 * to `/account/register`, because there is nothing to reset.
 *
 * AN INVITED CUSTOMER GETS NO LINK, and that is the useful part. No self-serve
 * page finishes an invitation: a new invite has to be sent from the Shopify
 * admin by a person. Handing them the login page would be the third time they
 * had tried it.
 *
 * NULL WHEN THE STOREFRONT URL IS UNKNOWN. `shops.storefront_url` comes from
 * Shopify's `primaryDomain`, and a shop synced before that field was fetched has
 * none — in which case the reply describes the page in words, as the approved
 * FAQ already does, rather than inventing an address.
 */
function accountAction(account, storefrontUrl) {
  const base = String(storefrontUrl || '').replace(/\/+$/, '');
  if (account.neverActivated) {
    return (
      'Pour finaliser ce compte, une nouvelle invitation doit être envoyée depuis ' +
      'l’administration Shopify : aucune page ne permet au client de le faire lui-même.'
    );
  }
  if (!base) {
    return null;
  }
  if (account.canSignIn) {
    return `Page de connexion (le lien « mot de passe oublié » s’y trouve) : ${base}/account/login`;
  }
  if (account.disabled) {
    return `Page de création de compte : ${base}/account/register`;
  }
  return null;
}

function describeState(account) {
  if (account.neverActivated) {
    return (
      'invité — une invitation a été envoyée mais le compte n’a jamais été activé. ' +
      'Il n’a donc pas de mot de passe, et une réinitialisation de mot de passe ne peut rien donner'
    );
  }
  if (account.canSignIn) {
    return 'compte actif — le client peut se connecter';
  }
  if (account.disabled) {
    return (
      'aucun compte — cette personne est connue de la boutique (achat sans création de compte, ' +
      'ou inscription à la newsletter) mais aucun compte client n’existe pour cette adresse. ' +
      'Ce n’est PAS un compte désactivé : rien n’a été fermé ni suspendu'
    );
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
