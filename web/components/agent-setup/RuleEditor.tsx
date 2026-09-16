"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ChevronDownIcon, CloseIcon, HelpIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import type { SaveRulePayload } from "@/lib/api/policy";
import { isReplyLinkUrl } from "@/lib/reply-links";
import { ruleLabel } from "@/lib/rule-labels";
import type { PolicyRule, PolicySituation, PolicyVocabulary } from "@/lib/types";

import styles from "./RuleEditor.module.css";

export interface RuleEditorSeed {
  answerSet?: string;
  situationKey?: string | null;
  conditions?: Record<string, string[]>;
  /**
   * The situation a GENERAL rule was started from. Scope only for the view: the
   * rule itself names no situation; its conditions open on this one's needs.
   */
  contextSituationKey?: string | null;
}

/** What each route means to the person choosing it. The keys are the agent's. */
const ROUTE_COPY: Record<string, { label: string; hint: string }> = {
  "": {
    label: "Answer",
    hint: "Reply from the facts. The verdict stays as the investigation set it.",
  },
  needs_customer_input: {
    label: "Ask the customer",
    hint: "Reply with what is known, then ask for what is missing.",
  },
  needs_human: {
    label: "Hand to a person",
    hint: "Reply with what is known. A colleague finishes the rest.",
  },
};

/**
 * How a rule comes to be applied, in the order the agent does it. Kept beside
 * the form because every one of these is a question somebody writing a rule
 * gets wrong once: that a situation outranks condition depth, that priority only
 * breaks ties, that saving is not going live.
 */
const RECAP_STEPS = [
  "The opening message of a thread is matched to one situation. A near miss is settled by a small model choosing between the closest ones.",
  "The investigation gathers evidence. Each need ends with one finding, such as an order that is not dispatched.",
  "Among live rules in the answer set, one keyed to the situation beats a general one; then the rule matching more conditions wins. Priority only breaks a tie.",
  "A general rule is used only when no rule of the situation matches — or when no situation matched at all.",
  "The winning rule decides where the ticket goes and what to ask. It can hand a ticket to the customer or a person, never declare one safe to answer.",
  "Its guidance, tone, link, code and article reach the drafting agent as instructions — never sent as written.",
  "Saving keeps a rule as a draft. It touches real mail only once it is put live.",
];

/**
 * Guidance that tells the reply NOT to apologise. Two live skeletons say « ne pas
 * s'excuser d'un retard qui n'en est pas un »; picking Apologetic on one of them
 * hands the drafting model both instructions, and it will follow one.
 */
const FORBIDS_APOLOGY = /\b(?:ne\s+(?:pas|jamais)|sans)\b[^.]{0,40}excus/i;

/**
 * Writing one rule, as a panel that slides over the rulebook.
 *
 * THE SCOPE COMES FROM WHERE IT WAS OPENED. The rail has already chosen the
 * answer set and the situation, and the canvas branch has already chosen the
 * condition, so the panel starts there and only offers to change scope behind a
 * disclosure. Asking again was the old list editor's shape, not this screen's.
 *
 * A GENERAL RULE MAY ALREADY ANSWER THE BRANCH. When the editor is opened from
 * one, it offers that rule instead of a new one. Choosing it saves nothing — the
 * agent already uses it there — it only opens it; writing a rule overrides it.
 *
 * EVERY CHOICE COMES FROM THE AGENT'S OWN VOCABULARY, passed in rather than
 * listed here: the states a condition may name, the routes it may take, the
 * questions it may ask and the tones it may set are read out of the agent's
 * modules at request time. A choice the agent cannot act on would let somebody
 * write a rule that saves cleanly and does nothing.
 *
 * THE CONDITIONS OPEN ON THIS SITUATION'S NEEDS — its `requirement_needs`, the
 * needs its other rules branch on, whatever this rule already names, and their
 * prerequisites — with every need one click away. Narrowing is a view, never a
 * filter on the data: a ticked finding is always shown, so nothing a rule
 * depends on can be hidden by it.
 *
 * THE STATES ARE MULTI-SELECT because a condition is a disjunction: « the code is
 * expired OR was never found » is one rule, not two.
 */
