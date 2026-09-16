"use client";

import { useEffect, useMemo, useState } from "react";

import { AlertIcon, CheckCircleIcon, DotIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { deleteRule, saveRule, setCollectionMode, setRuleApproval } from "@/lib/api/policy";
import {
  branchChoiceKey,
  loadGeneralRuleChoices,
  saveGeneralRuleChoices,
} from "@/lib/general-rule-choices";
import type { GeneralRuleChoices } from "@/lib/general-rule-choices";
import { generalRulesCovering, ruleLabel } from "@/lib/rule-labels";
import type { PolicyRule, PolicySituation, PolicyVocabulary } from "@/lib/types";

import { RuleEditor } from "./RuleEditor";
import type { RuleEditorSeed } from "./RuleEditor";
import styles from "./RuleBook.module.css";

const SHARED = "__shared__";

/**
 * `general` is a branch no rule of this situation answers but a general rule
 * does — either because its conditions cover it (what the agent uses) or because
 * it was picked for it in the editor (shown, with a note when the agent would
 * not use it there). Not a gap either way.
 */
type BranchStatus = "covered" | "general" | "missing" | "prerequisite";

interface BranchValue {
  finding: string;
  rules: PolicyRule[];
  /** The live general rules that answer this branch when no situation rule does. */
  generalRules: PolicyRule[];
  /** The general rule picked for this branch in « Use a general rule », if any. */
  chosenRule: PolicyRule | null;
  status: BranchStatus;
  continues: boolean;
}

interface WorkflowNeed {
  need: string;
  findings: string[];
  requires: string[];
  isPrerequisiteOnly: boolean;
  branches: BranchValue[];
}

interface EditorState {
  rule: PolicyRule | null;
  seed?: RuleEditorSeed;
  /** General rules already answering the branch this editor was opened from. */
  generalRules?: PolicyRule[];
}

/**
 * The rulebook as a workflow projection.
 *
 * The backend is still NOT a first-match tree: `selectAnswer` ranks by situation,
 * then condition specificity, then priority. This screen makes that relation
 * readable by situation without making visual order part of runtime behaviour.
 */
export function RuleBook({
  initialRules,
  situations,
  vocabulary,
  loadError,
}: {
  initialRules: PolicyRule[];
  situations: PolicySituation[];
  vocabulary: PolicyVocabulary;
  loadError: string | null;
}) {
  const startingAnswerSet =
    initialRules[0]?.answerSet ?? situations.find((situation) => situation.answerSet)?.answerSet ?? "";
  const startingSituation =
    situations.find((situation) => situation.answerSet === startingAnswerSet)?.key ?? SHARED;

  const [rules, setRules] = useState<PolicyRule[]>(initialRules);
  const [modes, setModes] = useState<Record<string, string>>(() =>
    Object.fromEntries(situations.map((situation) => [situation.key, situation.collectionMode])),
  );
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answerSet, setAnswerSet] = useState(startingAnswerSet);
  const [activeSituation, setActiveSituation] = useState<string>(startingSituation);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(initialRules[0]?.id ?? null);
  // The general rule picked per branch in the editor, kept in this browser.
  // Read after mount: storage does not exist during the server render.
  const [generalChoices, setGeneralChoices] = useState<GeneralRuleChoices>({});
  useEffect(() => {
    setGeneralChoices(loadGeneralRuleChoices());
  }, []);

  function updateGeneralChoices(change: (next: GeneralRuleChoices) => void) {
    setGeneralChoices((prev) => {
      const next = { ...prev };
      change(next);
      saveGeneralRuleChoices(next);
      return next;
    });
  }

  const ruleCountsBySet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rule of rules) counts.set(rule.answerSet, (counts.get(rule.answerSet) ?? 0) + 1);
    return counts;
  }, [rules]);

  const answerSets = useMemo(() => {
    const names = new Set<string>();
    for (const rule of rules) names.add(rule.answerSet);
    for (const situation of situations) if (situation.answerSet) names.add(situation.answerSet);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [rules, situations]);

  useEffect(() => {
    if (answerSet && answerSets.includes(answerSet)) return;
    setAnswerSet(answerSets[0] ?? "");
  }, [answerSet, answerSets]);

  const rulesInSet = useMemo(
    () => rules.filter((rule) => rule.answerSet === answerSet).sort(sortRuleForWorkflow),
    [rules, answerSet],
  );

  const situationsForSet = useMemo(() => {
    const namedInRules = new Set(rulesInSet.map((rule) => rule.situationKey).filter(Boolean));
    return situations
      .filter((situation) => situation.answerSet === answerSet || namedInRules.has(situation.key))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [rulesInSet, situations, answerSet]);

  useEffect(() => {
    if (activeSituation === SHARED) return;
    if (situationsForSet.some((situation) => situation.key === activeSituation)) return;
    setActiveSituation(situationsForSet[0]?.key ?? SHARED);
  }, [activeSituation, situationsForSet]);

  const activeSituationMeta = situationsForSet.find((situation) => situation.key === activeSituation) ?? null;
  const selectedSituationKey = activeSituation === SHARED ? null : activeSituation;

  const visibleRules = useMemo(
    () =>
      selectedSituationKey
        ? rulesInSet.filter((rule) => !rule.situationKey || rule.situationKey === selectedSituationKey)
        : rulesInSet.filter((rule) => !rule.situationKey),
    [rulesInSet, selectedSituationKey],
  );

  const specificRuleCount = visibleRules.filter((rule) => rule.situationKey).length;
  const sharedRuleCount = visibleRules.length - specificRuleCount;
  const liveCount = rules.filter((rule) => rule.approvalStatus === "approved").length;

  // id -> title, so the inspector can name the pinned article rather than print
  // a uuid. Built from the vocabulary the editor already offers pins from, so a
  // rule pointing at an article that has since been unapproved shows no title —
  // which is the same thing drafting does with it.
  const articleTitles = useMemo(
    () => new Map(vocabulary.articles.map((article) => [article.id, article.title])),
    [vocabulary.articles],
  );

  // key -> label, so the inspector names a tone the way the editor offers it.
  const toneLabels = useMemo(
    () => new Map(vocabulary.tones.map((tone) => [tone.key, tone.label])),
    [vocabulary.tones],
  );

  const workflow = useMemo(
    () =>
      buildWorkflow(visibleRules, vocabulary, selectedSituationKey, (need, finding) =>
        selectedSituationKey
          ? generalChoices[branchChoiceKey(answerSet, selectedSituationKey, need, finding)] ?? null
          : null,
      ),
    [visibleRules, vocabulary, selectedSituationKey, generalChoices, answerSet],
  );

  const selectedRule = selectedRuleId
    ? visibleRules.find((rule) => rule.id === selectedRuleId) ?? null
    : null;

  useEffect(() => {
    if (!selectedRuleId || visibleRules.some((rule) => rule.id === selectedRuleId)) return;
    setSelectedRuleId(visibleRules[0]?.id ?? null);
  }, [selectedRuleId, visibleRules]);

  async function run(id: string, work: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(knowledgeErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function openNewRule(seed: RuleEditorSeed = {}, generalRules: PolicyRule[] = []) {
    setEditing({
      rule: null,
      seed: {
        answerSet,
        situationKey: selectedSituationKey,
        ...seed,
      },
      generalRules,
    });
  }

  async function toggleCollectionMode(key: string) {
    const next = modes[key] === "rule_directed" ? "model" : "rule_directed";
    await run(`mode:${key}`, async () => {
      await setCollectionMode(key, next);
      setModes((prev) => ({ ...prev, [key]: next }));
    });
  }

  async function approve(rule: PolicyRule) {
    await run(rule.id, async () => {
      const updated = await setRuleApproval(rule.id, rule.approvalStatus !== "approved");
      setRules((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setSelectedRuleId(updated.id);
    });
  }

  async function remove(rule: PolicyRule) {
    await run(rule.id, async () => {
      await deleteRule(rule.id);
      setRules((prev) => prev.filter((item) => item.id !== rule.id));
      setSelectedRuleId(null);
    });
  }

  const ruleButton = (rule: PolicyRule) => (
    <button
      key={rule.id}
      type="button"
      className={selectedRuleId === rule.id ? styles.outcomeOn : styles.outcomeButton}
      onClick={() => setSelectedRuleId(rule.id)}
      title={rule.answerKey}
    >
      <span className={styles.outcomeKey}>{ruleLabel(rule)}</span>
      <span className={styles.outcomeAction}>{actionSummary(rule)}</span>
    </button>
  );

  return (
    <section className={styles.wrap}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.title}>Rule workflows</h2>
          <p className={styles.lede}>
            Pick a situation and review the branches the agent can take. The canvas shows the
            decision shape; the agent still applies the approved rules by situation and specificity.
          </p>
        </div>
        <div className={styles.headActions}>
          <span className={styles.count}>
            {liveCount} live of {rules.length}
          </span>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<PlusIcon size={15} />}
            onClick={() => openNewRule()}
          >
            New rule
          </Button>
        </div>
      </header>

      {loadError && <p className={styles.error}>{loadError}</p>}
      {error && <p className={styles.error}>{error}</p>}

      {answerSets.length === 0 && !loadError ? (
        <p className={styles.empty}>
          No rules yet. The agent behaves exactly as it did before any of this existed.
        </p>
      ) : (
        <div className={styles.workspace}>
          <aside className={styles.rail} aria-label="Situations">
            <div className={styles.railBlock}>
              <p className={styles.railLabel}>Answer set</p>
              <div className={styles.setList} role="list">
                {answerSets.map((setName) => (
                  <button
                    key={setName}
                    type="button"
                    className={answerSet === setName ? styles.setButtonOn : styles.setButton}
                    onClick={() => {
                      setAnswerSet(setName);
                      setSelectedRuleId(null);
                    }}
                  >
                    <span>{setName}</span>
                    <span className={styles.badge}>{ruleCountsBySet.get(setName) ?? 0}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.railBlock}>
              <p className={styles.railLabel}>Situation</p>
              <button
                type="button"
                className={activeSituation === SHARED ? styles.situationOn : styles.situationButton}
                onClick={() => {
                  setActiveSituation(SHARED);
                  setSelectedRuleId(null);
                }}
              >
                <span className={styles.situationKey}>General rules</span>
                <span className={styles.situationQuestion}>Apply to every situation in the set</span>
              </button>
              {situationsForSet.map((situation) => {
                const count = rulesInSet.filter((rule) => rule.situationKey === situation.key).length;
                return (
                  <button
                    key={situation.key}
                    type="button"
                    className={activeSituation === situation.key ? styles.situationOn : styles.situationButton}
                    onClick={() => {
                      setActiveSituation(situation.key);
                      setSelectedRuleId(null);
                    }}
                  >
                    <span className={styles.situationLine}>
                      <span className={styles.situationKey}>{situation.key}</span>
                      <span className={styles.badge}>{count}</span>
                    </span>
                    <span className={styles.situationQuestion}>{situation.question}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className={styles.canvas} aria-label="Rule workflow canvas">
            <div className={styles.canvasTop}>
              <div>
                <p className={styles.canvasKicker}>{answerSet || "No answer set"}</p>
                <h3 className={styles.canvasTitle}>
                  {activeSituationMeta ? activeSituationMeta.key : "General rules"}
                </h3>
                <p className={styles.canvasMeta}>
                  {activeSituationMeta?.question ??
                    "Rules for every situation in the set. They apply whenever no situation rule matches."}
                </p>
              </div>
              <div className={styles.canvasStats} aria-label="Workflow summary">
                <span>{specificRuleCount} situation rules</span>
                <span>{sharedRuleCount} general</span>
                <span>{workflow.missingBranches} gaps</span>
                {/* WHO DECIDES WHAT GETS COLLECTED for this situation. `model`
                    is today's behaviour: the deterministic opening moves run and
                    the model chooses the rest. `rule_directed` additionally lets
                    these rules propose the next fact to establish — it may ADD
                    and REORDER calls, never remove one.

                    Set per situation and never inferred from rule count: a set
                    with three of eight rules approved converges FASTER than a
                    complete one, so counting rules would rate it readiest exactly
                    when it is least ready. Run
                    `npm run report:collection-planner` to see what it would
                    collect here before switching it on. */}
                {activeSituationMeta && (
                  <button
                    type="button"
                    className={styles.modeToggle}
                    disabled={busy === `mode:${activeSituationMeta.key}`}
                    onClick={() => toggleCollectionMode(activeSituationMeta.key)}
                  >
                    {modes[activeSituationMeta.key] === "rule_directed"
                      ? "rules collect"
                      : "model collects"}
                  </button>
                )}
              </div>
            </div>

            <div className={styles.flow}>
              <div className={styles.rootNode}>
                <span className={styles.nodeIcon}>
                  <DotIcon size={14} />
                </span>
                <div>
                  <p className={styles.nodeLabel}>Start</p>
                  <h4>{activeSituationMeta ? activeSituationMeta.question : "Any matched request in this set"}</h4>
                </div>
              </div>

              {workflow.needs.length === 0 ? (
                <div className={styles.noBranches}>
                  <p>No evidence branches are defined here yet.</p>
                  <Button size="sm" variant="secondary" onClick={() => openNewRule()}>
                    Add first branch
                  </Button>
                </div>
              ) : (
                workflow.needs.map((need, index) => (
                  <section key={need.need} className={styles.decisionStep}>
                    <div className={styles.connector} aria-hidden="true" />
                    <div className={styles.decisionNode}>
                      <header className={styles.nodeHeader}>
                        <div>
                          <p className={styles.nodeLabel}>Decision {index + 1}</p>
                          <h4>{labelNeed(need.need)}</h4>
                        </div>
                        {need.isPrerequisiteOnly ? (
                          <span className={styles.prereqTag}>required first</span>
                        ) : (
                          <span className={styles.coverageTag}>{coveredCount(need)} / {need.findings.length}</span>
                        )}
                      </header>

                      {need.requires.length > 0 && (
                        <p className={styles.requires}>Requires {need.requires.map(labelNeed).join(", ")}</p>
                      )}

                      {need.isPrerequisiteOnly ? (
                        <p className={styles.prereqText}>
                          Later branches depend on this fact, so the agent has to establish it before
                          the deeper answer can be selected.
                        </p>
                      ) : (
                        <div className={styles.branches}>
                          {need.branches.map((branch) => (
                            <div key={branch.finding} className={styles.branch}>
                              <div className={styles.branchHead}>
                                <span className={styles.branchFinding}>{branch.finding}</span>
                                <BranchStatusIcon status={branch.status} />
                              </div>
                              {branch.rules.length > 0 ? (
                                <div className={styles.outcomes}>{branch.rules.map(ruleButton)}</div>
                              ) : branch.continues ? (
                                <p className={styles.continues}>Continues to a deeper decision.</p>
                              ) : branch.generalRules.length > 0 || branch.chosenRule ? (
                                // NOT A GAP. No rule of this situation answers the
                                // branch; a general rule does — because its
                                // conditions cover it, or because it was picked for
                                // it in the editor. A pick the agent would not act
                                // on says so. Writing a situation rule is still
                                // offered, because it would win.
                                <div className={styles.generalBox}>
                                  <span className={styles.generalLabel}>General rule applies</span>
                                  <div className={styles.outcomes}>
                                    {branch.generalRules.map(ruleButton)}
                                    {branch.chosenRule &&
                                      !branch.generalRules.includes(branch.chosenRule) &&
                                      ruleButton(branch.chosenRule)}
                                  </div>
                                  {branch.chosenRule && chosenRuleNote(branch.chosenRule, need.need, branch.finding) && (
                                    <p className={styles.generalWarn}>
                                      {chosenRuleNote(branch.chosenRule, need.need, branch.finding)}
                                    </p>
                                  )}
                                  <div className={styles.generalActions}>
                                    <button
                                      type="button"
                                      className={styles.generalAdd}
                                      onClick={() =>
                                        openNewRule(
                                          { conditions: { [need.need]: [branch.finding] } },
                                          branch.generalRules,
                                        )
                                      }
                                    >
                                      Write a {activeSituationMeta?.key ?? "situation"} rule instead
                                    </button>
                                    {branch.chosenRule && (
                                      <button
                                        type="button"
                                        className={styles.generalAdd}
                                        onClick={() =>
                                          updateGeneralChoices((next) => {
                                            delete next[
                                              branchChoiceKey(answerSet, selectedSituationKey ?? "", need.need, branch.finding)
                                            ];
                                          })
                                        }
                                      >
                                        Unpick
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className={styles.missingButton}
                                  onClick={() =>
                                    openNewRule({
                                      conditions: { [need.need]: [branch.finding] },
                                    })
                                  }
                                >
                                  Add branch
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                ))
              )}

              {/* ALWAYS SHOWN ON A SITUATION, even with no general rule yet, since
                  this is where one is created. A general rule has no situation —
                  that is what makes it general — so the one written here applies
                  to the whole set; the editor only opens its conditions on this
                  situation's needs, because that is what it was started for. */}
              {selectedSituationKey && (
                <section className={styles.decisionStep}>
                  <div className={styles.connector} aria-hidden="true" />
                  <div className={styles.decisionNode}>
                    <header className={styles.nodeHeader}>
                      <div>
                        <p className={styles.nodeLabel}>General rules</p>
                        <h4>Apply when no {activeSituationMeta?.key ?? "situation"} rule matches</h4>
                        <p className={styles.requires}>
                          They cover every situation in the set, and lose to the rules above whenever one
                          of those matches — a situation outranks condition depth.
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        leadingIcon={<PlusIcon size={14} />}
                        onClick={() => openNewRule({ situationKey: null, contextSituationKey: selectedSituationKey })}
                      >
                        Create a general rule
                      </Button>
                    </header>
                    {workflow.sharedRules.length > 0 ? (
                      <div className={styles.outcomes}>{workflow.sharedRules.map(ruleButton)}</div>
                    ) : (
                      <p className={styles.requires}>No general rules in {answerSet} yet.</p>
                    )}
                  </div>
                </section>
              )}

              {workflow.conditionlessRules.length > 0 && (
                <section className={styles.decisionStep}>
                  <div className={styles.connector} aria-hidden="true" />
                  <div className={styles.decisionNode}>
                    <header className={styles.nodeHeader}>
                      <div>
                        <p className={styles.nodeLabel}>Fallback lane</p>
                        <h4>Rules without evidence conditions</h4>
                      </div>
                    </header>
                    <div className={styles.outcomes}>{workflow.conditionlessRules.map(ruleButton)}</div>
                  </div>
                </section>
              )}
            </div>
          </main>

          <aside className={styles.inspector} aria-label="Selected rule">
            {selectedRule ? (
              <RuleInspector
                // Keyed by rule, so a half-open delete confirmation never carries
                // over to the next rule selected.
                key={selectedRule.id}
                rule={selectedRule}
                toneLabel={selectedRule.tones.map((key) => toneLabels.get(key) ?? key).join(", ")}
                articleTitle={
                  selectedRule.knowledgeDocumentId
                    ? articleTitles.get(selectedRule.knowledgeDocumentId) ?? null
                    : null
                }
                busy={busy === selectedRule.id}
                onEdit={() => setEditing({ rule: selectedRule })}
                onApprove={() => approve(selectedRule)}
                onDelete={() => remove(selectedRule)}
              />
            ) : (
              <div className={styles.inspectorEmpty}>
                <p className={styles.inspectorLabel}>Inspector</p>
                <h3>Select a rule or missing branch</h3>
                <p>
                  The inspector keeps edits tied to one outcome. Missing branches can be added from
                  the canvas with the situation and condition already filled in.
                </p>
              </div>
            )}
          </aside>
        </div>
      )}

      {editing && (
        <RuleEditor
          rule={editing.rule}
          seed={editing.seed}
          answerSets={answerSets}
          situations={situations}
          rules={rules}
          vocabulary={vocabulary}
          generalRules={editing.generalRules ?? []}
          onUseGeneralRule={(rule, branches) => {
            // Recorded for the canvas in this browser, never sent to the agent
            // (lib/general-rule-choices.ts): each picked branch now reads
            // « General rule applies » with this rule.
            updateGeneralChoices((next) => {
              for (const { need, finding } of branches) {
                next[branchChoiceKey(answerSet, selectedSituationKey ?? "", need, finding)] = rule.answerKey;
              }
            });
            setSelectedRuleId(rule.id);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            const saved = await saveRule(payload);
            setRules((prev) => {
              const without = prev.filter((rule) => rule.id !== saved.id);
              return [...without, saved];
            });
            setSelectedRuleId(saved.id);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function RuleInspector({
  rule,
  toneLabel,
  articleTitle,
  busy,
  onEdit,
  onApprove,
  onDelete,
}: {
  rule: PolicyRule;
  /** The rule's tones as the editor labels them, or "" for the Brand voice alone. */
  toneLabel: string;
  articleTitle: string | null;
  busy: boolean;
  onEdit: () => void;
  onApprove: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={styles.inspectorBody}>
      <div className={styles.inspectorHead}>
        <div>
          <p className={styles.inspectorLabel}>{rule.situationKey ? "Selected rule" : "General rule"}</p>
          <h3 title={rule.answerKey}>{ruleLabel(rule)}</h3>
        </div>
        <span className={rule.approvalStatus === "approved" ? styles.liveTag : styles.draftTag}>
          {rule.approvalStatus === "approved" ? "live" : "draft"}
        </span>
      </div>

      <dl className={styles.ruleFacts}>
        <div>
          <dt>Situation</dt>
          <dd>{rule.situationKey ?? "Every situation in the set"}</dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>{conditionSummary(rule)}</dd>
        </div>
        <div>
          <dt>Then</dt>
          <dd>{actionSummary(rule)}</dd>
        </div>
        {toneLabel && (
          <div>
            <dt>Tone</dt>
            <dd>{toneLabel}</dd>
          </div>
        )}
        {rule.link && (
          <div>
            <dt>Link</dt>
            <dd>
              <a href={rule.link.url} target="_blank" rel="noreferrer">
                {rule.link.label}
              </a>
            </dd>
          </div>
        )}
        {rule.offerCode && (
          <div>
            <dt>Code</dt>
            <dd>{rule.offerCode}</dd>
          </div>
        )}
        {rule.knowledgeDocumentId && (
          <div>
            <dt>Article</dt>
            {/* No title means the pin points at something no longer approved.
                Saying so beats printing a uuid: it is the same rule drafting
                applies, surfaced where it can be fixed. */}
            <dd>{articleTitle ?? "linked article is no longer approved"}</dd>
          </div>
        )}
      </dl>

      {rule.answerSkeleton && <p className={styles.skeleton}>{rule.answerSkeleton}</p>}

      <div className={styles.inspectorActions}>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onApprove}>
          {rule.approvalStatus === "approved" ? "Take off live mail" : "Put live"}
        </Button>
        <DeleteRuleButton rule={rule} busy={busy} onDelete={onDelete} />
      </div>
    </div>
  );
}

/**
 * Delete, asked twice.
 *
 * THE DELETE IS A HARD DELETE with no undo, and one click on it removed
 * `expediee_sans_scan` — the general rule answering 97% of shipped orders — on
 * 2026-09-15, found only because D-01's canvas showed a hole. So the first click
 * says what goes and what depends on it, and only the second one deletes.
 */
function DeleteRuleButton({
  rule,
  busy,
  onDelete,
}: {
  rule: PolicyRule;
  busy: boolean;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
        Delete
      </Button>
    );
  }

  return (
    <div className={styles.deleteConfirm} role="alertdialog" aria-label={`Delete ${ruleLabel(rule)}`}>
      <p>
        <b>Delete {ruleLabel(rule)}?</b> It is removed permanently — there is no undo.{" "}
        {!rule.situationKey
          ? "It is a general rule: every situation in this set without its own rule for this case falls back to it, and would be left with none."
          : rule.approvalStatus === "approved"
            ? "It is live: the tickets it answers go to a person until another rule covers them."
            : ""}
      </p>
      <div className={styles.inspectorActions}>
        <Button variant="primary" size="sm" disabled={busy} onClick={onDelete}>
          Delete permanently
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </div>
    </div>
  );
}

function BranchStatusIcon({ status }: { status: BranchStatus }) {
  if (status === "covered") {
    return (
      <span className={styles.branchCovered} title="Covered">
        <CheckCircleIcon size={14} />
      </span>
    );
  }
  if (status === "general") {
    return (
      <span className={styles.branchGeneral} title="Covered by a general rule">
        <CheckCircleIcon size={14} />
      </span>
    );
  }
  if (status === "missing") {
    return (
      <span className={styles.branchMissing} title="Missing branch">
        <AlertIcon size={14} />
      </span>
    );
  }
  return null;
}

/**
 * What to say under a general rule PICKED for a branch that the agent would not
 * use there, or null when it would. The pick drives the box; this keeps the box
 * from claiming a coverage the runtime does not apply.
 */
function chosenRuleNote(rule: PolicyRule, need: string, finding: string): string | null {
  const covers = Object.entries(rule.conditions).every(([key, values]) => key === need && values.includes(finding));
  const live = rule.approvalStatus === "approved";
  if (covers && live) return null;
  if (covers) return "Picked here — the agent uses it once it is put live.";
  return `Picked here, but the agent only uses ${ruleLabel(rule)} when ${conditionSummary(rule)}${
    live ? "" : ", and only once it is live"
  }.`;
}

function buildWorkflow(
  rules: PolicyRule[],
  vocabulary: PolicyVocabulary,
  situationKey: string | null = null,
  // The rule KEY picked for a branch in « Use a general rule », or null.
  chosenFor: (need: string, finding: string) => string | null = () => null,
) {
  // A SITUATION'S DECISIONS ARE ITS OWN. The set's situation-less rules still
  // apply at runtime, but they cannot win here: `selectAnswer` ranks situation
  // above condition depth, so a rule keyed to this situation always outranks a
  // shared one. Building the decision list from both put `order_state` and
  // `delivery_state` on D-33 — a pure shipping-policy question that branches on
  // nothing but `policy_answer` — and dragged `order_identity` in behind them as
  // a prerequisite. Three decisions the reader cannot act on and no rule here
  // reads. They keep their own lane below instead of disappearing.
  const scoped = situationKey ? rules.filter((rule) => rule.situationKey === situationKey) : rules;
  const sharedRules = situationKey ? rules.filter((rule) => !rule.situationKey) : [];

  const needIndex = new Map(vocabulary.needs.map((need, index) => [need.need, index]));
  const needMeta = new Map(vocabulary.needs.map((need) => [need.need, need]));
  const mentioned = new Set<string>();

  for (const rule of scoped) {
    for (const need of Object.keys(rule.conditions)) mentioned.add(need);
  }

  const expanded = new Set<string>(mentioned);
  function addPrerequisites(need: string) {
    const meta = needMeta.get(need);
    if (!meta) return;
    for (const prerequisite of meta.requires) {
      if (!needMeta.has(prerequisite) || expanded.has(prerequisite)) continue;
      expanded.add(prerequisite);
      addPrerequisites(prerequisite);
    }
  }
  for (const need of mentioned) addPrerequisites(need);

  const orderedNeeds = [...expanded]
    .filter((need) => needMeta.has(need))
    .sort(
      (a, b) =>
        dependencyDepth(a, needMeta) - dependencyDepth(b, needMeta) ||
        (needIndex.get(a) ?? 0) - (needIndex.get(b) ?? 0),
    );
  const workflowOrder = new Map(orderedNeeds.map((need, index) => [need, index]));

  const needs = orderedNeeds
    .map((need): WorkflowNeed => {
      const meta = needMeta.get(need)!;
      const isPrerequisiteOnly = !mentioned.has(need);
      const branches: BranchValue[] = meta.findings.map((finding) => {
        const candidates = scoped.filter((rule) => rule.conditions[need]?.includes(finding));
        const matching = candidates.filter((rule) => deepestConditionNeed(rule, workflowOrder) === need);
        const continues = candidates.length > matching.length;
        // Only where nothing of this situation's answers the branch — the case in
        // which the agent falls back to a general rule.
        const open = matching.length === 0 && !continues;
        const generalRules = open ? generalRulesCovering(sharedRules, need, finding) : [];
        // The picked rule, looked up among this set's general rules by key; a pick
        // naming a rule since deleted simply finds nothing.
        const chosenKey = open ? chosenFor(need, finding) : null;
        const chosenRule = chosenKey ? sharedRules.find((rule) => rule.answerKey === chosenKey) ?? null : null;
        const status: BranchStatus =
          matching.length > 0 || continues
            ? "covered"
            : generalRules.length > 0 || chosenRule
              ? "general"
              : isPrerequisiteOnly
                ? "prerequisite"
                : "missing";
        return {
          finding,
          rules: matching.sort(sortRuleForWorkflow),
          generalRules,
          chosenRule,
          status,
          continues,
        };
      });
      return {
        need,
        findings: meta.findings,
        requires: meta.requires,
        isPrerequisiteOnly,
        branches,
      };
    });

  const conditionlessRules = scoped
    .filter((rule) => Object.keys(rule.conditions).length === 0)
    .sort(sortRuleForWorkflow);
  const missingBranches = needs.reduce(
    (count, need) => count + need.branches.filter((branch) => branch.status === "missing").length,
    0,
  );

  return { needs, conditionlessRules, sharedRules: sharedRules.sort(sortRuleForWorkflow), missingBranches };
}

function deepestConditionNeed(rule: PolicyRule, order: Map<string, number>): string | null {
  return Object.keys(rule.conditions)
    .filter((need) => order.has(need))
    .sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0))[0] ?? null;
}

function dependencyDepth(
  need: string,
  meta: Map<string, { requires: string[] }>,
  seen = new Set<string>(),
): number {
  if (seen.has(need)) return 0;
  seen.add(need);
  const requires = meta.get(need)?.requires ?? [];
  if (requires.length === 0) return 0;
  return 1 + Math.max(...requires.map((prerequisite) => dependencyDepth(prerequisite, meta, seen)));
}

/** Branches that have an answer — by a rule of this situation or by a general rule. */
function coveredCount(need: WorkflowNeed): number {
  return need.branches.filter((branch) => branch.status === "covered" || branch.status === "general").length;
}

function sortRuleForWorkflow(a: PolicyRule, b: PolicyRule): number {
  if (Boolean(a.situationKey) !== Boolean(b.situationKey)) return a.situationKey ? -1 : 1;
  return Object.keys(b.conditions).length - Object.keys(a.conditions).length || a.answerKey.localeCompare(b.answerKey);
}

function labelNeed(need: string): string {
  return need.replace(/_/g, " ");
}

function conditionSummary(rule: PolicyRule): string {
  const entries = Object.entries(rule.conditions);
  if (entries.length === 0) return "Any evidence";
  return entries.map(([need, values]) => `${labelNeed(need)} is ${values.join(" or ")}`).join("; ");
}

function actionSummary(rule: PolicyRule): string {
  if (rule.route) {
    const ask = rule.ask.length > 0 ? `, ask for ${rule.ask.join(" and ")}` : "";
    const offer = rule.offerCode ? `, give ${rule.offerCode}` : "";
    return `${rule.route}${ask}${offer}`;
  }
  if (rule.offerCode) return `answer it, give ${rule.offerCode}`;
  return "answer it, leave verdict alone";
}
