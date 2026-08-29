"use client";

import { ARTICLE_VERDICT_LABELS, parcelsFromTrace } from "@/lib/agent-test-types";
import type { ArticleVerdict, ModelCall, TraceEvent, TrackingParcel } from "@/lib/agent-test-types";

import { ClaimList, Field, Fields, RawEvent, StepCard, TranscriptParcels, Verbatim } from "./StepCard";
import styles from "./RunTranscript.module.css";

/**
 * A run, as a person reads it.
 *
 * ONE CARD PER STEP, IN THE ORDER THEY HAPPENED, because the order is the
 * finding as often as the content is — the case file is written before the order
 * is resolved, and a transcript that grouped by topic would hide that.
 *
 * The tool steps are the centre of the thing: one row per ledger entry with the
 * exact text the model was handed. Everything above them is why those tools were
 * the ones available; everything below is what was done with what they said.
 */
export function RunTranscript({ events }: { events: TraceEvent[] }) {
  // Read once for the whole transcript rather than per step: the order tool's
  // answer, the drafting prompt that quotes it and the reply itself are three
  // views of one set of parcels, and a number should be the same link in all
  // three.
  const parcels = parcelsFromTrace(events);
  return (
    <TranscriptParcels parcels={parcels}>
      <div className={styles.transcript}>
        {events.map((event, index) => (
          <Step key={index} event={event} />
        ))}
      </div>
    </TranscriptParcels>
  );
}