export function RuleEditor({
  rule,
  seed,
  answerSets,
  situations,
  rules,
  vocabulary,
  generalRules = [],
  onUseGeneralRule,
  onClose,
  onSave,
}: {
  rule: PolicyRule | null;
  seed?: RuleEditorSeed;
  answerSets: string[];
  situations: PolicySituation[];
  /** Every rule, so the conditions can open on what this situation branches on. */
  rules: PolicyRule[];
  vocabulary: PolicyVocabulary;
  /** Live general rules already answering the branch this editor was opened from. */
  generalRules?: PolicyRule[];
  /**
   * Pick a general rule for the branches named by the picked findings. Saves
   * nothing to the rulebook; the canvas marks those branches with it.
   */
  onUseGeneralRule?: (rule: PolicyRule, branches: { need: string; finding: string }[]) => void;
  onClose: () => void;
  onSave: (payload: SaveRulePayload) => Promise<void>;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const skeletonRef = useRef<HTMLTextAreaElement>(null);

  const [answerSet, setAnswerSet] = useState(rule?.answerSet ?? seed?.answerSet ?? answerSets[0] ?? "");
  const [answerKey, setAnswerKey] = useState(rule?.answerKey ?? "");
  const [situationKey, setSituationKey] = useState(rule?.situationKey ?? seed?.situationKey ?? "");
  const [conditions, setConditions] = useState<Record<string, string[]>>(rule?.conditions ?? seed?.conditions ?? {});
  const [skeleton, setSkeleton] = useState(rule?.answerSkeleton ?? "");
  const [route, setRoute] = useState(rule?.route ?? "");
  const [ask, setAsk] = useState<string[]>(rule?.ask ?? []);
  const [offerCode, setOfferCode] = useState(rule?.offerCode ?? "");
  const [knowledgeDocumentId, setKnowledgeDocumentId] = useState(rule?.knowledgeDocumentId ?? "");
  const [tones, setTones] = useState<string[]>(rule?.tones ?? []);
  const [linkUrl, setLinkUrl] = useState(rule?.link?.url ?? "");
  const [linkLabel, setLinkLabel] = useState(rule?.link?.label ?? "");
  const [useGeneral, setUseGeneral] = useState(false);
  const [generalRuleId, setGeneralRuleId] = useState(generalRules[0]?.id ?? "");
  const [scopeOpen, setScopeOpen] = useState(() => !(rule?.answerSet ?? seed?.answerSet ?? answerSets[0]));
  const [showAllNeeds, setShowAllNeeds] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedLinkUrl = linkUrl.trim();
  const trimmedLinkLabel = linkLabel.trim();
  // EVERY GENERAL RULE IN THE SET, the ones covering what this rule branches on
  // first and live before draft. Offered whenever a new situation rule is being
  // written — not only when opened from a covered branch, a path nobody finds.
  // DRAFTS ARE LISTED so a general rule just created shows up here, marked,
  // since the agent ignores it until it is put live.
  const coversPicked = (candidate: PolicyRule) =>
    Object.entries(conditions).some(([need, findings]) =>
      findings.some((finding) =>
        Object.entries(candidate.conditions).every(([key, values]) => key === need && values.includes(finding)),
      ),
    );
  const setGeneralRules = useMemo(() => {
    const covers = (candidate: PolicyRule) =>
      Object.entries(conditions).some(([need, findings]) =>
        findings.some((finding) =>
          Object.entries(candidate.conditions).every(([key, values]) => key === need && values.includes(finding)),
        ),
      );
    const rank = (candidate: PolicyRule) =>
      (covers(candidate) ? 0 : 2) + (candidate.approvalStatus === "approved" ? 0 : 1);
    return rules
      .filter((item) => item.answerSet === answerSet && !item.situationKey && !item.isFallback)
      .sort((a, b) => rank(a) - rank(b) || a.answerKey.localeCompare(b.answerKey));
  }, [rules, answerSet, conditions]);
  const chosenIsDraft = (candidate: PolicyRule | null) =>
    Boolean(candidate && candidate.approvalStatus !== "approved");
  const offerGeneral = !rule && Boolean(situationKey) && setGeneralRules.length > 0 && Boolean(onUseGeneralRule);
  const chosenGeneralRule =
    setGeneralRules.find((item) => item.id === generalRuleId) ?? setGeneralRules[0] ?? null;
  const chosenCoversPicked = chosenGeneralRule ? coversPicked(chosenGeneralRule) : false;
  // The branches a general rule is picked for: one per finding picked in « When
  // the agent found ».
  const pickedBranches = Object.entries(conditions).flatMap(([need, findings]) =>
    findings.map((finding) => ({ need, finding })),
  );

  const payload: SaveRulePayload = {
    answerSet: answerSet.trim(),
    answerKey: answerKey.trim(),
    situationKey: situationKey || null,
    conditions,
    answerSkeleton: skeleton || null,
    route: route || null,
    ask,
    offerCode: offerCode || null,
    knowledgeDocumentId: knowledgeDocumentId || null,
    tones,
    link: trimmedLinkUrl || trimmedLinkLabel ? { url: trimmedLinkUrl, label: trimmedLinkLabel } : null,
    priority: rule?.priority ?? 0,
    isFallback: rule?.isFallback ?? false,
  };
  const snapshot = JSON.stringify(payload);
  const [initialSnapshot] = useState(snapshot);
  const dirty = snapshot !== initialSnapshot;

  // CLOSING NEVER DISCARDS WORK SILENTLY. Escape and a backdrop click are the
  // two ways a panel gets closed by accident, and a half-written skeleton is
  // exactly what an accident costs. They close a clean panel and ask on a dirty
  // one; Cancel and Discard are the deliberate ways out.
  const requestCloseRef = useRef<() => void>(() => {});
  useEffect(() => {
    requestCloseRef.current = () => {
      if (saving) return;
      if (dirty) setCloseBlocked(true);
      else onClose();
    };
  });

  useEffect(() => {
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") requestCloseRef.current();
    }
    document.addEventListener("keydown", onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previous;
    };
  }, []);

  const situation = situations.find((item) => item.key === situationKey) ?? null;
  // A GENERAL RULE STARTED FROM A SITUATION'S CANVAS still opens its conditions
  // on that situation's needs: it applies everywhere, but it was written to
  // answer something that situation branches on.
  const contextKey = seed?.contextSituationKey ?? null;
  const contextSituation =
    situation ?? (contextKey ? situations.find((item) => item.key === contextKey) ?? null : null);

  const siblings = useMemo(
    () =>
      rules.filter(
        (item) =>
          item.id !== rule?.id &&
          item.answerSet === answerSet &&
          (situationKey
            ? item.situationKey === situationKey
            : !item.situationKey || (contextSituation !== null && item.situationKey === contextSituation.key)),
      ),
    [rules, rule?.id, answerSet, situationKey, contextSituation],
  );

  const relevant = useMemo(
    () => relevantNeeds(vocabulary, contextSituation, siblings, conditions),
    [vocabulary, contextSituation, siblings, conditions],
  );
  const narrowed = relevant.size > 0 && relevant.size < vocabulary.needs.length;
  const shownNeeds =
    showAllNeeds || !narrowed ? vocabulary.needs : vocabulary.needs.filter(({ need }) => relevant.has(need));
  const tickedCount = Object.values(conditions).reduce((sum, values) => sum + values.length, 0);

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

  // Kept in catalogue order, which is the order the server stores and the prompt
  // renders — so re-picking the same tones never reads as an unsaved change.
  const toggleTone = (key: string) =>
    setTones((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      return vocabulary.tones.map((tone) => tone.key).filter((k) => next.includes(k));
    });

  const chooseRoute = (next: string) => {
    setRoute(next);
    if (next !== "needs_customer_input") setAsk([]);
  };

  // Inserted at the cursor rather than appended: a number belongs mid-sentence.
  const insertParameter = (key: string) => {
    const token = `{${key}}`;
    const element = skeletonRef.current;
    const start = element?.selectionStart ?? skeleton.length;
    const end = element?.selectionEnd ?? start;
    setSkeleton(skeleton.slice(0, start) + token + skeleton.slice(end));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  // Mirrors the constraint rather than only reporting it after a round trip.
  const askWithoutRoute = ask.length > 0 && route !== "needs_customer_input";
  const apologyContradiction = tones.includes("apologetic") && FORBIDS_APOLOGY.test(skeleton);
  // Mirrors the table's two link checks, so the disabled save button explains itself.
  const linkProblem =
    !trimmedLinkUrl && !trimmedLinkLabel
      ? null
      : !isReplyLinkUrl(trimmedLinkUrl)
        ? "Use a full https:// address, with no spaces."
        : !trimmedLinkLabel
          ? "Say what the link opens — the reply is written around it."
          : null;
  const routeOptions = ["", ...vocabulary.routes];

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(payload);
    } catch (caught) {
      setError(knowledgeErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.backdrop} onClick={() => requestCloseRef.current()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.panel}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            <p className={styles.kicker}>{answerSet || "No answer set"}</p>
            <div className={styles.titleRow}>
              <h2 id={titleId} className={styles.title} title={rule?.answerKey}>
                {rule ? ruleLabel(rule) : "New rule"}
              </h2>
              <span className={styles.status} data-live={rule?.approvalStatus === "approved" || undefined}>
                {rule ? (rule.approvalStatus === "approved" ? "live" : "draft") : "new"}
              </span>
            </div>
            <p className={styles.meta}>
              {situation ? (
                <>
                  <b>{situation.key}</b> — {situation.question}
                </>
              ) : contextSituation ? (
                <>
                  General rule — every situation in the set, written from <b>{contextSituation.key}</b>
                </>
              ) : (
                "General rule — every situation in the set"
              )}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            onClick={() => requestCloseRef.current()}
            aria-label="Close the rule editor"
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <details className={styles.recap}>
            <summary>
              <HelpIcon size={15} />
              How a rule is chosen
              <span className={styles.recapChevron} aria-hidden="true">
                <ChevronDownIcon size={15} />
              </span>
            </summary>
            <ol className={styles.recapSteps}>
              {RECAP_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>

          {offerGeneral && (
            <section className={styles.card}>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={useGeneral}
                  onChange={(e) => setUseGeneral(e.target.checked)}
                />
                <span>
                  <b>Use a general rule</b> — general rules apply to every situation in the set, whenever
                  no {situation?.key ?? "situation"} rule matches.
                </span>
              </label>
              {useGeneral && (
                <label className={styles.field}>
                  <span className={styles.label}>General rule</span>
                  <select
                    className={styles.select}
                    value={chosenGeneralRule?.id ?? ""}
                    onChange={(e) => setGeneralRuleId(e.target.value)}
                  >
                    {setGeneralRules.map((item) => (
                      <option key={item.id} value={item.id}>
                        {ruleLabel(item)} — when{" "}
                        {Object.entries(item.conditions)
                          .map(([need, values]) => `${humanise(need)}: ${values.map(humanise).join(" or ")}`)
                          .join("; ") || "anything"}
                        {item.approvalStatus === "approved" ? "" : " · draft, not used until put live"}
                      </option>
                    ))}
                  </select>
                  {pickedBranches.length === 0 && (
                    <span className={styles.warn}>
                      Pick below which finding this general rule is for — that branch then reads « General
                      rule applies » on the diagram.
                    </span>
                  )}
                  <span className={styles.hint}>
                    {chosenIsDraft(chosenGeneralRule)
                      ? chosenCoversPicked
                        ? "Covers what you picked, but it is still a draft: the agent ignores it until you put it live."
                        : "Still a draft: the agent ignores it until you put it live."
                      : chosenCoversPicked
                      ? `Already answers what you picked: the agent uses it whenever no ${situation?.key ?? "situation"} rule matches, and the diagram shows "General rule applies" there.`
                      : tickedCount > 0
                        ? "It applies when its own condition holds — not on the finding you picked, so that branch stays uncovered."
                        : "It applies when its own condition holds, for every situation in the set."}{" "}
                    Nothing is saved. Untick to write a {situation?.key ?? "situation"} rule instead.
                  </span>
                </label>
              )}
            </section>
          )}

          {!useGeneral && (
            <>
              <section className={styles.card}>
                <label className={styles.field}>
                  <span className={styles.label}>Rule key</span>
                  <input
                    className={styles.input}
                    value={answerKey}
                    onChange={(e) => setAnswerKey(e.target.value)}
                    placeholder="annulation_possible"
                  />
                </label>
                <div className={styles.scopeRow}>
                  <span>
                    Applies to <b>{situation ? situation.key : "every situation"}</b> in <b>{answerSet || "—"}</b>
                  </span>
                  <button
                    type="button"
                    className={styles.linkButton}
                    aria-expanded={scopeOpen}
                    onClick={() => setScopeOpen((open) => !open)}
                  >
                    {scopeOpen ? "Done" : "Change"}
                  </button>
                </div>
                {scopeOpen && (
                  <div className={styles.grid2}>
                    <label className={styles.field}>
                      <span className={styles.label}>Answer set</span>
                      <input
                        className={styles.input}
                        value={answerSet}
                        onChange={(e) => setAnswerSet(e.target.value)}
                        list={`${titleId}-sets`}
                      />
                      <datalist id={`${titleId}-sets`}>
                        {answerSets.map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    </label>
                    <label className={styles.field}>
                      <span className={styles.label}>Situation</span>
                      <select
                        className={styles.select}
                        value={situationKey}
                        onChange={(e) => setSituationKey(e.target.value)}
                      >
                        <option value="">General rule — every situation</option>
                        {situations.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.key} — {s.question.slice(0, 70)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </section>
            </>
          )}

          {/* Stays visible with « Use a general rule » ticked: the findings picked
              here name the branches the general rule is picked for. */}
          <section className={styles.card} aria-labelledby={`${titleId}-when`}>
                <header className={styles.cardHead}>
                  <span className={styles.step}>1</span>
                  <div>
                    <h3 id={`${titleId}-when`} className={styles.cardTitle}>
                      When the agent found
                    </h3>
                    <p className={styles.cardHint}>
                      Pick every finding this rule covers — several in one need mean <i>either</i>, across
                      needs they must <i>all</i> hold. Nothing picked: the rule applies whatever was found.
                    </p>
                  </div>
                  <span className={styles.cardAside}>{tickedCount} picked</span>
                </header>

                <div className={styles.needs}>
                  {shownNeeds.map(({ need, findings, poweredBy }) => {
                    const picked = conditions[need] ?? [];
                    const unsetParameter =
                      poweredBy && !vocabulary.parameters.find((p) => p.key === poweredBy)?.set
                        ? poweredBy
                        : null;
                    return (
                      <div key={need} className={styles.need}>
                        <div className={styles.needHead}>
                          <span className={styles.needName} title={need}>
                            {humanise(need)}
                          </span>
                          {picked.length > 0 && <span className={styles.needCount}>{picked.length} picked</span>}
                          {/* A state computed from a number nobody has set can never
                              resolve, and a rule branching on it would never fire.
                              Saying so here is cheaper than finding out from a transcript. */}
                          {unsetParameter && (
                            <span className={styles.blocked}>
                              needs <b>{unsetParameter}</b>, which is not set — cannot fire yet
                            </span>
                          )}
                        </div>
                        <div className={styles.chips}>
                          {findings.map((finding) => {
                            const on = picked.includes(finding);
                            return (
                              <label key={finding} className={styles.chip} data-on={on || undefined} title={finding}>
                                <input
                                  type="checkbox"
                                  className={styles.srOnly}
                                  checked={on}
                                  onChange={() => toggle(need, finding)}
                                />
                                {humanise(finding)}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {narrowed && (
                  <button type="button" className={styles.linkButton} onClick={() => setShowAllNeeds((all) => !all)}>
                    {showAllNeeds
                      ? "Show only this situation's needs"
                      : `Show all ${vocabulary.needs.length} needs`}
                  </button>
                )}
              </section>

          {!useGeneral && (
            <>
              <section className={styles.card} aria-labelledby={`${titleId}-then`}>
                <header className={styles.cardHead}>
                  <span className={styles.step}>2</span>
                  <div>
                    <h3 id={`${titleId}-then`} className={styles.cardTitle}>
                      Then
                    </h3>
                    <p className={styles.cardHint}>Where the ticket goes once this rule wins.</p>
                  </div>
                </header>

                <div className={styles.segmented} role="radiogroup" aria-labelledby={`${titleId}-then`}>
                  {routeOptions.map((option) => {
                    const copy = ROUTE_COPY[option];
                    const on = route === option;
                    return (
                      <label key={option || "none"} className={styles.segment} data-on={on || undefined}>
                        <input
                          type="radio"
                          name={`${titleId}-route`}
                          className={styles.srOnly}
                          checked={on}
                          onChange={() => chooseRoute(option)}
                        />
                        <span className={styles.segmentLabel}>{copy?.label ?? humanise(option)}</span>
                        <span className={styles.segmentHint}>{copy?.hint ?? option}</span>
                      </label>
                    );
                  })}
                </div>

                {/* A LIST, since a rule may ask for more than one thing. A reaction
                    reported with no product named needs the product AND the batch
                    number, and one slot forced that into two round trips. */}
                {route === "needs_customer_input" && (
                  <div className={styles.field}>
                    <span className={styles.label}>Ask the customer for</span>
                    <div className={styles.chips}>
                      {vocabulary.asks.map((a) => {
                        const on = ask.includes(a);
                        return (
                          <label key={a} className={styles.chip} data-on={on || undefined} title={a}>
                            <input
                              type="checkbox"
                              className={styles.srOnly}
                              checked={on}
                              onChange={() => toggleAsk(a)}
                            />
                            {humanise(a)}
                          </label>
                        );
                      })}
                    </div>
                    <p className={styles.hint}>
                      The agent words each question itself, and skips any the dossier already answers.
                    </p>
                  </div>
                )}
              </section>

              <section className={styles.card} aria-labelledby={`${titleId}-reply`}>
                <header className={styles.cardHead}>
                  <span className={styles.step}>3</span>
                  <div>
                    <h3 id={`${titleId}-reply`} className={styles.cardTitle}>
                      Reply
                    </h3>
                    <p className={styles.cardHint}>
                      Guidance for the drafting agent — never sent as written.
                    </p>
                  </div>
                </header>

                <label className={styles.field}>
                  <span className={styles.label}>What the reply should do</span>
                  <textarea
                    ref={skeletonRef}
                    className={styles.textarea}
                    rows={5}
                    value={skeleton}
                    onChange={(e) => setSkeleton(e.target.value)}
                    placeholder="La commande n'est pas encore partie : l'annulation est encore possible…"
                  />
                </label>

                {/* THE ONE PLACE A RULE NAMES A PARAMETER DIRECTLY. A condition uses the
                    state a number computes; this quotes the number itself. Inserted as a
                    placeholder rather than typed, so changing 30 to 21 changes every
                    skeleton that says it — the whole reason the number is held once. */}
                {vocabulary.parameters.length > 0 && (
                  <div className={styles.tokens}>
                    <span className={styles.tokensLabel}>Insert a number</span>
                    {vocabulary.parameters.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        className={styles.token}
                        title={p.set ? p.label : `${p.label} — not set yet`}
                        data-unset={!p.set || undefined}
                        onClick={() => insertParameter(p.key)}
                      >
                        {p.key}
                        {!p.set && <span className={styles.tokenWarn}>unset</span>}
                      </button>
                    ))}
                  </div>
                )}
                <p className={styles.hint}>
                  Describe what to do with facts the dossier holds, never a fact it may not. A skeleton
                  quoting a parameter nobody has set is dropped, and the reply is written from the facts
                  alone.
                </p>

                {/* THE TONE, PER RULE. Several may be picked, and an email asking two
                    things gets the tones of both requests' rules. The catalogue and
                    its French wording live in `scripts/lib/reply-tones.mjs`. */}
                {vocabulary.tones.length > 0 && (
                  <div className={styles.field}>
                    <span className={styles.label} id={`${titleId}-tone`}>
                      Tone
                    </span>
                    <div className={styles.chips} role="group" aria-labelledby={`${titleId}-tone`}>
                      {vocabulary.tones.map((tone) => {
                        const on = tones.includes(tone.key);
                        return (
                          <label key={tone.key} className={styles.chip} data-on={on || undefined} title={tone.hint}>
                            <input
                              type="checkbox"
                              className={styles.srOnly}
                              checked={on}
                              onChange={() => toggleTone(tone.key)}
                            />
                            {tone.label}
                          </label>
                        );
                      })}
                    </div>
                    <p className={styles.hint}>
                      {tones.length === 0
                        ? "None picked: the reply takes the Brand voice alone."
                        : "Adjusts the Brand voice for this case, never its rules. When an email asks two things, both rules' tones are combined."}
                    </p>
                    {apologyContradiction && (
                      <p className={styles.warn}>
                        The guidance says not to apologise, and Apologetic is picked — the drafting agent
                        would be given both instructions.
                      </p>
                    )}
                  </div>
                )}

                {/* A LINK, AND THE MODEL NEVER SEES THE ADDRESS. It is given what the
                    link opens and writes « cliquez [[ici]] … »; the address is put on
                    the marked word wherever the draft is shown. Typed per rule, https
                    only — see `scripts/lib/reply-link.mjs`. */}
                <div className={styles.field}>
                  <span className={styles.label}>Link</span>
                  <div className={styles.grid2}>
                    <label className={styles.field}>
                      <span className={styles.hint}>Address</span>
                      <input
                        className={styles.input}
                        type="url"
                        inputMode="url"
                        value={linkUrl}
                        onChange={(e) => setLinkUrl(e.target.value)}
                        placeholder="https://…"
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.hint}>What it opens</span>
                      <input
                        className={styles.input}
                        value={linkLabel}
                        onChange={(e) => setLinkLabel(e.target.value)}
                        maxLength={120}
                        placeholder="le guide d'utilisation"
                      />
                    </label>
                  </div>
                  {!linkProblem && trimmedLinkUrl ? (
                    <p className={styles.linkPreview}>
                      In the draft: « cliquez{" "}
                      <a href={trimmedLinkUrl} target="_blank" rel="noreferrer">
                        ici
                      </a>{" "}
                      pour consulter {trimmedLinkLabel} »
                    </p>
                  ) : (
                    <p className={styles.hint}>
                      Optional. The drafting agent is given only what it opens and writes a « click here »
                      sentence; the address goes on « here » wherever the draft is shown.
                    </p>
                  )}
                  {linkProblem && <p className={styles.warn}>{linkProblem}</p>}
                </div>

                <div className={styles.grid2}>
                  {/* A PICKER, NEVER A TEXT BOX. A typed code is a key, and a mistyped one
                      reaches a customer looking exactly like a real one. The list is what
                      an operator cleared on the Promotions screen, so a partner's rate
                      cannot be reached from here at all. */}
                  {vocabulary.offerableCodes.length > 0 && (
                    <label className={styles.field}>
                      <span className={styles.label}>Give the customer a code</span>
                      <select className={styles.select} value={offerCode} onChange={(e) => setOfferCode(e.target.value)}>
                        <option value="">No code</option>
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
                        Reproduced exactly. Dropped from the reply if it stops being offerable.
                      </span>
                    </label>
                  )}

                  {/* THE ARTICLE THIS RULE ANSWERS FROM. Only what is approved — a rule
                      pinning a draft article would be dropped at drafting time and look,
                      from here, as though it worked. */}
                  {vocabulary.articles.length > 0 && (
                    <label className={styles.field}>
                      <span className={styles.label}>Answer from an article</span>
                      <select
                        className={styles.select}
                        value={knowledgeDocumentId}
                        onChange={(e) => setKnowledgeDocumentId(e.target.value)}
                      >
                        <option value="">Whatever retrieval finds</option>
                        {vocabulary.articles.map((article) => (
                          <option key={article.id} value={article.id}>
                            {article.title}
                            {article.category ? ` — ${article.category}` : ""}
                          </option>
                        ))}
                      </select>
                      <span className={styles.hint}>
                        Dropped rather than quoted if it stops being approved.
                      </span>
                    </label>
                  )}
                </div>
              </section>
            </>
          )}
        </div>

        <footer className={styles.footer}>
          <div className={styles.footerText}>
            {closeBlocked ? (
              <div className={styles.discard} role="alert">
                <span>You have unsaved changes.</span>
                <Button variant="secondary" size="sm" onClick={onClose}>
                  Discard
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setCloseBlocked(false)}>
                  Keep editing
                </Button>
              </div>
            ) : useGeneral ? (
              <p className={styles.note}>
                Nothing is saved — the general rule already applies here.
              </p>
            ) : (
              <p className={styles.note}>
                Saves as a <b>draft</b>. Real mail is untouched until you put it live.
              </p>
            )}
            {!useGeneral && askWithoutRoute && (
              <p className={styles.warn}>A rule that asks for something must also send the ticket to the customer.</p>
            )}
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
          </div>
          <div className={styles.actions}>
            <Button variant="secondary" size="sm" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            {useGeneral ? (
              <Button
                variant="primary"
                size="sm"
                disabled={!chosenGeneralRule || pickedBranches.length === 0}
                onClick={() => chosenGeneralRule && onUseGeneralRule?.(chosenGeneralRule, pickedBranches)}
              >
                Use general rule
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={saving || !payload.answerKey || !payload.answerSet || askWithoutRoute || Boolean(linkProblem)}
                onClick={save}
              >
                {saving ? "Saving…" : "Save as draft"}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * The needs worth opening on: what the situation declares, what its other rules
 * branch on, what this rule already names, and everything those require first.
 */
function relevantNeeds(
  vocabulary: PolicyVocabulary,
  situation: PolicySituation | null,
  siblings: PolicyRule[],
  conditions: Record<string, string[]>,
): Set<string> {
  const known = new Map(vocabulary.needs.map((need) => [need.need, need]));
  const out = new Set<string>();
  const visit = (need: string) => {
    const meta = known.get(need);
    if (!meta || out.has(need)) return;
    out.add(need);
    for (const prerequisite of meta.requires) visit(prerequisite);
  };
  for (const need of situation?.requirementNeeds ?? []) visit(need);
  for (const sibling of siblings) for (const need of Object.keys(sibling.conditions)) visit(need);
  for (const need of Object.keys(conditions)) visit(need);
  return out;
}

function humanise(key: string): string {
  const spaced = key.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
