import { supabaseInsert, supabaseSelect, supabaseUpdate } from '../../../scripts/lib/supabase-rest-client.mjs';
import { finishIntegrationEvent, sanitizeError } from '../../../scripts/lib/compliance-audit.mjs';
import { dashboardRoleOf, isBanned, normaliseEmail } from '../../../scripts/lib/dashboard-auth.mjs';
import { lastCompleteMonth } from '../../../scripts/lib/insights-range.mjs';
import { reportFileName } from '../../../scripts/lib/sales-report.mjs';

/**
 * THE MONTHLY SALES REPORT, MAILED ON THE 1ST.
 *
 * On the calendar month, not every 30 days: the report covers the month that
 * has just ended on the shop's clock (`lastCompleteMonth`, the same default as
 * the dashboard's download), so it goes on the 1st, from `sendHour`.
 *
 * THE WORKER SENDS, THE DASHBOARD BUILDS. The report is built by the web app's
 * report-service.ts (TypeScript, live ShopifyQL reads), so the worker fetches
 * the finished HTML from /api/reports/sales with a shared secret rather than
 * keeping a second copy of the builder. Mailed from the support mailbox as an
 * attachment, to every active dashboard account with a report role, plus the
 * configured extra addresses.
 *
 * ONCE PER MONTH, RECORDED IN `integration_events` under one event key per shop
 * and month; the unique key is the claim, so two workers (Render and a local
 * `ingest:once`) cannot both send. A failure is retried every RETRY_MINUTES,
 * at most MAX_ATTEMPTS times. A worker that was down on the 1st catches up
 * within CATCH_UP_DAYS; after that the month is left, rather than a report on
 * the 20th that reads as current.
 */

export const SALES_REPORT_EVENT_TYPE = 'sales_report_mail';
export const MAX_ATTEMPTS = 5;
export const RETRY_MINUTES = 30;
export const CATCH_UP_DAYS = 7;

/** Day of month and hour on the shop's clock. */
function shopClock(now, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(now)
      .map((part) => [part.type, Number(part.value)])
  );
  return { day: parts.day, hour: parts.hour };
}

/** The month whose report is due now (YYYY-MM), or null outside the send window. */
export function dueReportMonth({ now = new Date(), tz = 'UTC', sendHour = 8 } = {}) {
  const { day, hour } = shopClock(now, tz);
  if (day > CATCH_UP_DAYS) return null;
  if (day === 1 && hour < sendHour) return null;
  return lastCompleteMonth({ tz, now });
}

export function reportEventKey(shopId, month) {
  return `${SALES_REPORT_EVENT_TYPE}:${shopId}:${month}`;
}

// Asked for by the owner. The report's switches need no script since
// 2026-09-29, so a preview works too; a browser still gives the full width.
const READING_NOTE =
  'P.S. : pour consulter le rapport, téléchargez la pièce jointe puis ouvrez-la avec un navigateur (Chrome, Safari, Edge…).';

/** « septembre 2026 » for 2026-09. */
function frenchMonth(month) {
  const [year, index] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, index - 1, 1))
  );
}

/**
 * The subject and body, in French: the management team reads French. Short
 * on purpose: the report is the attachment.
 */
export function reportMail({ month, brand }) {
  const label = frenchMonth(month);
  const capitalised = label.charAt(0).toUpperCase() + label.slice(1);
  return {
    subject: `Rapport des ventes E-commerce ${brand} - ${capitalised}`,
    text: `Bonjour,\n\nVeuillez trouver ci-joint le rapport des ventes e-commerce de ${label}.\n\nBien cordialement,\nAgent Contact ${brand}\n\n${READING_NOTE}`
  };
}

/** Active dashboard accounts holding one of `roles`, plus `extra`; lower-cased, no repeats. */
export function reportRecipients(users, { roles, extra = [] }) {
  const fromAccounts = users
    .filter((user) => roles.includes(dashboardRoleOf(user)) && !isBanned(user))
    .map((user) => user.email);
  return [...new Set([...fromAccounts, ...extra].map(normaliseEmail).filter(Boolean))].sort();
}

/**
 * What to do with the month's event row: 'insert' when there is none, 'retry'
 * for a failure that is due another go, null when it is sent, in flight, or
 * out of attempts.
 */
