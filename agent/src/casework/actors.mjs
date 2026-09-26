// Who acts on a case: the five actors of codex_plans/Case_State_Plan.md.
//
// `support` is us, whichever mailbox a reply left from; `colleague` is someone
// on our side who is not answering the customer; `partner` is an OPERATIONS
// partner we depend on (a 3PL, a carrier), shown as such everywhere a person
// reads it; `nobody` exists only as a next actor.
//
// NOT sender_directory's `partner` label, which is a COMMERCIAL partner (a
// collaboration, a distributor) and maps to `customer` by default: their mail
// is real demand. Same word, two meanings; decided 2026-09-26 to keep the key
// and say « operations partner » on screen.
//
// WHICH SENDER IS WHICH ACTOR IS CONFIGURATION, not code, because it differs
// between businesses: one company's 3PL is part of the team, another's is a
// supplier. `sender_directory` says what a sender IS (its label); the map below
// says what that label COUNTS AS, and a deployment overrides it with
// AGENT_ACTOR_BY_LABEL (config.mjs). An unlisted sender is the customer.

export const ACTORS = ['customer', 'support', 'colleague', 'partner'];
export const NEXT_ACTORS = [...ACTORS, 'nobody'];

/** The map decided for the first deployment (plan Q5), used when none is set. */
export const DEFAULT_ACTOR_BY_LABEL = Object.freeze({
  internal: 'colleague',
  contractor: 'colleague',
  logistics: 'partner',
  courier: 'partner',
  retailer: 'customer'
});

/**
 * `internal:colleague,logistics:partner` → a map over the default. An entry
 * naming an unknown actor is refused rather than guessed at, because a typo
 * here would silently re-file a whole class of sender.
 */
export function parseActorMap(text) {
  const map = { ...DEFAULT_ACTOR_BY_LABEL };
  if (!text || !String(text).trim()) return map;
  for (const part of String(text).split(',')) {
    const [label, actor] = part.split(':').map((value) => value?.trim());
    if (!label || !actor) continue;
    if (!ACTORS.includes(actor)) {
      throw new Error(`AGENT_ACTOR_BY_LABEL: "${actor}" is not an actor (${ACTORS.join(', ')}).`);
    }
    map[label] = actor;
  }
  return map;
}

/**
 * The actor of one stored message. Direction decides first: an `outbound` row
 * is ours by construction, including a staff reply from a personal inbox,
 * which ingestion files as outbound (`isStaffReplyToCustomer`).
 */
export function actorOf(message, directory = null, actorByLabel = DEFAULT_ACTOR_BY_LABEL) {
  if (message?.direction === 'outbound') return 'support';
  const label = directory?.lookup?.(message?.from_email)?.label ?? null;
  if (!label) return 'customer';
  return actorByLabel[label] ?? 'customer';
}
