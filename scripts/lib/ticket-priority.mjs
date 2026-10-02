/**
 * Deterministic, read-time queue priority.
 *
 * The BAND is a business decision made from the current situation and action
 * window. Age, contact count and workflow status only order tickets WITHIN that
 * band; they can never turn a routine enquiry into an urgent intervention.
 * Nothing is stored and no model is called, so identical inputs at the same
 * evaluation time always produce the same result.
 *
 * Visible labels remain High / Medium / Low:
 *   high   = an urgent intervention window can still close
 *   medium = an unresolved service failure or overdue commitment
 *   low    = routine help without either condition
 */

const BAND_BASE = Object.freeze({ low: 0, medium: 100, high: 200 });

/** Address, cancellation and order-content changes: urgency is conditional. */
export const ACTION_WINDOW_SITUATIONS = new Set(['O-12', 'O-13', 'O-14']);

/** Failures that are already established by the situation, not by order age. */
export const SERVICE_FAILURE_SITUATIONS = new Set([
  'D-02', // received parcel is missing an item
  'D-03', // marked delivered, disputed by customer
  'D-05', // tracking has stopped
  'D-06', // parcel returned; remedy requested
  'D-08', // wrong product received
  'D-36', // late delivery with remedy requested
  'D-37', // carrier-confirmed lost parcel
  'P-20'  // promised/included samples missing from received parcel
]);

/** These become failures only after the applicable live UI threshold. */
export const DISPATCH_DELAY_SITUATIONS = new Set(['O-09', 'O-11']);
export const DELIVERY_DELAY_SITUATIONS = new Set(['D-01']);

const WAIT_MAX_POINTS = 35;
const WAIT_SATURATES_AFTER_DAYS = 14;
const CONTACT_POINTS = { 2: 7, 3: 11 };
const CONTACT_MAX_POINTS = 14;
const AWAITING_HUMAN_POINTS = 6;
const LEVEL_POINTS = { 1: 0, 2: 4, 3: 8, 4: 99 };
const UNCATEGORISED_POINTS = LEVEL_POINTS[2];
const EXCESS_DELAY_MAX_POINTS = 20;

export const PRIORITY_BANDS = Object.freeze({ high: BAND_BASE.high, medium: BAND_BASE.medium });
export const PRIORITY_WEIGHTS = Object.freeze({
  bandBase: BAND_BASE,
  level: LEVEL_POINTS,
  uncategorised: UNCATEGORISED_POINTS,
  waitMax: WAIT_MAX_POINTS,
  waitSaturatesAfterDays: WAIT_SATURATES_AFTER_DAYS,
  contact: CONTACT_POINTS,
  contactMax: CONTACT_MAX_POINTS,
  awaitingHuman: AWAITING_HUMAN_POINTS,
  excessDelayMax: EXCESS_DELAY_MAX_POINTS,
  bands: PRIORITY_BANDS
});

const AWAITING_HUMAN = 'awaiting_human';

export function levelPoints(level) {
  if (level === null || level === undefined) return UNCATEGORISED_POINTS;
  return LEVEL_POINTS[Number(level)] ?? UNCATEGORISED_POINTS;
}

export function waitDays(waitingSince, now = new Date()) {
  if (!waitingSince) return 0;
  const since = waitingSince instanceof Date ? waitingSince.getTime() : Date.parse(waitingSince);
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, (now.getTime() - since) / 86_400_000);
}

export function waitPoints(waitingSince, now = new Date()) {
  const elapsed = waitDays(waitingSince, now);
  if (elapsed <= 0) return 0;
  const curve = Math.log1p(elapsed) / Math.log1p(WAIT_SATURATES_AFTER_DAYS);
  return WAIT_MAX_POINTS * Math.min(1, curve);
}

export function contactPoints(inboundCount) {
  const count = Number.isFinite(inboundCount) ? Math.floor(inboundCount) : 0;
  if (count >= 4) return CONTACT_MAX_POINTS;
  return CONTACT_POINTS[count] ?? 0;
}

export function excessDelayPoints(ticket) {
  const excess = Math.max(
    0,
    Number(ticket.dispatchExcessWorkingDays ?? 0),
    Number(ticket.deliveryExcessWorkingDays ?? 0)
  );
  return Number.isFinite(excess) ? Math.min(EXCESS_DELAY_MAX_POINTS, excess * 2) : 0;
}

function currentActionWindow(ticket) {
  const explicit = ticket.actionKind && ticket.actionKind !== 'none';
  return explicit || ACTION_WINDOW_SITUATIONS.has(ticket.situationKey);
}

function actionIsComplete(ticket) {
  if (ticket.actionCompleted || ticket.caseResolved) return true;
  return ticket.situationKey === 'O-13' && ticket.orderState === 'cancelled';
}

function hasImminentDeadline(ticket) {
  if (!ticket.deadlineImminent) return false;
  return Boolean(
    ticket.parcelCollectionDeadline ||
      ticket.returnInstructionsBlocked ||
      ticket.actionKind === 'duplicate_order_cancellation' ||
      ticket.actionKind === 'item_or_gift_correction'
  );
}

/**
 * The branch decision, separate from the numeric ordering inside it.
 *
 * `not_dispatched` means only that no fulfilment is recorded. It does NOT claim
 * Deret can still change the order; the reason deliberately says to check.
 * Missing fulfilment state keeps a known change request provisionally High.
 */
/**
 * Who ships, by name, for the reasons below. The `logistics_provider_name`
 * parameter, carried on the facts; « Deret » was a literal here.
 */