function Step({ event }: { event: TraceEvent }) {
  const calls = (event.calls as ModelCall[] | undefined) ?? [];

  switch (event.type) {
    case "input":
      return (
        <StepCard title="Message" summary={str(event.subject) || "(no subject)"}>
          <Fields>
            <Field label="From">{str(pick(event.requester, "name")) || "—"}</Field>
            <Field label="Address">{str(pick(event.requester, "masked")) || "not given"}</Field>
            {event.senderDirectory ? (
              <Field label="Sender directory">
                {str(pick(event.senderDirectory, "label"))} ({str(pick(event.senderDirectory, "pattern"))})
              </Field>
            ) : null}
          </Fields>
          <Verbatim label="Body, as the pipeline receives it" text={str(event.body) ?? ""} />
          {event.orderNumberAppended ? (
            <p className={styles.note}>
              The order number you gave was appended to the message body, because on a real email
              that is where it would be — the resolver has to find it in the text.
            </p>
          ) : null}
        </StepCard>
      );

    case "gate": {
      const blocked = event.outcome === "blocked";
      return (
        <StepCard
          title="Spam gate"
          tone={blocked ? "bad" : "good"}
          calls={calls}
          summary={blocked ? "Would have been dropped" : `Kept · ${str(event.label) ?? "legitimate"}`}
        >
          <Fields>
            <Field label="Label">{str(event.label) ?? "—"}</Field>
            <Field label="Failed open">{event.failedOpen ? "yes" : "no"}</Field>
          </Fields>
          {event.reason ? <Verbatim label="Reason" text={str(event.reason)!} /> : null}
          {blocked ? (
            <p className={styles.warn}>
              A real email judged this way never becomes a ticket, so nothing after this point would
              have run.
            </p>
          ) : null}
        </StepCard>
      );
    }

    case "identity":
      return (
        <StepCard
          title="Identity"
          summary={event.linked ? "Matched a customer" : "No customer matched"}
          defaultOpen={false}
        >
          <Fields>
            <Field label="Result">{str(event.status) ?? "—"}</Field>
            <Field label="Matched by">{str(event.matchedBy) ?? "—"}</Field>
          </Fields>
          {event.note ? <p className={styles.note}>{str(event.note)}</p> : null}
        </StepCard>
      );

    case "categorise":
      return (
        <StepCard
          title="Categorisation"
          tone={event.failed ? "bad" : "neutral"}
          calls={calls}
          defaultOpen
          summary={
            event.failed
              ? "Failed — the message was never labelled"
              : `${str(event.category) ?? "?"} / ${str(event.requestKind) ?? "?"} · level ${
                  str(event.level) ?? "?"
                }`
          }
        >
          {event.note ? <p className={styles.warn}>{str(event.note)}</p> : null}
          <Fields>
            <Field label="Subject">{str(event.category) ?? "—"}</Field>
            <Field label="Kind">{str(event.requestKind) ?? "—"}</Field>
            <Field label="Level">{str(event.level) ?? "—"}</Field>
            <Field label="Team">{str(event.responsibleTeam) ?? "—"}</Field>
            <Field label="Language">{str(event.language) ?? "—"}</Field>
            <Field label="Mood">{str(event.happiness) ?? "—"}</Field>
            {event.secondaryCategory ? (
              <Field label="Also">{`${str(event.secondaryCategory)} / ${str(event.secondaryRequestKind)}`}</Field>
            ) : null}
          </Fields>
          {event.reason ? <Verbatim label="Why" text={str(event.reason)!} /> : null}
          <ToolsAllowed tools={(event.toolsAllowed as string[]) ?? []} />
        </StepCard>
      );

    case "tool":
      if (event.registry) {
        return (
          <StepCard
            title="Tools available"
            summary={((event.registry as string[]) ?? []).join(", ") || "none"}
          >
            <p className={styles.note}>
              These are the only tools this ticket&apos;s subject and level permit. The model is
              never shown the rest, so anything it could not check is something it was not allowed
              to.
            </p>
          </StepCard>
        );
      }
      return (
        <StepCard
          title={`Tool · ${str(event.tool)}`}
          tone={toolTone(str(event.outcome))}
          defaultOpen
          summary={
            <>
              {str(event.outcome)}
              {event.source === "opening_move" && (
                <span className={styles.tag}>run before the model was asked</span>
              )}
              {event.cached ? <span className={styles.tag}>asked again, served from cache</span> : null}
            </>
          }
        >
          {event.args && Object.keys(event.args as object).length > 0 ? (
            <Verbatim label="Arguments" text={JSON.stringify(event.args, null, 2)} />
          ) : null}
          <Verbatim
            label="What the model was given back"
            text={str(event.promptText) ?? "(nothing)"}
          />
          {event.detail && Object.keys(event.detail as object).length > 0 ? (
            <ToolDetail detail={event.detail as Record<string, unknown>} />
          ) : null}
          {((event.caveats as string[]) ?? []).length > 0 ? (
            <p className={styles.note}>Caveats raised: {(event.caveats as string[]).join(", ")}</p>
          ) : null}
        </StepCard>
      );

    case "case_file":
      if (event.skipped) {
        return (
          <StepCard title="Case file" tone="warn" summary="Not investigated" defaultOpen>
            <p className={styles.note}>{str(event.note)}</p>
          </StepCard>
        );
      }
      return (
        <StepCard
          title="Case file"
          tone={event.verdict === "answerable" ? "good" : "warn"}
          calls={calls}
          defaultOpen
          summary={str(event.verdict) ?? "—"}
        >
          <ClaimList label="Established" items={(event.established as unknown[]) ?? []} />
          <ClaimList label="Unverified" items={(event.unverified as unknown[]) ?? []} />
          <ClaimList label="Missing — only the customer can supply these" items={(event.missing as unknown[]) ?? []} />
          <ClaimList label="Must not claim" items={(event.doNotClaim as unknown[]) ?? []} />
          <PolicyBlock policy={event.policy} verdict={str(event.verdict)} />
          {event.handoff ? (
            <Verbatim
              label="Handoff — internal, never sent to a customer"
              text={
                typeof event.handoff === "string"
                  ? event.handoff
                  : JSON.stringify(event.handoff, null, 2)
              }
            />
          ) : null}
          {((event.droppedClaims as unknown[]) ?? []).length > 0 ? (
            <ClaimList
              label="Dropped — claimed without a tool result behind it"
              items={event.droppedClaims as unknown[]}
            />
          ) : null}
          {((event.knowledge as unknown[]) ?? []).length > 0 ? (
            <div>
              <p className={styles.subLabel}>Knowledge that reached the drafting prompt</p>
              <ul className={styles.knowledge}>
                {(event.knowledge as { title: string; similarity: number }[]).map((chunk, index) => (
                  <li key={index}>
                    {chunk.title ?? "Untitled"}{" "}
                    <span className={styles.score}>{fmt(chunk.similarity)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <RawEvent event={event} />
        </StepCard>
      );

    case "order_resolution":
      return (
        <StepCard
          title="Order number"
          summary={
            event.orderNumber ? `${str(event.orderNumber)} · ${str(event.status)}` : str(event.status) ?? "—"
          }
        >
          <Fields>
            <Field label="Result">{str(event.status) ?? "—"}</Field>
            <Field label="Verified by">{str(event.verifiedBy) ?? "—"}</Field>
          </Fields>
          {event.detail ? <p className={styles.note}>{str(event.detail)}</p> : null}
          <p className={styles.note}>{str(event.note)}</p>
        </StepCard>
      );

    case "order_context":
      return (
        <StepCard
          title="Order facts"
          summary={event.built ? `Bundle built · ${str(pick(event.order, "name")) ?? ""}` : "No confirmed order"}
        >
          {event.built ? (
            <Fields>
              <Field label="Order">{str(pick(event.order, "name")) ?? "—"}</Field>
              <Field label="Status">{str(pick(event.order, "status")) ?? "—"}</Field>
              <Field label="Placed">{str(pick(event.order, "placedAt")) ?? "—"}</Field>
              {/* `parcels` on runs recorded from now on; `fulfilments` is what
                  the same count was called before, and older rows still hold it.
                  Both are read so opening an old run is not a blank field. */}
              <Field label="Parcels">
                {str(pick(event.order, "parcels")) ?? str(pick(event.order, "fulfilments")) ?? "0"}
              </Field>
              {parcelsFromTrace([event]).length > 0 && (
                <Field label="Tracking">
                  <TrackingParcelList parcels={parcelsFromTrace([event])} />
                </Field>
              )}
            </Fields>
          ) : (
            <p className={styles.note}>
              No order was confirmed for this message, so the reply below rests on no order facts.
            </p>
          )}
        </StepCard>
      );

    case "draft":
      if (event.skipped) {
        return (
          <StepCard title="Reply" tone="warn" defaultOpen summary={`Not drafted · ${str(event.reason)}`}>
            <p className={styles.note}>{str(event.note) ?? "No reply was written."}</p>
          </StepCard>
        );
      }
      return (
        <StepCard
          title="Reply"
          tone={event.checksPassed ? "good" : "warn"}
          calls={calls}
          defaultOpen
          summary={`${str(event.disposition)} · ${
            event.checksPassed ? "all checks passed" : `${((event.failedChecks as string[]) ?? []).length} check(s) failed`
          }`}
        >
          <Verbatim text={str(event.body) ?? ""} />
          <Fields>
            <Field label="From verdict">{str(event.sourceVerdict) ?? "—"}</Field>
            <Field label="Disposition">{str(event.disposition) ?? "—"}</Field>
            <Field label="Language">{str(event.language) ?? "—"}</Field>
            <Field label="Would auto-send">{event.autoSendEligible ? "yes" : "no"}</Field>
          </Fields>
          {((event.failedChecks as string[]) ?? []).length > 0 ? (
            <div>
              <p className={styles.subLabel}>Checks that failed</p>
              <ul className={styles.failed}>
                {(event.failedChecks as string[]).map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <RawEvent event={event} />
        </StepCard>
      );

    case "article": {
      const verdict = str(event.verdict) as ArticleVerdict;
      const meaning = ARTICLE_VERDICT_LABELS[verdict];
      return (
        <StepCard
          title="Your article"
          tone={meaning?.tone ?? "neutral"}
          defaultOpen
          summary={`${str(event.title) ?? "Article"} — ${meaning?.label ?? verdict}`}
        >
          <p className={styles.note}>{meaning?.hint}</p>
          <Fields>
            <Field label="Knowledge tool ran">{event.searched ? "yes" : "no"}</Field>
            <Field label="Tool was available">{event.offered ? "yes" : "no"}</Field>
            <Field label="Best score">
              {event.best
                ? `${fmt(pick(event.best, "similarity"))} (${str(pick(event.best, "band"))})`
                : "not ranked"}
            </Field>
            <Field label="Rank">{event.rank ? `${event.rank} of ${event.poolSize}` : "—"}</Field>
          </Fields>
          <p className={styles.note}>
            The bar for an answer is {fmt(pick(event.bands, "answerable"))}; anything from{" "}
            {fmt(pick(event.bands, "weak"))} is reported as weak and withheld.
          </p>
        </StepCard>
      );
    }

    case "error":
      return (
        <StepCard title="Failed" tone="bad" defaultOpen summary={str(event.message) ?? "Unknown error"}>
          <p className={styles.warn}>{str(event.message)}</p>
        </StepCard>
      );

    default:
      // A step this build does not know how to render — an older stored run, or
      // a newer worker. Shown raw rather than dropped.
      return (
        <StepCard title={String(event.type)} defaultOpen>
          <RawEvent event={event} />
        </StepCard>
      );
  }
}

function ToolsAllowed({ tools }: { tools: string[] }) {
  return (
    <div>
      <p className={styles.subLabel}>Tools this subject may use</p>
      {tools.length === 0 ? (
        <p className={styles.note}>
          None. This subject is deliberately left to a person — the agent gathers nothing and writes
          nothing.
        </p>
      ) : (
        <ul className={styles.tools}>
          {tools.map((tool) => (
            <li key={tool}>{tool}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolDetail({ detail }: { detail: Record<string, unknown> }) {
  const candidates = detail.candidates as
    | { title: string | null; similarity: number | null }[]
    | undefined;
  return (
    <div className={styles.detail}>
      {candidates?.length ? (
        <div>
          <p className={styles.subLabel}>Everything retrieval ranked</p>
          <ol className={styles.candidates}>
            {candidates.map((candidate, index) => (
              <li key={index}>
                {candidate.title ?? "Untitled"} <span className={styles.score}>{fmt(candidate.similarity)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {detail.matchedProducts ? (
        <p className={styles.note}>Matched: {(detail.matchedProducts as string[]).join(", ")}</p>
      ) : null}
      {detail.codes ? <p className={styles.note}>Codes: {(detail.codes as string[]).join(", ")}</p> : null}
      {detail.customer ? (
        <p className={styles.note}>Customer: {JSON.stringify(detail.customer)}</p>
      ) : null}
    </div>
  );
}

function toolTone(outcome: string | null): "neutral" | "good" | "warn" | "bad" {
  if (!outcome) return "neutral";
  if (outcome === "error") return "bad";
  if (["found", "answerable", "eligible", "kept"].includes(outcome)) return "good";
  if (["none", "no_match", "not_found", "weak", "ambiguous", "no_code_in_message"].includes(outcome)) {
    return "warn";
  }
  return "neutral";
}

/** A similarity, at the precision the bands are argued in. */
function fmt(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

/** One key off a trace value that is an object of unknown shape. */
function pick(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;
}

/** Trace values arrive as `unknown`; this narrows one to a string for rendering. */
function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * The run's parcels, linked to the carrier where we hold a URL.
 *
 * The transcript's counterpart to `TrackingList` in TicketDetailPanel, and it
 * follows the same rule: a parcel with no fulfilment URL is shown as a number
 * and not as a link, because a guessed carrier page is worse than none.
 */
function TrackingParcelList({ parcels }: { parcels: TrackingParcel[] }) {
  return (
    <>
      {parcels.map((parcel) => (
        <span key={parcel.number} className={styles.parcel}>
          {parcel.url ? (
            <a className={styles.trackingLink} href={parcel.url} target="_blank" rel="noreferrer">
              {parcel.number}
            </a>
          ) : (
            parcel.number
          )}
          {parcel.carrier ? <span className={styles.carrier}>{parcel.carrier}</span> : null}
        </span>
      ))}
    </>
  );
}

/**
 * The policy rule this evidence selected, and what it would have done.
 *
 * SHOWN BESIDE THE VERDICT IT DID NOT CHANGE, which is the shadow phase's whole
 * proposition: the rule is recorded, the investigation's own verdict stands, and
 * a person reads the disagreement before anything is switched on. Rendering it
 * next to the case file rather than as its own step is deliberate — the question
 * being asked is "would this rule have been right about THIS ticket", and that
 * is unanswerable without the verdict in the same eyeline.
 */
function PolicyBlock({ policy, verdict }: { policy: unknown; verdict: string | null }) {
  if (!policy || typeof policy !== "object") {
    return null;
  }
  const p = policy as Record<string, unknown>;
  const answerKey = str(p.answer_key);
  const route = str(p.route);
  const changes = p.would_change_verdict === true;

  return (
    <Fields>
      <Field label="Policy rule">
        {answerKey ?? `no rule matched (${str(p.verdict) ?? "none"})`}
      </Field>
      {str(p.situation_key) ? <Field label="Situation">{str(p.situation_key)!}</Field> : null}
      <Field label="Would route to">
        {route ? `${route}${changes ? ` — differs from ${verdict ?? "the verdict"}` : " — agrees"}` : "leaves the verdict alone"}
      </Field>
      {str(p.ask) ? <Field label="Would ask for">{str(p.ask)!}</Field> : null}
      {((p.candidates as unknown[]) ?? []).length > 1 ? (
        <Field label="Also matched">{((p.candidates as string[]) ?? []).join(", ")}</Field>
      ) : null}
    </Fields>
  );
}
