<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Sending

### One component sends a reply, and it checks again right before it does (2026-09-28)

The model never sends. It writes `ticket_drafts`, which holds no recipient. A reply leaves only as an `outbound_actions` row, carried out by `agent/src/outbound/outbound-runner.mjs`, the only caller of the provider's `createReplyDraft` and `sendDraft`. Forwarding to a colleague (§ Forwarding) is the one other path that sends mail, and it never addresses a customer.

**Two ways in.** A person approves or edits a draft in `/tickets` (`human_approved`), or, only with `DRAFT_ONLY=false`, the level gate's `auto_send_eligible` on a pending draft (`auto_send`). Both are behind `OUTBOUND_SEND_ENABLED`, off by default; the dashboard and the worker read the same variable, and the buttons say « Approve & send » when it is on.

**The pre-send check runs at send time, not at approval.** An approval can sit for hours. `preSendCheck` refuses when:

| Reason | When |
|---|---|
| `draft_withdrawn` | the draft is no longer approved/edited (rejected, stale under a fold, already sent); for an auto-send, no longer pending |
| `auto_send_off` | an auto-send while `DRAFT_ONLY` is on, or the draft is not eligible |
| `case_moved` | `case_current.version` is not the version the text was written against |
| `customer_wrote_again` | an inbound customer message after the one being answered (a colleague's does not count; the version check covers material changes) |
| `already_answered` | an outbound message after it (a reply from Outlook or a personal inbox), or another action of ours in `send_requested` / `sent_confirmed` |

The facts come from the database the same poll has just brought up to date, because the send stage runs after ingestion and the fold.

**Only a send for the same case version or a newer one counts as `already_answered` (fixed 2026-09-28).** The first version counted any earlier sent action on the ticket, so the second reply on a test thread was cancelled: the reply we sent for version 2 blocked answering version 6, although the customer's new message after it is exactly why version 6 exists.

**A sync-only worker can still send.** `--stop-after=ingest --also=send` runs the send stage without any model stage. The pre-send check needs nothing the skipped stages produce, and refuses when the case version or the thread has moved. `--also` accepts only `send`, so a sync-only deployment cannot be made to spend on models by a flag.

**One reply per case version.** A unique index on `(shop_id, ticket_id, case_version, action_type)` over rows not cancelled or failed. A double click, a retried request or two dashboards produce one action. A cancelled or failed one steps aside, so a person can edit and approve again. A new decision on a draft whose action has not reached `send_requested` cancels it (`draft_withdrawn`) before recording; once it has, the dashboard refuses the decision.

**Requested is not confirmed.** `send_requested` is written before the send call, so a crash between the two leaves « maybe sent », never « not sent ». Any action in `draft_created` or `send_requested` is only touched after asking the mailbox where its draft is (`findSentMessage`): `sent` → leave it for confirmation, `draft` → check again, then send, `missing` → failed for a person. **Confirmation comes from ingestion:** with immutable ids the draft keeps its id when it moves to Sent Items, so the stored `graph_message_id` equals `provider_draft_id` (Internet-Message-Id is the fallback). The confirm step runs straight after the mailbox read and before the fold, which would otherwise mark our own draft `superseded_by_outbound`.

**The recipient is the answered message's `from_email`, read at send time.** Nothing stores an address. For a contact-form ticket that is the address from the form, not Shopify's notification sender. The mapper already swapped it (§ Identity), and the reply sets the To line explicitly rather than trusting Graph's reply-to-sender.

**Retries.** Every attempt is a `mail_jobs` row: backoff 30 s doubling to an hour with ±20 % jitter, dead after `MAIL_JOB_MAX_ATTEMPTS` (5), at which point the action is `failed`. A reply draft created but not recorded (the database failed in between) is left unsent in Drafts, and the retry makes a new one. It is a stray draft, never a second email.

**A second switch stops it one step short (2026-09-28).** `OUTBOUND_STOP_BEFORE_SEND=true` runs every check and creates the threaded reply draft, then leaves the action at `draft_created`; `sendDraft` is never called. Asked for as a further line of defence while the path is tested: what the worker would send can be read in Outlook, exactly as the customer would get it, and sent by hand. A draft sent that way is confirmed from Sent Items like any other, because confirmation accepts `draft_created`. Turning the switch off does not release drafts already held (their jobs are done); a new decision on the ticket cancels the held action but leaves its Outlook draft for a person to delete.

**Needs `Mail.ReadWrite`** for `createReply` and the PATCH, on top of `Mail.Send`. Granted 2026-09-28 (confirmed by the business; no send has exercised it yet).

### An approved draft is grey until it reaches the mailbox, then a person may write their own reply (2026-09-30)

Asked for on the ticket page: an approved draft should look approved (grey, no buttons) until it arrives in the mailbox, then stop being shown as a draft at all, with a « Create draft » button in its place so a person can add what the agent missed.

- **« Arrived » is the action's state, not the draft's.** Grey while the outbound action is `approved` (queued, the worker has not run). From `draft_created` (in Outlook's Drafts, with `OUTBOUND_STOP_BEFORE_SEND`), `send_requested` or `sent_confirmed`, the reply is Outlook's: the panel shows one line saying where it went. While something waits, the page re-reads the thread every 15 s, and only then.
- **« Create draft » is offered when no agent draft is waiting on a person or the worker:** none, rejected, stale, or delivered. Not while a draft is pending, so the page never holds two competing replies.
- **A manual reply goes out the one way replies go out** (§ One component sends a reply): an `outbound_actions` row, `mode = manual`, no draft, sent by the same worker. It is threaded under the customer's latest message, and the page names that message: if the customer has written since the page loaded, the dashboard refuses it on the spot and the worker would refuse it (`customer_wrote_again`) at send time.
- **Its pre-send check is that one question only.** No draft to withdraw, no version check, no `already_answered`: the person wrote it knowing our earlier reply had gone, which is usually why they are writing. The case version is still recorded, for the history.
- **Not keyed on the case version.** Our own reply does not always move the version, so a second addition on one version would have collided with the first. `manual_reply` rows are left out of the version key and keyed on `client_key`, minted by the composer once per reply: a double click or a retried request is still one email.

**It starts no agent work, deliberately.** Asked for explicitly, for token cost: a manual reply often carries the missing fact that settles the case. Once sent, it comes back through Sent Items like a reply typed in Outlook. The fold stales any open draft it supersedes, and drafting's `already_answered` skip keeps a new draft from being written. Nothing re-investigates on our own message; the investigation runs on the customer's next message (§ One investigation per inbound message) and reads the manual reply in the thread (§ The investigation reads the thread). The one model call it does cause is the Case Manager reading every message of ours gets since the cutover (§ The Case Manager reads every message), which records what we asked or promised so the case knows who acts next. If the reply settles the case, the person settles the checks and closes the ticket.

### A reply is sent as HTML cut by one rule, and the draft's link is finally a link (2026-09-30)

The reply box gained bold, italics, underline, lists and links (select words, then the link button or Ctrl+K). That made the body HTML, and HTML from a browser is not something to hand to a mailbox as it is.

- **One module cuts it, `scripts/lib/reply-html.mjs`, in the editor's paste, the save path and the worker.** It **rebuilds** rather than filters: every tag in the output is written from a fixed list (`p br strong em u a ul ol li`), with no attribute but a checked `href` (https, or mailto for an address). Everything else becomes text, and script/style go with their content. It runs again in the adapter just before the provider call.
- **The text stays the record.** `approved_body_text` / `body_text` hold the plain text of the HTML, and that is what the edit log compares (§ A human edit is recorded…). The draft's own link folds back to its `[[marker]]`, so a draft opened and saved unchanged reads as unchanged rather than as a correction.
- **Found on the way: the send path put the literal `[[ici]]` in front of the customer.** The marker was resolved only where a draft was *rendered*; `actionFromDraft` copied the raw text. The action's HTML is now built with the marker as its link, and editing opens the marker as a real link, so the « keep the brackets » hint is gone.
- **Not the article editor.** That one offers headings because headings cut an article into retrieval chunks (§ Knowledge); a reply has no sections, so `ReplyEditor` is its own component on the same mechanics.
