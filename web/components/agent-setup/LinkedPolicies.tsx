"use client";

import { useState } from "react";

import { linkPolicy, unlinkPolicy } from "@/lib/api/company-policies";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { useT } from "@/lib/i18n/client";
import type { CompanyPolicy, CompanyPolicyLink } from "@/lib/types";

import styles from "./LinkedPolicies.module.css";

export type PolicyTarget =
  | { situationKey: string; answerId?: never; pendingKeys?: never }
  | { answerId: string; situationKey?: never; pendingKeys?: never }
  /** A rule not saved yet: the picks are held by the editor and linked once it has an id. */
  | { pendingKeys: string[]; onPendingChange: (keys: string[]) => void; situationKey?: never; answerId?: never };

/**
 * « Linked policies » on a situation or on one rule: the company policies that
 * reach every reply there. A link is a reference, so editing the policy in the
 * library changes it here too. A rule also shows, greyed, what it inherits from
 * its situation. Links save at once: there is nothing else to fill in — except
 * on a rule not saved yet, which has no id to link to, so its picks wait for
 * the rule's first save (`pendingKeys`).
 */
export function LinkedPolicies({
  library,
  target,
  inheritedKeys = [],
  onChange,
}: {
  library: CompanyPolicy[];
  target: PolicyTarget;
  /** Keys this rule already gets from its situation. */
  inheritedKeys?: string[];
  /** The library with this change applied, so every block on the page agrees. */
  onChange: (next: CompanyPolicy[]) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

  const matches = (link: CompanyPolicyLink) =>
    target.situationKey ? link.situationKey === target.situationKey : link.answerId === target.answerId;
  const linked = target.pendingKeys
    ? []
    : library.flatMap((policy) => policy.links.filter(matches).map((link) => ({ policy, link })));
  const pending = target.pendingKeys ? library.filter((p) => target.pendingKeys.includes(p.key)) : [];
  const linkedKeys = new Set([...linked.map(({ policy }) => policy.key), ...pending.map((p) => p.key)]);
  const inherited = library.filter((p) => inheritedKeys.includes(p.key) && !linkedKeys.has(p.key));
  const addable = library.filter((p) => p.active && !linkedKeys.has(p.key) && !inheritedKeys.includes(p.key));

  async function add(key: string) {
    if (!key) return;
    if (target.pendingKeys) {
      target.onPendingChange([...target.pendingKeys, key]);
      setAdding("");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const link = await linkPolicy({ policyKey: key, situationKey: target.situationKey ?? null, answerId: target.answerId ?? null });
      onChange(library.map((p) => (p.key === key && !p.links.some((l) => l.id === link.id) ? { ...p, links: [...p.links, link] } : p)));
      setAdding("");
    } catch (caught) {
      setError(knowledgeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(link: CompanyPolicyLink) {
    setBusy(true);
    setError(null);
    try {
      await unlinkPolicy(link.id);
      onChange(library.map((p) => ({ ...p, links: p.links.filter((l) => l.id !== link.id) })));
    } catch (caught) {
      setError(knowledgeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.block}>
      <p className={styles.label}>{t("setup.policies.linked")}</p>
      <div className={styles.chips}>
        {linked.length === 0 && pending.length === 0 && inherited.length === 0 && <span className={styles.none}>{t("setup.policies.noneLinked")}</span>}
        {linked.map(({ policy, link }) => (
          <span key={link.id} className={policy.active ? styles.chip : styles.chipOff} title={policy.purpose || policy.key}>
            {policy.name}
            {!policy.active && ` (${t("setup.policies.off")})`}
            <button type="button" className={styles.remove} disabled={busy} aria-label={t("setup.policies.unlink", { name: policy.name })} onClick={() => remove(link)}>
              ×
            </button>
          </span>
        ))}
        {pending.map((policy) => (
          <span key={policy.key} className={styles.chip} title={policy.purpose || policy.key}>
            {policy.name}
            <button
              type="button"
              className={styles.remove}
              aria-label={t("setup.policies.unlink", { name: policy.name })}
              onClick={() => target.pendingKeys && target.onPendingChange(target.pendingKeys.filter((k) => k !== policy.key))}
            >
              ×
            </button>
          </span>
        ))}
        {inherited.map((policy) => (
          <span key={policy.key} className={styles.chipInherited} title={t("setup.policies.inherited")}>
            {policy.name}
          </span>
        ))}
        {addable.length > 0 && (
          <select
            className={styles.add}
            value={adding}
            disabled={busy}
            aria-label={t("setup.policies.add")}
            onChange={(e) => {
              setAdding(e.target.value);
              void add(e.target.value);
            }}
          >
            <option value="">{t("setup.policies.add")}</option>
            {addable.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
