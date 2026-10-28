<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Human overrides

### A person corrects a ticket in one Save, and the case version is what keeps a stale reply from going out (2026-09-29)

The ticket rail has one « Edit case » mode. A person can correct the situation, category, level, state, team and priority band. Only those fields become pickers. What the agent derived stays read-only: the investigation, the case, the required action and the rule. The order keeps its own dialog (§ *A person can link a ticket's order*). There is no approval step: a correction is recorded and the pipeline moves on.

**No second version counter.** The brief asked for a `ticket_version` checked before any send. `case_current.version` already is that counter: drafts are keyed on it, the fold stales older ones (`case_changed`) and `preSendCheck` refuses a send with `case_moved`. What was missing was an override reaching the fold. The fold now adds the overridden **situation, category and level** to `material_hash`, but only when one exists: a key on every ticket would change every hash at once and stale every open draft in the shop. The dashboard re-folds on Save, so a draft is withdrawn before anything can send it. It does not wait for the next poll.

**What each field triggers** (`scripts/lib/ticket-overrides.mjs`, the only place the classes are written):

| Class | Fields | Raises the version | Investigation |
|---|---|---|---|
| Meaning | situation, category | yes | queued once per Save |
| Gate | level | yes (level 4 is silent; level decides auto-send) | no: the draft gate re-reads it |
| Workflow | state, team, priority band | no | no |

**Automatic re-investigation, not a button (decided with the owner).** A manual « re-investigate » fails silently. The version bump has already withdrawn the draft, so if a person forgets the button, nothing is sent and nothing is redrafted. The race is already covered: an in-flight send is refused at send time, and the next poll drafts on the new version. One Save is one run, however many fields moved. It is queued, never run inline, like the order link.

**Not through the Case Manager.** The Case Manager is a model that reads a *message*. A correction is a fact with one right value, and the Case Manager is barred from naming a situation anyway. Routing it there would cost one mini-tier call and add nothing. The investigation still gets the « Dossier connu » from the reading already stored for the trigger message.

**Out of scope after the change: no run.** A meaning change queues the investigation only if the ticket, *as it will be*, passes the investigation's own `isInvestigable`. The rule is injected, not copied. So a ticket moved to a forwarded kind (`contact`), to b2b, to level 4, to a linked duplicate or to a subject not enabled costs nothing. Its version still moves, so the draft written for the old subject is withdrawn. Since 2026-09-29 forwarding follows the category through `forwarding_destinations`, whatever the kind: a ticket moved to `careers` is re-routed to its destination on the next pass (the stored decision is re-taken when the category changes). Changing the kind is not an override; that was left out on purpose.

**A category change alone is a label while the situation is pinned.** The category only reaches the investigation through the matcher's subject filter, and a pinned situation skips the matcher.

**The column holds the person's value.** `tickets.<column>` is the effective value, so the queue, the investigation and the draft gate read what they always read. `tickets.overrides.<field>` keeps `{ value, ai_value, set_by, set_at, source }`. **The categoriser keeps `ai_value` current.** It writes its reading of an overridden field there instead of into the column, so « Reset to automatic » goes back to what the model says *now*. « Level never falls » is a rule about the model, so it ratchets against `ai_value`, and a person may lower a level. `ticket_overrides` is the append-only audit of every set and every reset.

**Who wins, per field:**
- **State** holds until the customer writes again (`statusHeld`). Before this, the fold moved a person's `open` to `awaiting_customer` on the next poll. A person still sets only `open`, `resolved` and `closed`.
- **Situation** is carried as `verdict: 'human'`, with that exemplar's own `requirement_needs`, and skips the matcher and the chooser. A later `new_issue` is matched on its own (decided with the owner): the correction was about the first request. It stays in the audit, and the planner looks for a `new_issue` reading newer than the correction.
- **Priority** pins the band only. The ticket still climbs inside the band as it waits. Level 4 stays high whatever was pinned.

**The evals exclude a person's situation.** `eval:exemplar-needs` asks whether the matcher's situations describe real tickets, and a situation a person chose is not the matcher's claim. `eval:fold` is unchanged at 79 of 132, since it carries no overrides.

**Left out by decision:** assignee (no column and no user list exist, and AGENTS.md forbids inventing them — *reversed 2026-10-28: the list is now read from Supabase Auth through `dashboard_team()`; see `tickets-dashboard.md` § Assignment*); linking a customer (no dashboard path today, and it touches personal-data rules); unlinking an order.

**The nearest three situations** are now stored as `exemplar_match.top` (key, similarity, question). The rail offers them with « Apply » while the match is unsettled and nobody has chosen one. Runs before 2026-09-29 offer `closest` and `runner_up` only.
