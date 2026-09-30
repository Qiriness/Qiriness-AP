"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { Button } from "../ui/Button";
import t from "../insights/tables.module.css";
import styles from "./AgentModelPicker.module.css";

const ENDPOINT = "/api/settings/agents/models";

/**
 * Choose the model one agent runs on. The list is what the OpenAI key can call
 * (read server-side); the field also takes a typed id, for when that list
 * could not be read. The server refuses a model the key cannot use.
 */
export function AgentModelPicker({
  agent,
  agentName,
  chosenModel,
  defaultModel,
  availableModels,
  listError,
  pricedModels,
}: {
  agent: string;
  agentName: string;
  chosenModel: string | null;
  defaultModel: string | null;
  availableModels: string[];
  listError: string | null;
  pricedModels: string[];
}) {
  const tr = useT();
  const router = useRouter();
  const id = useId();
  const current = chosenModel ?? defaultModel ?? "";
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState(current);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(next: string | null) {
    setBusy(next === null ? "reset" : "save");
    setError(null);
    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, model: next }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload?.error ?? tr("settings.models.failed", { status: response.status }));
        return;
      }
      setEditing(false);
      router.refresh();
    } catch {
      setError(tr("settings.models.unreachable"));
    } finally {
      setBusy(null);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={styles.change}
        onClick={() => {
          setModel(current);
          setError(null);
          setEditing(true);
        }}
      >
        {tr("settings.models.change")}
      </button>
    );
  }

  const trimmed = model.trim();
  const unpriced = trimmed !== "" && !pricedModels.includes(trimmed);

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void send(trimmed);
      }}
    >
      <label className={t.srOnly} htmlFor={`${id}-model`}>
        {tr("settings.models.label", { agent: agentName })}
      </label>
      <div className={styles.row}>
        {availableModels.length > 0 ? (
          <select
            id={`${id}-model`}
            className={styles.input}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            {availableModels.includes(model) ? null : <option value={model}>{model}</option>}
            {availableModels.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              id={`${id}-model`}
              className={styles.input}
              list={`${id}-suggestions`}
              spellCheck={false}
              autoComplete="off"
              placeholder="gpt-…"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            {/* Without the account's list, the models this app has a price for. */}
            <datalist id={`${id}-suggestions`}>
              {pricedModels.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </>
        )}
        <Button
          type="submit"
          size="sm"
          variant="primary"
          loading={busy === "save"}
          disabled={!trimmed || trimmed === chosenModel || busy !== null}
        >
          {tr("settings.models.save")}
        </Button>
        <Button size="sm" variant="tertiary" onClick={() => setEditing(false)} disabled={busy !== null}>
          {tr("tickets.panels.draft.cancel")}
        </Button>
      </div>
      {chosenModel && defaultModel ? (
        <Button size="sm" variant="tertiary" loading={busy === "reset"} disabled={busy !== null} onClick={() => void send(null)}>
          {tr("settings.models.useDefault", { model: defaultModel })}
        </Button>
      ) : null}
      {listError ? <p className={styles.help}>{tr("settings.models.listFailed", { error: listError })}</p> : null}
      {unpriced ? <p className={styles.help}>{tr("settings.models.noRate")}</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
