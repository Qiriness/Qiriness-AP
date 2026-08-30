"use client";

import { useEffect, useState } from "react";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { fetchTicketDetail } from "@/lib/api/tickets";
import { formatRelativeTime } from "@/lib/relative-time";
import type {
  InvestigationVerdict,
  TicketDetail,
  TicketListItem,
  TicketReactionReport,
  TicketTracking,
} from "@/lib/types";
import styles from "./TicketDetailPanel.module.css";

interface TicketDetailPanelProps {
  ticket: TicketListItem;
}

/** The badge beside the results heading. Three verdicts, three colours. */
const VERDICT_LABELS: Record<InvestigationVerdict, string> = {
  answerable: "Answerable",
  needs_customer_input: "Needs customer input",
  needs_human: "Needs a human",
};

const VERDICT_CLASSES: Record<InvestigationVerdict, string> = {
  answerable: styles.verdictAnswerable,
  needs_customer_input: styles.verdictAsk,
  needs_human: styles.verdictHuman,
};

/**
 * The "product blamed" line, per outcome.
 *
 * FOUR SENTENCES RATHER THAN A NAME AND A DASH. Every outcome here except the
 * first is a different KIND of not-knowing, and they lead to different next
 * moves: ambiguous means ask which one, not_in_catalogue means check whether it
 * is even ours, not_attributed means ask at all. A dash would collapse three
 * actions into one shrug.
 */
const REACTION_PRODUCT: Record<
  TicketReactionReport["outcome"],
  (report: TicketReactionReport) => string
> = {
  identified: (report) => report.product ?? "—",
  ambiguous: (report) =>
    report.alternatives.length > 0
      ? `Could be ${report.alternatives.join(", ")} — needs confirming`
      : "Matched more than one product — needs confirming",
  not_in_catalogue: (report) =>
    report.claimed
      ? `“${report.claimed}” — not a product in the catalogue`
      : "Not a product in the catalogue",
  not_attributed: () => "The customer did not say which product",
  unknown: () => "Not recorded",
};

/**
 * What the agent made of a ticket, revealed under its row.
 *
 * THREE BLOCKS, and the order is the question an operator actually has: what
 * came of it (Results), which order it concerns (Order), and what to do next
 * (Action). Everything else the case file holds — the unverified claims, the
 * prohibitions, the tool ledger — is written for the drafting stage, and pouring
 * it in here would bury the three lines somebody opened the row to read.
 *
 * THE ORDER BLOCK IS A TEXT LIST, NOT A ROW. Who the order belongs to, order
 * status, tracking number and tracking status are labelled lines that appear
 * only when the resolved context actually carries them, so an unfulfilled order
 * shows two lines and a delivered one shows five. Reserving a slot per field —
 * the shape a table would force — would fill the block with dashes, and a dash
 * beside "Tracking number" reads as "there is no tracking" rather than "nothing
 * has been resolved yet".
 *
 * Fetches on mount, and it only mounts when a row is expanded: the queue is 565
 * rows and one is open at a time. Unmounting on collapse means re-opening asks
 * again, which is what you want from a table the worker rewrites underneath you.
 */
/**
 * Parcel numbers, linked to the carrier's own tracking page where the bundle
 * carries a URL.
 *
 * ONE COMPONENT FOR BOTH BLOCKS. The confirmed order and the last-order
 * candidate render the same `TicketTracking[]`, and they were written twice —
 * the second copy dropped the link, so the candidate showed a bare number that
 * a reviewer had to paste into La Poste by hand. That is exactly the drift two
 * copies of a rendering produce, and it is the reason this is a component
 * rather than a shape repeated in two places.
 *
 * `noreferrer` with `target="_blank"`: the carrier is a third party and has no
 * business receiving the dashboard URL in a Referer header.
 */
function TrackingList({ parcels }: { parcels: TicketTracking[] }) {
  return (
    <>
      {parcels.map((parcel) => (
        <span key={parcel.number} className={styles.parcel}>
          {parcel.url ? (
            <a
              className={styles.trackingLink}
              href={parcel.url}
              target="_blank"
              rel="noreferrer"
            >
              {parcel.number}
            </a>
          ) : (
            <span className={styles.tracking}>{parcel.number}</span>
          )}
          {parcel.carrier && <span className={styles.carrier}>{parcel.carrier}</span>}
        </span>
      ))}
    </>
  );
}

