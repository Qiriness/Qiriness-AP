import { ROLES, dashboardRoleOf, isBanned, isPlausibleEmail, normaliseEmail } from './dashboard-auth.mjs';
import { supabaseSelect, supabaseUpdate } from './supabase-rest-client.mjs';
import { T } from './tables.mjs';

/**
 * WHO EACH SHOP'S AUTOMATIC MAIL COMES FROM AND GOES TO, set on Settings →
 * Integrations for the shop on screen and read by the worker at send time.
 * One pair per kind, held on the `shops` row (migrations 02 and 03):
 *   - `sales_report`: the monthly sales report (agent/src/reports/sales-report-mail.mjs);
 *   - `stock_alert`: the stock alert (agent/src/reports/stock-alert-mail.mjs).
 * No sender, or nobody to send to: that shop's mail of that kind is not sent.
 * docs/decisions/insights.md § The report is mailed on the 1st…, § The stock alert.
 *
 * A RECIPIENT IS A ROLE OR AN ADDRESS. `{ role }` is every active dashboard
 * account holding that role when the mail goes, so a new manager receives it
 * without anyone editing a list and a disabled account stops; `{ email }` is
 * anyone, account or not (owner, 2026-10-27).
 */

export const MAIL_KINDS = Object.freeze({
  sales_report: { sender: 'report_sender', recipients: 'report_recipients' },
  stock_alert: { sender: 'stock_alert_sender', recipients: 'stock_alert_recipients' }
});

/** A list longer than this is a mistake, not a mailing list. */
export const MAX_RECIPIENTS = 50;

export function isMailKind(kind) {
  return Object.hasOwn(MAIL_KINDS, kind);
}

/** `{ ok, value }` with the address trimmed and lower-cased (empty clears it), or `{ ok: false, error }`. */
export function validateSender(input) {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false, error: 'The sender must be an email address.' };
  const value = normaliseEmail(input);
  if (value === '') return { ok: true, value: null };
  if (value.length > 254 || !isPlausibleEmail(value)) return { ok: false, error: `"${input.trim()}" is not an email address.` };
  return { ok: true, value };
}

/** `{ ok, value: [{role} | {email}] }`, roles first, no repeats; or `{ ok: false, error }`. */
export function validateRecipients(input) {
  if (input === null || input === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'Recipients must be a list.' };
  const roles = new Set();
  const emails = new Set();
  for (const entry of input) {
    if (entry && typeof entry.role === 'string') {
      if (!ROLES.includes(entry.role)) return { ok: false, error: `"${entry.role}" is not a dashboard role.` };
      roles.add(entry.role);
    } else if (entry && typeof entry.email === 'string') {
      const email = normaliseEmail(entry.email);
      if (!isPlausibleEmail(email)) return { ok: false, error: `"${entry.email.trim()}" is not an email address.` };
      emails.add(email);
    } else {
      return { ok: false, error: 'Each recipient is a role or an email address.' };
    }
  }
  if (roles.size + emails.size > MAX_RECIPIENTS) return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients.` };
  return {
    ok: true,
    value: [...ROLES.filter((role) => roles.has(role)).map((role) => ({ role })), ...[...emails].sort().map((email) => ({ email }))]
  };
}

/**
 * The addresses a recipient list stands for now: each role's active accounts,
 * plus the addresses; lower-cased, no repeats, sorted. `users`: Supabase Auth users.
 */
export function resolveRecipients(entries, users) {
  const roles = new Set((entries ?? []).filter((e) => e?.role).map((e) => e.role));
  const fromRoles = users.filter((user) => roles.has(dashboardRoleOf(user)) && !isBanned(user)).map((user) => user.email);
  const direct = (entries ?? []).filter((e) => e?.email).map((e) => e.email);
  return [...new Set([...fromRoles, ...direct].map(normaliseEmail).filter(Boolean))].sort();
}

/** `{ sales_report: { sender, recipients }, stock_alert: { … } }` for one shop. */
export async function readMailSettings(supabase, shopId) {
  const columns = Object.values(MAIL_KINDS).flatMap((kind) => [kind.sender, kind.recipients]);
  const [row] = await supabaseSelect(supabase, T.SHOPS, { id: shopId }, columns.join(','), { limit: 1 });
  return Object.fromEntries(
    Object.entries(MAIL_KINDS).map(([kind, cols]) => [kind, { sender: row?.[cols.sender] ?? null, recipients: row?.[cols.recipients] ?? [] }])
  );
}

/** Saves one kind's sender and recipients, both validated. Returns what is stored. */
export async function saveMailSetting(supabase, shopId, kind, { sender, recipients }) {
  if (!isMailKind(kind)) return { ok: false, error: `Unknown mail "${kind}".` };
  const from = validateSender(sender);
  if (!from.ok) return from;
  const to = validateRecipients(recipients);
  if (!to.ok) return to;
  const cols = MAIL_KINDS[kind];
  const rows = await supabaseUpdate(supabase, T.SHOPS, { id: shopId }, { [cols.sender]: from.value, [cols.recipients]: to.value }, { select: 'id' });
  if (!rows?.length) return { ok: false, error: 'No such shop.' };
  return { ok: true, value: { sender: from.value, recipients: to.value } };
}
