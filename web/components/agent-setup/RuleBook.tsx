"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { deleteRule, saveRule, setRuleApproval } from "@/lib/api/policy";
import type { PolicyRule, PolicySituation, PolicyVocabulary } from "@/lib/types";

import { RuleEditor } from "./RuleEditor";
import styles from "./RuleBook.module.css";

/**
 * The rulebook: what Qiriness does in each situation, as rows a person edits.
 *
 * GROUPED BY ANSWER SET, AND WITHIN IT SHARED RULES FIRST. That order is the
 * order they are read in — a rule naming no situation applies to every ticket in
 * the set, so it is the general case and belongs above the exceptions. Sorting by
 * key instead would scatter the three rules that carry most of the volume.
 *
 * APPROVAL IS SHOWN AS "LIVE", not as a status chip. `approved` is the word the
 * table uses and it undersells what it means: an approved rule routes real mail.
 * A person deciding whether to flip that switch is better served by the
 * consequence than by the column name.
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
  const [rules, setRules] = useState<PolicyRule[]>(initialRules);
  const [editing, setEditing] = useState<PolicyRule | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sets = useMemo(() => {
    const grouped = new Map<string, PolicyRule[]>();
    for (const rule of rules) {
      if (!grouped.has(rule.answerSet)) grouped.set(rule.answerSet, []);
      grouped.get(rule.answerSet)!.push(rule);
    }
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rules]);

  const questionFor = useMemo(
    () => new Map(situations.map((s) => [s.key, s.question])),
    [situations],
  );

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

  const liveCount = rules.filter((r) => r.approvalStatus === "approved").length;

  return (
    <section className={styles.wrap}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Rulebook</h2>
          <p className={styles.lede}>
            What the agent does in each situation. A rule can hand a ticket to a person or ask the
            customer for something — it can never mark one safe to answer.
          </p>
        </div>
        <div className={styles.headActions}>
          <span className={styles.count}>
            {liveCount} live of {rules.length}
          </span>
          <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
            New rule
          </Button>
        </div>
      </header>

      {loadError && <p className={styles.error}>{loadError}</p>}
      {error && <p className={styles.error}>{error}</p>}

      {sets.length === 0 && !loadError && (
        <p className={styles.empty}>
          No rules yet. The agent behaves exactly as it did before any of this existed.
        </p>
      )}

      {sets.map(([set, list]) => (
        <div key={set} className={styles.set}>
          <h3 className={styles.setName}>{set}</h3>
          <ul className={styles.rules}>
            {list.map((rule) => (
              <li
                key={rule.id}
                className={`${styles.rule} ${rule.approvalStatus === "approved" ? styles.live : ""}`}
              >
                <div className={styles.ruleHead}>
                  <span className={styles.key}>{rule.answerKey}</span>
                  {rule.situationKey ? (
                    <span className={styles.situation} title={questionFor.get(rule.situationKey) ?? ""}>
                      {rule.situationKey}
                    </span>
                  ) : (
                    <span className={styles.shared}>any situation</span>
                  )}
                  {rule.approvalStatus === "approved" ? (
                    <span className={styles.liveTag}>live</span>
                  ) : (
                    <span className={styles.draftTag}>draft</span>
                  )}
                </div>

                <p className={styles.when}>
                  <span className={styles.label}>when</span>{" "}
                  {Object.keys(rule.conditions).length === 0 ? (
                    <em>any evidence</em>
                  ) : (
                    Object.entries(rule.conditions).map(([need, values], i) => (
                      <span key={need}>
                        {i > 0 ? " and " : ""}
                        <code>{need}</code> is {values.join(" or ")}
                      </span>
                    ))
                  )}
                </p>

                <p className={styles.then}>
                  <span className={styles.label}>then</span>{" "}
                  {rule.route ? (
                    <>
                      <b>{rule.route}</b>
                      {rule.ask ? (
                        <>
                          , asking for <b>{rule.ask}</b>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <em>answer it — the verdict is left alone</em>
                  )}
                </p>

                {rule.answerSkeleton && <p className={styles.skeleton}>{rule.answerSkeleton}</p>}

                <div className={styles.actions}>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(rule)}>
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy === rule.id}
                    onClick={() =>
                      run(rule.id, async () => {
                        const updated = await setRuleApproval(
                          rule.id,
                          rule.approvalStatus !== "approved",
                        );
                        setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
                      })
                    }
                  >
                    {rule.approvalStatus === "approved" ? "Take off live mail" : "Put live"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy === rule.id}
                    onClick={() =>
                      run(rule.id, async () => {
                        await deleteRule(rule.id);
                        setRules((prev) => prev.filter((r) => r.id !== rule.id));
                      })
                    }
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {editing && (
        <RuleEditor
          rule={editing === "new" ? null : editing}
          situations={situations}
          vocabulary={vocabulary}
          knownSets={[...new Set(rules.map((r) => r.answerSet))]}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            const saved = await saveRule(payload);
            setRules((prev) => {
              const without = prev.filter((r) => r.id !== saved.id);
              return [...without, saved];
            });
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}
