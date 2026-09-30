"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { createPolicy, savePolicy } from "@/lib/api/company-policies";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { useT } from "@/lib/i18n/client";
import type { CompanyPolicy, CompanyPolicyTargets } from "@/lib/types";

import styles from "./PolicyLibrary.module.css";

type Draft = { key: string; name: string; purpose: string; content: string; active: boolean };

const EMPTY: Draft = { key: "", name: "", purpose: "", content: "", active: true };

/**
 * The company's policies, each written once.
 *
 * WHAT A POLICY IS, AND IS NOT. The company's rule on something (how long
 * delivery takes, where we deliver, how returns work) as text the agent quotes.
 * It never decides what happens in a case: the rules do that. A policy
 * linked to a situation or a rule reaches every reply there; the agent may also
 * fetch any active policy when a customer asks about it in passing.
 *
 * ONE COPY. Editing a policy here changes every situation and rule linked to
 * it from the next reply on; each version's text is kept.
 */
export function PolicyLibrary({
  initial,
  targets,
  parameterKeys,
  loadError,
}: {
  initial: CompanyPolicy[];
  targets: CompanyPolicyTargets;
  /** The parameters a policy may quote as {key}. */
  parameterKeys: string[];
  loadError: string | null;
}) {
  const t = useT();
  const [policies, setPolicies] = useState(initial);
  const [selectedKey, setSelectedKey] = useState<string | null>(initial[0]?.key ?? null);
  const [creating, setCreating] = useState(initial.length === 0);
  const [draft, setDraft] = useState<Draft>(() => (initial[0] ? toDraft(initial[0]) : EMPTY));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = creating ? null : policies.find((p) => p.key === selectedKey) ?? null;
  const dirty = creating ? draft.name.trim() !== "" || draft.content.trim() !== "" : selected ? !sameDraft(draft, toDraft(selected)) : false;

  const ruleNames = useMemo(() => new Map(targets.rules.map((r) => [r.id, r])), [targets.rules]);
  const situationNames = useMemo(() => new Map(targets.situations.map((s) => [s.key, s.question])), [targets.situations]);

  function open(policy: CompanyPolicy) {
    setCreating(false);
    setSelectedKey(policy.key);
    setDraft(toDraft(policy));
    setError(null);
    setNotice(null);
  }

  function startNew() {
    setCreating(true);
    setSelectedKey(null);
    setDraft(EMPTY);
    setError(null);
    setNotice(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (creating) {
        const created = await createPolicy(draft);
        setPolicies((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        setCreating(false);
        setSelectedKey(created.key);
        setDraft(toDraft(created));
        setNotice(t("setup.policies.created"));
      } else if (selected) {
        const saved = await savePolicy(selected.key, {
          name: draft.name,
          purpose: draft.purpose,
          content: draft.content,
          active: draft.active,
          expectedVersion: selected.version,
        });
        setPolicies((prev) => prev.map((p) => (p.key === saved.key ? saved : p)));
        setDraft(toDraft(saved));
        setNotice(saved.links.length > 0 ? t("setup.policies.savedLinked", { n: saved.links.length }) : t("setup.policies.saved"));
      }
    } catch (caught) {
      setError(knowledgeErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function insertParameter(key: string) {
    setDraft((prev) => ({ ...prev, content: `${prev.content}{${key}}` }));
  }

  return (
    <section className={styles.wrap}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>{t("setup.tabs.policies.label")}</h2>
          <p className={styles.lede}>{t("setup.policies.lede")}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={startNew}>
          {t("setup.policies.new")}
        </Button>
      </header>

      {loadError && <p className={styles.error}>{loadError}</p>}

      <div className={styles.workspace}>
        <ul className={styles.list} aria-label={t("setup.tabs.policies.label")}>
          {policies.length === 0 && <li className={styles.empty}>{t("setup.policies.none")}</li>}
          {policies.map((policy) => (
            <li key={policy.id}>
              <button
                type="button"
                className={!creating && policy.key === selectedKey ? styles.itemOn : styles.item}
                onClick={() => open(policy)}
              >
                <span className={styles.itemName}>
                  {policy.name}
                  {!policy.active && <span className={styles.off}>{t("setup.policies.off")}</span>}
                </span>
                <span className={styles.itemMeta}>
                  {policy.key} · v{policy.version} · {t("setup.policies.linkCount", { n: policy.links.length })}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className={styles.editor}>
          <label className={styles.field}>
            <span>{t("setup.policies.name")}</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("setup.policies.namePlaceholder")} />
          </label>
          <label className={styles.field}>
            <span>{t("setup.policies.key")}</span>
            <input
              value={draft.key}
              disabled={!creating}
              onChange={(e) => setDraft({ ...draft, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
              placeholder="delivery_time_policy"
            />
            <small>{creating ? t("setup.policies.keyHint") : t("setup.policies.keyFixed")}</small>
          </label>
          <label className={styles.field}>
            <span>{t("setup.policies.purpose")}</span>
            <input value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} placeholder={t("setup.policies.purposePlaceholder")} />
            <small>{t("setup.policies.purposeHint")}</small>
          </label>
          <label className={styles.field}>
            <span>{t("setup.policies.content")}</span>
            <textarea rows={14} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
          </label>
          {parameterKeys.length > 0 && (
            <div className={styles.chips} aria-label={t("setup.policies.parameters")}>
              <span className={styles.chipsLabel}>{t("setup.policies.parameters")}</span>
              {parameterKeys.map((key) => (
                <button key={key} type="button" className={styles.chip} onClick={() => insertParameter(key)}>
                  {`{${key}}`}
                </button>
              ))}
            </div>
          )}
          <label className={styles.toggle}>
            <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
            <span>{t("setup.policies.active")}</span>
          </label>

          {error && <p className={styles.error}>{error}</p>}
          {notice && <p className={styles.notice}>{notice}</p>}

          <div className={styles.actions}>
            <Button variant="primary" size="sm" disabled={busy || !dirty} loading={busy} onClick={save}>
              {creating ? t("setup.policies.create") : t("tickets.panels.save")}
            </Button>
            {selected && <span className={styles.version}>v{selected.version}</span>}
          </div>

          {selected && (
            <div className={styles.usedBy}>
              <p className={styles.usedByLabel}>{t("setup.policies.usedBy")}</p>
              {selected.links.length === 0 ? (
                <p className={styles.usedByNone}>{t("setup.policies.usedByNone")}</p>
              ) : (
                <ul>
                  {selected.links.map((link) => (
                    <li key={link.id}>
                      {link.situationKey
                        ? `${link.situationKey} — ${situationNames.get(link.situationKey) ?? ""}`
                        : (() => {
                            const rule = link.answerId ? ruleNames.get(link.answerId) : null;
                            return rule ? `${rule.situationKey ?? rule.answerSet} · ${rule.answerKey}` : t("setup.policies.deletedRule");
                          })()}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function toDraft(policy: CompanyPolicy): Draft {
  return { key: policy.key, name: policy.name, purpose: policy.purpose, content: policy.content, active: policy.active };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return a.name === b.name && a.purpose === b.purpose && a.content === b.content && a.active === b.active;
}
