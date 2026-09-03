"use client";

import { useEffect, useMemo, useState } from "react";

import { AlertIcon, CheckCircleIcon, DotIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { deleteRule, saveRule, setRuleApproval } from "@/lib/api/policy";
import type { PolicyRule, PolicySituation, PolicyVocabulary } from "@/lib/types";

import { RuleEditor } from "./RuleEditor";
import type { RuleEditorSeed } from "./RuleEditor";
import styles from "./RuleBook.module.css";

const SHARED = "__shared__";

type BranchStatus = "covered" | "missing" | "prerequisite";

interface BranchValue {
  finding: string;
  rules: PolicyRule[];
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
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answerSet, setAnswerSet] = useState(startingAnswerSet);
  const [activeSituation, setActiveSituation] = useState<string>(startingSituation);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(initialRules[0]?.id ?? null);

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

  const workflow = useMemo(
    () => buildWorkflow(visibleRules, vocabulary),
    [visibleRules, vocabulary],
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

  function openNewRule(seed: RuleEditorSeed = {}) {
    setEditing({
      rule: null,
      seed: {
        answerSet,
        situationKey: selectedSituationKey,
        ...seed,
      },
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
                <span className={styles.situationKey}>Any situation</span>
                <span className={styles.situationQuestion}>Shared rules for the whole set</span>
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
                  {activeSituationMeta ? activeSituationMeta.key : "Any situation"}
                </h3>
                <p className={styles.canvasMeta}>
                  {activeSituationMeta?.question ?? "Shared rules that can apply when no specific situation wins."}
                </p>
              </div>
              <div className={styles.canvasStats} aria-label="Workflow summary">
                <span>{specificRuleCount} situation rules</span>
                <span>{sharedRuleCount} shared</span>
                <span>{workflow.missingBranches} gaps</span>
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
                                <div className={styles.outcomes}>
                                  {branch.rules.map((rule) => (
                                    <button
                                      key={rule.id}
                                      type="button"
                                      className={
                                        selectedRuleId === rule.id ? styles.outcomeOn : styles.outcomeButton
                                      }
                                      onClick={() => setSelectedRuleId(rule.id)}
                                    >
                                      <span className={styles.outcomeKey}>{rule.answerKey}</span>
                                      <span className={styles.outcomeAction}>{actionSummary(rule)}</span>
                                    </button>
                                  ))}
                                </div>
                              ) : branch.continues ? (
                                <p className={styles.continues}>Continues to a deeper decision.</p>
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
                    <div className={styles.outcomes}>
                      {workflow.conditionlessRules.map((rule) => (
                        <button
                          key={rule.id}
                          type="button"
                          className={selectedRuleId === rule.id ? styles.outcomeOn : styles.outcomeButton}
                          onClick={() => setSelectedRuleId(rule.id)}
                        >
                          <span className={styles.outcomeKey}>{rule.answerKey}</span>
                          <span className={styles.outcomeAction}>{actionSummary(rule)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
              )}
            </div>
          </main>

          <aside className={styles.inspector} aria-label="Selected rule">
            {selectedRule ? (
              <RuleInspector
                rule={selectedRule}
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
          situations={situations}
          vocabulary={vocabulary}
          knownSets={answerSets}
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
  busy,
  onEdit,
  onApprove,
  onDelete,
}: {
  rule: PolicyRule;
  busy: boolean;
  onEdit: () => void;
  onApprove: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={styles.inspectorBody}>
      <div className={styles.inspectorHead}>
        <div>
          <p className={styles.inspectorLabel}>Selected rule</p>
          <h3>{rule.answerKey}</h3>
        </div>
        <span className={rule.approvalStatus === "approved" ? styles.liveTag : styles.draftTag}>
          {rule.approvalStatus === "approved" ? "live" : "draft"}
        </span>
      </div>

      <dl className={styles.ruleFacts}>
        <div>
          <dt>Situation</dt>
          <dd>{rule.situationKey ?? "Any situation"}</dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>{conditionSummary(rule)}</dd>
        </div>
        <div>
          <dt>Then</dt>
          <dd>{actionSummary(rule)}</dd>
        </div>
        {rule.offerCode && (
          <div>
            <dt>Code</dt>
            <dd>{rule.offerCode}</dd>
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
        <Button variant="secondary" size="sm" disabled={busy} onClick={onDelete}>
          Delete
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
  if (status === "missing") {
    return (
      <span className={styles.branchMissing} title="Missing branch">
        <AlertIcon size={14} />
      </span>
    );
  }
  return null;
}

function buildWorkflow(rules: PolicyRule[], vocabulary: PolicyVocabulary) {
  const needIndex = new Map(vocabulary.needs.map((need, index) => [need.need, index]));
  const needMeta = new Map(vocabulary.needs.map((need) => [need.need, need]));
  const mentioned = new Set<string>();

  for (const rule of rules) {
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
        const candidates = rules.filter((rule) => rule.conditions[need]?.includes(finding));
        const matching = candidates.filter((rule) => deepestConditionNeed(rule, workflowOrder) === need);
        const continues = candidates.length > matching.length;
        const status: BranchStatus =
          matching.length > 0 || continues ? "covered" : isPrerequisiteOnly ? "prerequisite" : "missing";
        return {
          finding,
          rules: matching.sort(sortRuleForWorkflow),
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

  const conditionlessRules = rules
    .filter((rule) => Object.keys(rule.conditions).length === 0)
    .sort(sortRuleForWorkflow);
  const missingBranches = needs.reduce(
    (count, need) => count + need.branches.filter((branch) => branch.status === "missing").length,
    0,
  );

  return { needs, conditionlessRules, missingBranches };
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

function coveredCount(need: WorkflowNeed): number {
  return need.branches.filter((branch) => branch.status === "covered").length;
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
