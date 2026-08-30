"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import type { SaveRulePayload } from "@/lib/api/policy";
import type { PolicyRule, PolicySituation, PolicyVocabulary } from "@/lib/types";

import styles from "./RuleEditor.module.css";

/**
 * Writing one rule.
 *
 * EVERY CHOICE COMES FROM THE AGENT'S OWN VOCABULARY, passed in rather than
 * listed here: the states a condition may name, the routes it may take and the
 * questions it may ask are read out of `evidence-rules.mjs` and `case-file.mjs`
 * at request time. A dropdown that offered a state the agent cannot score would
 * let somebody write a rule that saves cleanly and can never fire, which is the
 * failure this whole layer is built to refuse.
 *
 * THE STATES ARE CHECKBOXES, NOT A SELECT, because a condition is a disjunction:
 * « the code is expired OR was never found » is one rule, not two. A single-select
 * would force authoring the same answer twice and then keeping the copies in step.
 */
export function RuleEditor({
  rule,
  situations,
  vocabulary,
  knownSets,
  onClose,
  onSave,
}: {
  rule: PolicyRule | null;
  situations: PolicySituation[];
  vocabulary: PolicyVocabulary;
  knownSets: string[];
  onClose: () => void;
  onSave: (payload: SaveRulePayload) => Promise<void>;
}) {
  const [answerSet, setAnswerSet] = useState(rule?.answerSet ?? knownSets[0] ?? "commande");
  const [answerKey, setAnswerKey] = useState(rule?.answerKey ?? "");
  const [situationKey, setSituationKey] = useState(rule?.situationKey ?? "");
  const [conditions, setConditions] = useState<Record<string, string[]>>(rule?.conditions ?? {});
  const [skeleton, setSkeleton] = useState(rule?.answerSkeleton ?? "");
  const [route, setRoute] = useState(rule?.route ?? "");
  const [ask, setAsk] = useState<string[]>(rule?.ask ?? []);
  const [offerCode, setOfferCode] = useState(rule?.offerCode ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (need: string, finding: string) => {
    setConditions((prev) => {
      const current = prev[need] ?? [];
      const next = current.includes(finding)
        ? current.filter((f) => f !== finding)
        : [...current, finding];
      const copy = { ...prev };
      if (next.length === 0) delete copy[need];
      else copy[need] = next;
      return copy;
    });
  };

  const toggleAsk = (key: string) =>
    setAsk((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  // Mirrors the constraint rather than only reporting it after a round trip.
  const askWithoutRoute = ask.length > 0 && route !== "needs_customer_input";

  return (
    <Dialog
      title={rule ? `Edit ${rule.answerKey}` : "New rule"}
      closeLabel="Close the rule editor"
      onClose={onClose}
    >
      <div className={styles.form}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>Answer set</span>
            <input value={answerSet} onChange={(e) => setAnswerSet(e.target.value)} list="answer-sets" />
            <datalist id="answer-sets">
              {knownSets.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label className={styles.field}>
            <span>Key</span>
            <input
              value={answerKey}
              onChange={(e) => setAnswerKey(e.target.value)}
              placeholder="annulation_possible"
            />
          </label>
        </div>

        <label className={styles.field}>
          <span>Situation — leave blank to apply to every situation in the set</span>
          <select value={situationKey} onChange={(e) => setSituationKey(e.target.value)}>
            <option value="">any situation</option>
            {situations.map((s) => (
              <option key={s.key} value={s.key}>
                {s.key} — {s.question.slice(0, 70)}
              </option>
            ))}
          </select>
        </label>

        <fieldset className={styles.conditions}>
          <legend>When the evidence says</legend>
          <p className={styles.hint}>
            Tick every state this rule covers. Nothing ticked means the rule applies whatever the
            evidence turned out to be.
          </p>
          {vocabulary.needs.map(({ need, findings, poweredBy }) => {
            const unsetParameter =
              poweredBy && !vocabulary.parameters.find((p) => p.key === poweredBy)?.set
                ? poweredBy
                : null;
            return (
            <div key={need} className={styles.need}>
              <span className={styles.needName}>
                {need}
                {/* THE LINK MADE VISIBLE. A parameter is never selectable as a
                    condition — you pick the state, not the number behind it —
                    but a state computed from a number nobody has set can never
                    resolve, and a rule branching on it would never fire. Saying
                    so here is cheaper than finding out from a transcript. */}
                {unsetParameter && (
                  <span className={styles.blocked}>
                    needs <b>{unsetParameter}</b>, which is not set — this rule cannot fire yet
                  </span>
                )}
              </span>
              <div className={styles.findings}>
                {findings.map((finding) => (
                  <label key={finding} className={styles.check}>
                    <input
                      type="checkbox"
                      checked={(conditions[need] ?? []).includes(finding)}
                      onChange={() => toggle(need, finding)}
                    />
                    <span>{finding}</span>
                  </label>
                ))}
              </div>
            </div>
            );
          })}
        </fieldset>

        <div className={styles.row}>
          <label className={styles.field}>
            <span>Then send it to</span>
            <select
              value={route}
              onChange={(e) => {
                setRoute(e.target.value);
                if (e.target.value !== "needs_customer_input") setAsk([]);
              }}
            >
              <option value="">nobody — answer it, leave the verdict alone</option>
              {vocabulary.routes.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          {/* CHECKBOXES, NOT A DROPDOWN, since a rule may ask for more than one
              thing. A reaction reported with no product named needs the product
              AND the batch number, and a single-select forced that into two
              round trips with somebody waiting on an answer about their skin.
              Same control as the conditions above, which is also a list. */}
          <fieldset className={styles.field}>
            <legend>
              <span>Asking the customer for</span>
            </legend>
            <div className={styles.findings}>
              {vocabulary.asks.map((a) => (
                <label key={a} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={ask.includes(a)}
                    onChange={() => toggleAsk(a)}
                    disabled={route !== "needs_customer_input"}
                  />
                  <span>{a}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <label className={styles.field}>
          <span>What the reply should do — guidance for the drafting agent, never sent as-is</span>
          <textarea
            rows={4}
            value={skeleton}
            onChange={(e) => setSkeleton(e.target.value)}
            placeholder="La commande n'est pas encore partie : l'annulation est encore possible…"
          />
        </label>

        {/* THE CODE THIS RULE HANDS OUT, and the second place a rule carries a
            VALUE rather than a condition. A parameter is a number the shop runs
            on; this is a commercial decision that changes with the season, so it
            is chosen per rule rather than held once globally.

            A PICKER, NEVER A TEXT BOX. A typed code is a key, and a mistyped one
            reaches a customer looking exactly like a real one — they only find
            out at checkout. The list is what an operator cleared on the
            Promotions screen, so a partner's 50% rate cannot be reached from
            here at all.

            The conditions ride along with each option, because a code that
            cannot be combined with a product discount is the commonest reason a
            customer writes back saying it still does not work. */}
        {vocabulary.offerableCodes.length > 0 && (
          <label className={styles.field}>
            <span>Give the customer a code</span>
            <select value={offerCode} onChange={(e) => setOfferCode(e.target.value)}>
              <option value="">no code — the reply offers nothing</option>
              {vocabulary.offerableCodes.map((code) => (
                <option key={code.code} value={code.code}>
                  {code.code}
                  {code.summary ? ` — ${code.summary}` : ""}
                  {code.stacksWith ? ` · not combinable with ${code.stacksWith.join(", ")}` : ""}
                  {code.oncePerCustomer ? " · once per customer" : ""}
                </option>
              ))}
            </select>
            <span className={styles.hint}>
              Cleared on the Promotions screen. The agent is told to reproduce it exactly and never
              to invent one — and if the code stops being offerable, the offer is dropped from the
              reply rather than sent stale.
            </span>
          </label>
        )}

        {/* THE ONE PLACE A RULE NAMES A PARAMETER DIRECTLY. A condition uses the
            state a number computes; this quotes the number itself. Inserted as a
            placeholder rather than typed, so changing 30 to 21 changes every
            skeleton that says it — the whole reason the number is held once. */}
        <div className={styles.insert}>
          <span className={styles.insertLabel}>Insert a number:</span>
          {vocabulary.parameters.map((p) => (
            <button
              key={p.key}
              type="button"
              className={styles.chip}
              title={p.set ? p.label : `${p.label} — not set yet`}
              data-unset={!p.set || undefined}
              onClick={() => setSkeleton((prev) => `${prev}{${p.key}}`)}
            >
              {p.key}
              {!p.set && <span className={styles.chipWarn}>unset</span>}
            </button>
          ))}
        </div>
        <p className={styles.hint}>
          A skeleton quoting a parameter nobody has set is dropped from the prompt, and the reply is
          written from the facts alone.
        </p>

        {askWithoutRoute && (
          <p className={styles.warn}>
            A rule that asks for something must also send the ticket to the customer.
          </p>
        )}
        {error && <p className={styles.error}>{error}</p>}

        <p className={styles.note}>
          Saving leaves the rule as a <b>draft</b>. It reaches real mail only once you put it live.
        </p>

        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving || !answerKey.trim() || askWithoutRoute}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await onSave({
                  answerSet,
                  answerKey,
                  situationKey: situationKey || null,
                  conditions,
                  answerSkeleton: skeleton || null,
                  route: route || null,
                  ask,
                  offerCode: offerCode || null,
                  priority: rule?.priority ?? 0,
                  isFallback: rule?.isFallback ?? false,
                });
              } catch (caught) {
                setError(knowledgeErrorMessage(caught));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Save as draft"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
