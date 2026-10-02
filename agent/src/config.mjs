import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../../scripts/lib/sync-config.mjs';
import { parseActorMap } from './casework/actors.mjs';
import { parseCaseStatusMap } from './casework/case-status.mjs';

// Repo root is two levels up from agent/src, so the worker reads the same
// .env.local the sync scripts use regardless of the process working directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadAgentConfig(env = loadEnv(REPO_ROOT)) {
  const required = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SHOPIFY_STORE_DOMAIN'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return {
    supabaseUrl: env.SUPABASE_URL.replace(/\/$/, ''),
    supabaseKey: env.SUPABASE_SECRET_KEY,
    shopDomain: env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    appEnv: env.APP_ENV || 'development',
    graph: {
      tenantId: env.MS_GRAPH_TENANT_ID,
      clientId: env.MS_GRAPH_CLIENT_ID,
      clientSecret: env.MS_GRAPH_CLIENT_SECRET,
      mailbox: env.SUPPORT_MAILBOX
    },
    // Domains that are ours or operational rather than customers. The support
    // mailbox domain is treated as internal automatically; this covers what it
    // cannot imply (a second corporate domain, a logistics provider). Used by
    // the forwarding pass to avoid handing a colleague their own mail back.
    internalEmailDomains: splitCsv(env.INTERNAL_EMAIL_DOMAINS),
    pollIntervalMs: Number(env.INGEST_POLL_INTERVAL_MS) || 60000,
    // Between polls the worker looks this often for a due mail job (a change
    // notification's `sync_mailbox`, an approved reply's `send_outbound`) and
    // polls at once if there is one. The timed poll still runs regardless: it
    // is the reconciliation, the job only shortens the wait.
    jobCheckIntervalMs: Number(env.JOB_CHECK_INTERVAL_MS) || 5000,
    // Attempts before a mail job goes `dead` and is left for a person.
    mailJobMaxAttempts: Number(env.MAIL_JOB_MAX_ATTEMPTS) || 5,
    // THE SEND SWITCH, OFF UNLESS SET TO `true`. With it off the outbound
    // worker claims nothing and approving a draft in the dashboard sends
    // nothing (the dashboard reads the same variable). Needs the Graph
    // `Mail.ReadWrite` permission for reply drafts, and `Mail.Send`.
    outboundSendEnabled: env.OUTBOUND_SEND_ENABLED === 'true',
    // A SECOND LINE FOR TESTING THE SEND PATH. With it `true` the worker does
    // everything up to the send (the checks, the threaded reply draft in the
    // support mailbox's Drafts folder) and stops there. A person can open that
    // draft in Outlook and send it; Sent Items confirms it as usual. Turning
    // it off later does not release drafts already held: they stay for a
    // person, by design.
    outboundStopBeforeSend: env.OUTBOUND_STOP_BEFORE_SEND === 'true',
    // The public HTTPS URL of /api/webhooks/graph. Unset (the default), no
    // change-notification subscription is created and the timed poll does all
    // the work. Set, the worker creates and renews one per folder.
    mailWebhookUrl: env.MAIL_WEBHOOK_URL || '',
    // How long a dropped email's body stays readable in spam_audit before the
    // purge nulls it (04_support.sql). The decision row is kept for ever;
    // only the text expires. Lower this to shorten the review window,
    // never to zero — a body that never lands cannot be reviewed at all.
    spamAuditBodyRetentionDays: Number(env.SPAM_AUDIT_BODY_RETENTION_DAYS) || 90,
    // Draft-only unless explicitly disabled; nothing is auto-sent while true.
    draftOnly: env.DRAFT_ONLY !== 'false',
    // THE SAME SWITCH FOR ONE SUBJECT, AND IT IS SEPARATE ON PURPOSE. Auto-send
    // will graduate for the desk as a whole long before it should for an adverse
    // reaction report: a wrong reply about a promotion code is an annoyance, and
    // a wrong reply to somebody describing a skin reaction is not. Folding this
    // into `DRAFT_ONLY` would mean the day the desk graduates is the day
    // cosmetovigilance does.
    //
    // Both default to true and both must be false before a reaction ticket can
    // send itself — a conjunction, so clearing the global one alone changes
    // nothing here. A second subject wanting this should turn the pair into a
    // list rather than add a third boolean.
    draftOnlyCosmetovigilance: env.DRAFT_ONLY_COSMETOVIGILANCE !== 'false',
    // DRAFTING IN THE POLL (stage 6), OFF UNLESS SET TO `true`. When on, the
    // worker drafts after the fold, only where it is our turn to reply to a
    // customer message received since the mailbox cutover (`pollGate`). Run
    // `npm run draft -- --dry-run --gates=poll` first: it says how many drafts
    // and what they would cost, with no model call. Nothing is ever sent.
    draftInPoll: env.DRAFT_IN_POLL === 'true',
    // At most this many drafts a poll, so a gate that turns out wrong costs a
    // handful of calls rather than hundreds.
    draftPollLimit: Number(env.DRAFT_POLL_LIMIT) || 10,
    // RULE-DIRECTED COLLECTION, GLOBALLY. The per-situation `collection_mode`
    // column is the normal control; this is the one a person reaches for at
    // 2am without a deploy. Defaults ON because the column defaults to
    // `model` — with no situation opted in, "on" changes nothing.
    plannerEnabled: env.RULE_DIRECTED_COLLECTION !== 'false',
    // OpenAI (LLM stages). The spam second pass is enabled only when a key is set;
    // without it, ingestion still runs and just skips the LLM filter.
    openaiApiKey: env.OPENAI_API_KEY,
    triageModel: env.AGENT_TRIAGE_MODEL || 'gpt-4o-mini',
    // Categoriser: same cheap tier as triage — it picks 1-of-14 plus 1-of-4 with
    // the enums constrained by Structured Outputs, not free reasoning.
    categoriserModel: env.AGENT_CATEGORISER_MODEL || 'gpt-4o-mini',
    // Forwarding router: picks one of a few destinations from their descriptions,
    // or keeps the ticket. Constrained 1-of-n, the cheap tier.
    routerModel: env.AGENT_ROUTER_MODEL || 'gpt-4o-mini',
    // Settles a situation the matcher scored as a near miss or a tie, by reading
    // the message beside the candidates — a constrained 1-of-3-or-none, the cheap
    // tier's job. Set to an empty string to turn it off: near misses then keep no
    // situation, which is what they did before it existed.
    // The Case Linker: picks one of a few candidate cases, or none, for a thread
    // the deterministic rules could not place. A constrained 1-of-n, the cheap
    // tier. OFF unless CASE_LINKER_ENABLED=true: until it is on, an ambiguous
    // thread opens a new case and its candidates are logged (DECISIONS § Cases).
    caseLinkerModel: env.AGENT_CASE_LINK_MODEL || 'gpt-4o-mini',
    caseLinkerEnabled: env.CASE_LINKER_ENABLED === 'true',
    situationChooserModel:
      env.AGENT_SITUATION_CHOOSER_MODEL === undefined ? 'gpt-4o-mini' : env.AGENT_SITUATION_CHOOSER_MODEL,
    // Investigation is the first stage that CHOOSES what to do, so it is the
    // first that needs reliable tool calling rather than a single constrained
    // answer — a mid tier, per the plan's model tiers. The budget below is what
    // keeps that affordable: most tickets resolve in one turn because the
    // deterministic evidence is fetched before the model is asked anything.
    investigatorModel: env.AGENT_INVESTIGATOR_MODEL || 'gpt-4o',
    investigationMaxToolCalls: Number(env.AGENT_INVESTIGATION_MAX_TOOL_CALLS) || 6,
    investigationMaxTurns: Number(env.AGENT_INVESTIGATION_MAX_TURNS) || 4,
    // Splitting an email into its separate requests is the cheap tier's kind of
    // job — a constrained extraction with the subjects and kinds fixed by the
    // schema, not reasoning about what to do next. Set to an empty string to
    // turn decomposition off: the investigation then treats every ticket as one
    // request, which is what it did before this existed.
    decomposerModel:
      env.AGENT_DECOMPOSER_MODEL === undefined ? 'gpt-4o-mini' : env.AGENT_DECOMPOSER_MODEL,
    // Drafting is the only stage whose output a customer reads, and the only
    // one producing prose rather than a constrained choice. The cheap tier is
    // sized for picking 1-of-14, not for writing French a person will judge the
    // brand by — and it is one call per ticket, so the difference is affordable.
    draftingModel: env.AGENT_DRAFTING_MODEL || 'gpt-4o',
    // Reading a finished thread and saying where the case stands. The mid tier,
    // for the same reason the investigation is: it is the whole conversation in
    // one pass, with what was asked, what was promised and what is still open to
    // be told apart — not a constrained 1-of-N. One call per thread, and only on
    // threads that ran to more than one customer message, so it is affordable.
    reconstructionModel: env.AGENT_RECONSTRUCTION_MODEL || 'gpt-4o',
    // Reads what a new message changed about a case already open: a closed
    // relationship, which of OUR questions it answered, what it added. A
    // constrained extraction over one message and its thread — the cheap tier's
    // job, and it runs only on tickets that already have a case file. Set to an
    // empty string to turn the pass off: every message is then categorised and
    // investigated exactly as it was before this layer existed.
    caseworkModel:
      env.AGENT_CASEWORK_MODEL === undefined ? 'gpt-4o-mini' : env.AGENT_CASEWORK_MODEL,
    // « Ce message clôt-il la demande ? » — one constrained boolean over one
    // short message, which is the cheap tier's job. It only runs where the case
    // file already says nothing is outstanding, so it is a minority of tickets.
    // Set to an empty string to turn it off: every reply is then written the way
    // it was before closures were detected at all.
    closureModel:
      env.AGENT_CLOSURE_MODEL === undefined ? 'gpt-4o-mini' : env.AGENT_CLOSURE_MODEL,
    // Which sender_directory label counts as which actor on a case, e.g.
    // `internal:colleague,logistics:partner`. Per business: one company's 3PL is
    // part of the team, another's a supplier. Unset keeps the default map in
    // casework/actors.mjs; a label left out keeps its default.
    actorByLabel: parseActorMap(env.AGENT_ACTOR_BY_LABEL),
    // THE TICKET STATUS FROM WHO ACTS NEXT (stage 5c). `off` leaves statuses to
    // the investigation's verdict as before; `nobody:open` keeps finished cases
    // in the queue for a person to close. Unset keeps the default map in
    // casework/case-status.mjs.
    caseStatusByNextActor: parseCaseStatusMap(env.AGENT_CASE_STATUS_BY_NEXT_ACTOR),
    // SNOOZE, OFF UNLESS SET TO `true`. When on, the fold snoozes a case our
    // SENT reply left waiting on the customer, a colleague or an operations
    // partner, until the shop's delay for that party; and wakes a snoozed case
    // that comes back to us (casework/snooze-rule.mjs). Waking on new mail and
    // on the deadline runs whatever this says: a snooze a person set must end.
    autoSnooze: env.AGENT_AUTO_SNOOZE === 'true',
    // WHERE A DRAFT GOES TO BE READ, and `none` is the default so a fresh
    // checkout cannot email anything at all. `review-mail` sends a copy to
    // DRAFT_REVIEW_MAILBOX — the reviewer's own inbox, never a customer, and
    // deliberately not the support mailbox: a reply to a review copy must not
    // land somewhere the delta poller would ingest it as a new ticket.
    draftDelivery: env.DRAFT_DELIVERY || 'none',
    draftReviewMailbox: env.DRAFT_REVIEW_MAILBOX || '',
    // THE MONTHLY SALES REPORT, mailed from the support mailbox on the 1st
    // (reports/sales-report-mail.mjs). Off unless both the URL and the secret
    // are set: the URL is the dashboard's /api/reports/sales on its public
    // host, and the secret is the same SALES_REPORT_SECRET the dashboard has.
    // The recipients are every active dashboard account with one of `roles`,
    // plus `extraRecipients` — so a new manager is added with `npm run users`,
    // not a deploy.
    salesReport: {
      url: env.SALES_REPORT_URL || '',
      secret: env.SALES_REPORT_SECRET || '',
      roles: splitCsv(env.SALES_REPORT_ROLES || 'management'),
      extraRecipients: splitCsv(env.SALES_REPORT_EXTRA_RECIPIENTS),
      // Shop-clock hour on the 1st from which it may go. After the nightly
      // Shopify sync (02:00 UTC, about 70 minutes), so the month's last day
      // is in the orders table the product figures are read from.
      sendHour: Number(env.SALES_REPORT_SEND_HOUR) || 8
    },
    // Must match what the knowledge chunks were embedded with, or cosine
    // comparison between a message and a chunk is meaningless.
    embeddingModel: env.EMBEDDING_MODEL || 'text-embedding-3-small',
    embeddingDimensions: Number(env.EMBEDDING_DIMENSIONS) || 1536
  };
}

// Graph credentials are validated separately so the config can be built (and the
// worker started) before they are wired, with a clear error only when ingestion
// actually needs them.
export function assertGraphConfig(config) {
  const { tenantId, clientId, clientSecret, mailbox } = config.graph;
  const missing = Object.entries({
    MS_GRAPH_TENANT_ID: tenantId,
    MS_GRAPH_CLIENT_ID: clientId,
    MS_GRAPH_CLIENT_SECRET: clientSecret,
    SUPPORT_MAILBOX: mailbox
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `Microsoft Graph is not configured. Add to .env.local: ${missing.join(', ')}`
    );
  }
}

function splitCsv(value) {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