function logisticsProvider(ticket) {
  const name = String(ticket?.logisticsProvider ?? '').trim();
  return name || 'the logistics provider';
}

export function determinePriorityBand(ticket) {
  if (Number(ticket.level) === 4) {
    return { band: 'high', reason: 'Level 4 safety or legal escalation.' };
  }
  // A PERSON PINNED THE BAND (« Edit case »). Only the band: the ticket still
  // climbs inside it as it waits, so a pinned ticket is not frozen. Level 4
  // stays high above, whatever was pinned: safety is not a queue preference.
  if (Object.hasOwn(BAND_BASE, ticket.pinnedBand ?? '')) {
    return { band: ticket.pinnedBand, reason: 'Set by a person.' };
  }

  const completed = actionIsComplete(ticket);
  if (!completed && hasImminentDeadline(ticket)) {
    return { band: 'high', reason: 'A known response deadline is imminent and our action is still required.' };
  }
  if (!completed && ticket.logisticsAwaitingInstructions) {
    return { band: 'high', reason: 'Logistics is waiting for instructions before return-to-sender.' };
  }

  if (!completed && currentActionWindow(ticket)) {
    if (ticket.orderState === 'not_dispatched') {
      return {
        band: 'high',
        reason: `Pre-fulfilment change requested; check immediately whether ${logisticsProvider(ticket)} can still intervene.`
      };
    }
    if (!ticket.orderState || ticket.orderState === 'unknown') {
      return { band: 'high', reason: 'Change request with unknown fulfilment state; identify and check the order promptly.' };
    }
    // dispatched / delivered / cancelled: the original intervention window no
    // longer supplies urgency. Any remaining failure is assessed below.
  }

  if (ticket.serviceFailure || SERVICE_FAILURE_SITUATIONS.has(ticket.situationKey)) {
    return { band: 'medium', reason: 'Unresolved service failure or remedy remains.' };
  }
  if (
    DISPATCH_DELAY_SITUATIONS.has(ticket.situationKey) &&
    Number(ticket.dispatchExcessWorkingDays) > 0
  ) {
    return { band: 'medium', reason: 'Dispatch is beyond the configured working-day threshold.' };
  }
  if (
    DISPATCH_DELAY_SITUATIONS.has(ticket.situationKey) &&
    (ticket.dispatchExcessWorkingDays === null || ticket.dispatchExcessWorkingDays === undefined)
  ) {
    return { band: 'medium', reason: 'Dispatch timing is unresolved; missing order data must not lower the case.' };
  }
  if (
    DELIVERY_DELAY_SITUATIONS.has(ticket.situationKey) &&
    Number(ticket.deliveryExcessWorkingDays) > 0
  ) {
    return {
      band: 'medium',
      reason:
        'Relevant non-receipt case is beyond the configured delivery proxy threshold; ' +
        `${logisticsProvider(ticket)} verification remains required.`
    };
  }
  if (
    DELIVERY_DELAY_SITUATIONS.has(ticket.situationKey) &&
    (ticket.deliveryExcessWorkingDays === null || ticket.deliveryExcessWorkingDays === undefined)
  ) {
    return { band: 'medium', reason: 'Non-receipt timing is unresolved; identify the order and preserve the potential failure priority.' };
  }
  if (ticket.overdueCommitment) {
    return { band: 'medium', reason: 'A confirmed commitment is overdue.' };
  }
  if (!ticket.situationKey && !ticket.caseResolved) {
    return { band: 'medium', reason: 'Situation is not yet established; keep it visible until triaged.' };
  }
  return {
    band: 'low',
    reason: completed
      ? 'Requested action is complete; no other urgent condition remains.'
      : 'Routine assistance without a current action deadline or service failure.'
  };
}

function withinBandParts(ticket, now) {
  return [
    { factor: 'level', points: levelPoints(ticket.level) },
    { factor: 'wait', points: Math.round(waitPoints(ticket.waitingSince, now) * 10) / 10 },
    { factor: 'contacts', points: contactPoints(ticket.inboundCount) },
    { factor: 'awaiting_human', points: ticket.status === AWAITING_HUMAN ? AWAITING_HUMAN_POINTS : 0 },
    { factor: 'excess_delay', points: excessDelayPoints(ticket) }
  ];
}

export function scorePriority(ticket, now = new Date()) {
  const { band } = determinePriorityBand(ticket);
  const withinBand = withinBandParts(ticket, now).reduce((sum, part) => sum + part.points, 0);
  // The ordinary maximum is 83. Keep the clamp as an invariant if weights are
  // later tuned: no within-band factor may manufacture a higher band.
  const score = BAND_BASE[band] + Math.min(99, withinBand);
  return Math.round(score * 10) / 10;
}

export function explainPriority(ticket, now = new Date()) {
  const decision = determinePriorityBand(ticket);
  return {
    score: scorePriority(ticket, now),
    band: decision.band,
    reason: decision.reason,
    parts: [{ factor: 'band', points: BAND_BASE[decision.band] }, ...withinBandParts(ticket, now)]
  };
}

export function priorityBand(score) {
  if (score >= PRIORITY_BANDS.high) return 'high';
  if (score >= PRIORITY_BANDS.medium) return 'medium';
  return 'low';
}

export function byPriorityDesc(now = new Date()) {
  return (a, b) => {
    const difference = scorePriority(b, now) - scorePriority(a, now);
    if (difference !== 0) return difference;
    return waitDays(b.waitingSince, now) - waitDays(a.waitingSince, now);
  };
}