export function nextStep(row, now = new Date()) {
  if (!row) return 'insert';
  if (row.status !== 'failed') return null;
  if ((Number(row.counts?.attempts) || 1) >= MAX_ATTEMPTS) return null;
  const last = Date.parse(row.finished_at || row.updated_at || 0);
  return now.getTime() - last >= RETRY_MINUTES * 60_000 ? 'retry' : null;
}

/** Take the month. Null when another worker got there first. */
async function claim(supabase, { shopId, key, month, step, row, now }) {
  const started = now.toISOString();
  if (step === 'insert') {
    try {
      const [inserted] = await supabaseInsert(supabase, 'integration_events', [
        {
          shop_id: shopId,
          event_key: key,
          source: 'agent',
          event_type: SALES_REPORT_EVENT_TYPE,
          status: 'processing',
          started_at: started,
          counts: { attempts: 1 },
          metadata: { month }
        }
      ]);
      return inserted;
    } catch (error) {
      if (/duplicate key|unique/i.test(error.message)) return null;
      throw error;
    }
  }
  // A retry wins only if the row is still the failed one it read.
  const attempts = (Number(row.counts?.attempts) || 1) + 1;
  const [updated] = await supabaseUpdate(
    supabase,
    'integration_events',
    { id: row.id, status: 'failed', updated_at: row.updated_at },
    { status: 'processing', started_at: started, finished_at: null, error_summary: null, counts: { attempts } }
  );
  return updated ?? null;
}

export async function runSalesReportMail({
  supabase,
  graphClient,
  adminClient,
  shopId,
  config,
  logger,
  now = new Date(),
  fetchImpl = fetch
}) {
  if (!config.url || !config.secret) return { skipped: 'not_configured' };

  const [shop] = await supabaseSelect(supabase, 'shops', { id: shopId }, 'shop_name,iana_timezone');
  const month = dueReportMonth({ now, tz: shop?.iana_timezone || 'UTC', sendHour: config.sendHour });
  if (!month) return { skipped: 'not_due' };

  const key = reportEventKey(shopId, month);
  const [row] = await supabaseSelect(supabase, 'integration_events', { event_key: key }, '*');
  const step = nextStep(row, now);
  if (!step) return { skipped: 'handled', month };

  const event = await claim(supabase, { shopId, key, month, step, row, now });
  if (!event) return { skipped: 'claimed_elsewhere', month };
  const attempts = Number(event.counts?.attempts) || 1;

  try {
    const recipients = reportRecipients(await adminClient.listUsers(), {
      roles: config.roles,
      extra: config.extraRecipients
    });
    if (recipients.length === 0) throw new Error(`No recipients: no active account with role ${config.roles.join('/')}.`);

    const { html } = await sendSalesReport({
      graphClient,
      config,
      month,
      brand: shop?.shop_name || 'Shop',
      recipients,
      fetchImpl
    });

    await finishIntegrationEvent(supabase, event.id, {
      status: 'completed',
      finished_at: now.toISOString(),
      counts: { attempts, recipients: recipients.length, bytes: Buffer.byteLength(html) }
    });
    logger.info('sales_report.sent', { shopId, month, recipients: recipients.length, attempts });
    return { sent: true, month, recipients: recipients.length };
  } catch (error) {
    // A failure before Graph accepted the mail is the common case; one after
    // (a lost response) can send the report twice, which is the better of the
    // two mistakes for a report nobody replies to.
    await finishIntegrationEvent(supabase, event.id, {
      status: 'failed',
      finished_at: now.toISOString(),
      counts: { attempts },
      error_summary: sanitizeError(error)
    }).catch(() => {});
    logger.error('sales_report.failed', { shopId, month, attempts, error: sanitizeError(error) });
    return { sent: false, month, error: error.message };
  }
}

/**
 * Fetch one month's report from the dashboard and mail it. No schedule and no
 * record: the scheduled run above wraps it in both, and the test command
 * (tools/run-sales-report.mjs) calls it bare.
 */
export async function sendSalesReport({ graphClient, config, month, brand, recipients, fetchImpl = fetch }) {
  const url = new URL(config.url);
  url.searchParams.set('month', month);
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.secret}` } });
  if (!response.ok) throw new Error(`The dashboard refused the report: HTTP ${response.status}.`);
  const html = await response.text();

  const mail = reportMail({ month, brand });
  await graphClient.sendMail({
    ...mail,
    toRecipients: recipients,
    attachments: [{ name: reportFileName(month), contentType: 'text/html', content: html }]
  });
  return { html, subject: mail.subject };
}
