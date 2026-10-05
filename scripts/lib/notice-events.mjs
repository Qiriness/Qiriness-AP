/**
 * The events a rule may be the template for, when we write to the customer
 * without being asked (`support_answers.notify_on`, 72_refund_notice.sql).
 *
 * Here rather than in the agent so the rule editor (web) and the change router
 * (agent/src/casework/change-router.mjs) read one list. DECISIONS § Refund notice.
 */
export const NOTICE_EVENTS = Object.freeze(['refund_recorded']);