export function TicketDetailPanel({ ticket }: TicketDetailPanelProps) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);

    fetchTicketDetail(ticket.id)
      .then((loaded) => {
        // The row may have been collapsed, or another one opened, while this was
        // in flight; writing state then would show one ticket's case file under
        // another's row.
        if (live) setDetail(loaded);
      })
      .catch((cause) => {
        if (live) setError(knowledgeErrorMessage(cause));
      });

    return () => {
      live = false;
    };
  }, [ticket.id]);

  const results = detail?.results ?? null;
  const order = detail?.order ?? null;
  const facts = detail?.facts ?? [];
  // The list row already carries the confirmed order number, so the heading
  // stops being "loading" while the bundle is still in flight. The bundle's own
  // `name` wins where both exist — they agree by construction (the context is
  // built from the order that number resolved to), but one of them is the row
  // that was rendered a minute ago.
  const orderNumber = order?.orderName ?? ticket.orderNumber;
  // The last-order fallback, shown only where a confirmed order is not. It is
  // derived in the tool's unresolved branch, so the two are mutually exclusive
  // upstream; this guard states that rather than relying on it.
  const candidate = !orderNumber ? (results?.candidateOrder ?? null) : null;
  // Null on every subject but cosmetovigilance, and on a reaction ticket whose
  // run predates the tool — so the block below is absent rather than empty.
  const reaction = results?.reactionReport ?? null;

  return (
    <div className={styles.panel}>
      <section className={styles.block}>
        <h3 className={styles.heading}>
          Results
          {results && (
            <span className={`${styles.verdict} ${VERDICT_CLASSES[results.verdict]}`}>
              {VERDICT_LABELS[results.verdict]}
            </span>
          )}
        </h3>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : !detail ? (
          <p className={styles.muted}>Loading…</p>
        ) : !results ? (
          <p className={styles.muted}>
            The agent has not investigated this ticket. It is either still queued, not yet
            categorised, or on a subject the agent has no tools for.
          </p>
        ) : (
          <>
            <p className={styles.summary}>{results.headline}</p>
            {/* When it was read matters: a case file predating the customer's
                latest reply describes an older conversation. */}
            {results.investigatedAt && (
              <p className={styles.stamp}>
                Investigated{" "}
                <time dateTime={results.investigatedAt}>
                  {formatRelativeTime(results.investigatedAt)}
                </time>
              </p>
            )}
            {results.findings.length > 0 ? (
              /* Each line rests on a tool call that actually ran — a claim citing
                 one that did not never reaches the stored case file. */
              <ul className={styles.findings}>
                {results.findings.map((finding, index) => (
                  <li key={index}>{finding}</li>
                ))}
              </ul>
            ) : (
              <p className={styles.muted}>Nothing could be established from the tools available.</p>
            )}

            {/* THE FACTS UNDER THE FINDINGS. The lines above are the model's
                sentences; these are what they rest on — which product, which
                code, why it was refused — so a promotions or product ticket can
                be judged without opening Shopify, the way an order one already
                could. Absent entirely when the tools established nothing
                specific, which is the normal state for most tickets. */}
            {/* What could NOT be settled, and why. Shown because an unanswered
                question is a decision a person may need to make differently —
                and because a recurring entry here is usually a knowledge
                article nobody has written yet rather than a missing tool. */}
            {results.unresolved.length > 0 && (
              <ul className={styles.unresolved}>
                {results.unresolved.map((entry, index) => (
                  <li key={index}>
                    {entry.claim}
                    {entry.why && <span className={styles.why}> — {entry.why}</span>}
                  </li>
                ))}
              </ul>
            )}

            {facts.length > 0 && (
              <dl className={styles.facts}>
                {facts.map((fact) => (
                  <div className={styles.fact} key={fact.need}>
                    <dt>
                      {fact.label}
                      {fact.outcome && <span className={styles.outcome}> · {fact.outcome}</span>}
                    </dt>
                    <dd>
                      {fact.lines.map((line, index) => (
                        <span className={styles.factLine} key={index}>
                          {line}
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
      </section>

      {/* THE REPORTED REACTION, and its own block rather than a line among the
          findings. An operator picking up a cosmetovigilance ticket is looking
          for two things — which product, what happened — and on these tickets
          the Order block below is almost always empty, so there is room and a
          reason to give them their own heading.

          IT SAYS "BLAMES", NOT "CAUSED", in the heading and in every line under
          it. The record is a reading of the customer's email; whether the
          product is responsible is the judgement this panel exists to hand to a
          person, and a heading like "Cause" would quietly make it for them. */}
      {reaction && (
        <section className={styles.block}>
          <h3 className={styles.heading}>Reported reaction</h3>
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt>Product blamed</dt>
              <dd>{REACTION_PRODUCT[reaction.outcome](reaction)}</dd>
            </div>
            {reaction.reaction && (
              <div className={styles.fact}>
                <dt>Reaction described</dt>
                <dd>{reaction.reaction}</dd>
              </div>
            )}
            {/* SHOWN ONLY WHERE IT ADDS SOMETHING. When one product resolved,
                the customer's wording is the evidence that the match is right —
                or wrong. When nothing resolved, their words are already the
                whole answer above and repeating them reads as a bug. */}
            {reaction.outcome === "identified" && reaction.claimed && (
              <div className={styles.fact}>
                <dt>Their words</dt>
                <dd className={styles.muted}>“{reaction.claimed}”</dd>
              </div>
            )}
          </dl>
          <p className={styles.candidateNote}>
            What the customer attributes their reaction to. Not an established cause — the
            agent is barred from drawing one, and so is any reply.
          </p>
        </section>
      )}

      <section className={styles.block}>
        <h3 className={styles.heading}>Order</h3>
        {orderNumber ? (
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt>Order</dt>
              <dd className={styles.order}>{orderNumber}</dd>
            </div>

            {/* WHO THE ORDER BELONGS TO. A confirmed order means the requester's
                address hashes to the order's — it does NOT mean the names agree,
                and a disagreement is the shape of both an innocent case (a gift,
                a partner's account, a married name) and one worth investigating.
                Read against the requester in the row above.

                The panel states it and judges nothing. The agent already has a
                name comparison (`compareNames`, accent- and case-insensitive)
                and it is deliberately not repeated here: a second opinion in the
                dashboard would disagree with the first the day either changed. */}
            {order?.customerName && (
              <div className={styles.fact}>
                <dt>Name on the order</dt>
                <dd>
                  {order.customerName}
                  {/* Masked at map time — the local part was destroyed on the
                      way in and cannot be recovered. Enough to recognise the
                      address, never enough to reuse it. It is what separates a
                      gift from a second mailbox when the names differ. */}
                  {order.contactEmail && (
                    <span className={styles.contactEmail}>{order.contactEmail}</span>
                  )}
                </dd>
              </div>
            )}

            {/* A guest checkout carries no account, so there is no name to pair —
                the address it was placed with is then the only identity the
                order has, and it is still worth seeing. */}
            {!order?.customerName && order?.contactEmail && (
              <div className={styles.fact}>
                <dt>Order contact</dt>
                <dd className={styles.contactEmailOnly}>{order.contactEmail}</dd>
              </div>
            )}

            {/* The three lines below are Shopify's answer, not the agent's, and
                each one is omitted entirely when the bundle does not carry it.
                A row of dashes reads as "we looked and there is nothing", which
                is a different and usually wrong claim. */}
            {order?.orderStatus && (
              <div className={styles.fact}>
                <dt>Order status</dt>
                <dd>{order.orderStatus}</dd>
              </div>
            )}

            {order && order.tracking.length > 0 && (
              <div className={styles.fact}>
                <dt>Tracking number</dt>
                <dd>
                  <TrackingList parcels={order.tracking} />
                </dd>
              </div>
            )}

            {order?.trackingStatus && (
              <div className={styles.fact}>
                <dt>Tracking status</dt>
                <dd>{order.trackingStatus}</dd>
              </div>
            )}
          </dl>
        ) : candidate ? (
          /* THE LAST ORDER, when the customer named none. Same projection as the
             confirmed block above and different headings, because it answers a
             different question: not "here is their order" but "here is where to
             start looking". It can never appear beside the confirmed block — the
             tool fetches it only in the branch where nothing was confirmed. */
          <>
            <p className={styles.candidateNote}>
              No order number confirmed. Their most recent order, as a starting point —
              the customer gave no number, so this may not be the one they mean.
            </p>
            <dl className={`${styles.facts} ${styles.candidateFacts}`}>
              <div className={styles.fact}>
                <dt>Last order</dt>
                <dd className={styles.order}>{candidate.orderName}</dd>
              </div>
              {candidate.orderStatus && (
                <div className={styles.fact}>
                  <dt>Last order status</dt>
                  <dd>{candidate.orderStatus}</dd>
                </div>
              )}
              {candidate.items.length > 0 && (
                <div className={styles.fact}>
                  <dt>Last order items</dt>
                  <dd>{candidate.items.join(", ")}</dd>
                </div>
              )}
              {candidate.tracking.length > 0 && (
                <div className={styles.fact}>
                  <dt>Last order tracking</dt>
                  <dd>
                    <TrackingList parcels={candidate.tracking} />
                  </dd>
                </div>
              )}
              {candidate.trackingStatus && (
                <div className={styles.fact}>
                  <dt>Last order delivery</dt>
                  <dd>{candidate.trackingStatus}</dd>
                </div>
              )}
            </dl>
          </>
        ) : (
          /* Absent is not the same as "no order": the column is written only on a
             confirmed match between the order's email hash and the requester's. */
          <p className={styles.muted}>No order number confirmed for this ticket.</p>
        )}

        {/* A bundle assembled weeks ago describes the order as it was then.
            Outside the list, because a `p` is not a valid child of a `dl`. */}
        {orderNumber && order?.resolvedAt && (
          <p className={styles.stamp}>
            Shopify data read{" "}
            <time dateTime={order.resolvedAt}>{formatRelativeTime(order.resolvedAt)}</time>
          </p>
        )}
      </section>

      <section className={styles.block}>
        <h3 className={styles.heading}>Action</h3>
        {error || !detail ? (
          <p className={styles.muted}>—</p>
        ) : !results ? (
          <p className={styles.action}>Triage this one by hand.</p>
        ) : (
          <>
            <p className={styles.action}>{results.action}</p>
            {results.actionReason && <p className={styles.reason}>{results.actionReason}</p>}
          </>
        )}
      </section>
    </div>
  );
}
