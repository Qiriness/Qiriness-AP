"use client";

import { useMemo, useState } from "react";
import type {
  ForwardingAckSettings,
  ForwardingConfig,
  ForwardingDestination,
  ForwardingDestinationInput,
  KnowledgeCategory,
  RequestKind,
} from "@/lib/types";
import { CATEGORY_LABELS, REQUEST_KINDS, TICKET_CATEGORIES } from "@/lib/types";
import {
  createForwardingDestination,
  deleteForwardingDestination,
  saveForwardingAckSettings,
  setForwardingOn,
  updateForwardingDestination,
} from "@/lib/api/forwarding";
import { knowledgeErrorMessage } from "@/lib/api/knowledge";
import { Button } from "@/components/ui/Button";
import {
  renderAcknowledgement,
  routingModeByCategory,
} from "../../../scripts/lib/forwarding-destinations.mjs";
import styles from "./ForwardingSettings.module.css";

/**
 * Forwarding: who receives mail the contact team does not own.
 *
 * Three parts, in the order a person reads them: where each category goes today
 * (derived, never edited directly), the destinations themselves, and the fixed
 * acknowledgement the sender gets.
 *
 * WHAT AN OPERATOR NEEDS TO UNDERSTAND, and what the copy says out loud: one
 * destination on a category forwards all of it; several make the agent choose
 * between them from their descriptions, and keep the ticket when it is not
 * sure. The overview shows that for all 14 categories, so a new destination's
 * effect is visible before anything is sent.
 */

const KIND_LABELS: Record<RequestKind, string> = {
  question: "Questions",
  problem: "Problems",
  complaint: "Complaints",
  contact: "First contact",
};

const EMPTY_INPUT: ForwardingDestinationInput = {
  label: "",
  forwardEmail: null,
  description: "",
  categories: [],
  requestKinds: [],
  matchDescription: false,
  timing: "immediate",
  acknowledge: true,
  publicNameFr: null,
  publicNameEn: null,
  ackNoteFr: null,
  ackNoteEn: null,
  position: 0,
};

interface ForwardingSettingsProps {
  initialConfig: ForwardingConfig | null;
  loadError: string | null;
}

export function ForwardingSettings({ initialConfig, loadError }: ForwardingSettingsProps) {
  const [destinations, setDestinations] = useState<ForwardingDestination[]>(initialConfig?.destinations ?? []);
  // Which card is open: a destination id, "new", or none.
  const [editing, setEditing] = useState<string | null>(null);

  if (loadError || !initialConfig) {
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>Email forwarding</h2>
        <p className={styles.loadError} role="alert">
          {loadError ?? "Failed to load forwarding settings."}
        </p>
      </section>
    );
  }

  function saved(destination: ForwardingDestination) {
    setDestinations((list) => {
      const next = list.some((d) => d.id === destination.id)
        ? list.map((d) => (d.id === destination.id ? destination : d))
        : [...list, destination];
      return next.sort((a, b) => a.position - b.position);
    });
    setEditing(null);
  }

  function removed(id: string) {
    setDestinations((list) => list.filter((d) => d.id !== id));
    setEditing(null);
  }

  return (
    <section className={styles.section} aria-labelledby="forwarding-heading">
      <header className={styles.header}>
        <h2 className={styles.title} id="forwarding-heading">
          Email forwarding
        </h2>
        <p className={styles.intro}>
          Some mail reaching the contact inbox belongs to another team — an invoice, a job
          application, a partnership, a sales opportunity. Each destination below says who receives
          it and what they handle.
        </p>
        <p className={styles.caveat}>
          <strong>One destination on a category forwards all of it</strong>, unless it is set to
          take only the mail matching its description. Several on the same category make the agent
          choose between them from their descriptions — and when it is not sure, the ticket stays
          here. Leave an address empty to switch a destination off without
          losing it.
        </p>
      </header>

      <ForwardingSwitch initial={initialConfig.forwardSince} />

      <RoutingOverview destinations={destinations} />

      <div className={styles.block}>
        <div className={styles.blockHead}>
          <h3 className={styles.blockTitle}>Destinations</h3>
          {editing !== "new" && (
            <Button size="sm" onClick={() => setEditing("new")}>
              Add destination
            </Button>
          )}
        </div>

        {destinations.length === 0 && editing !== "new" && (
          <p className={styles.empty}>No destinations yet — nothing is forwarded.</p>
        )}

        <ul className={styles.cards}>
          {destinations.map((destination) => (
            <li key={destination.id} className={styles.card}>
              {editing === destination.id ? (
                <DestinationEditor
                  initial={destination}
                  onCancel={() => setEditing(null)}
                  onSaved={saved}
                  onDeleted={removed}
                />
              ) : (
                <DestinationSummary destination={destination} onEdit={() => setEditing(destination.id)} />
              )}
            </li>
          ))}
          {editing === "new" && (
            <li className={styles.card}>
              <DestinationEditor
                initial={{ ...EMPTY_INPUT, position: nextPosition(destinations) }}
                onCancel={() => setEditing(null)}
                onSaved={saved}
              />
            </li>
          )}
        </ul>
      </div>

      <AcknowledgementSettings
        initial={initialConfig.settings}
        defaults={initialConfig.defaultTemplates}
        destinations={destinations}
        shopName={initialConfig.shopName}
      />
    </section>
  );
}

// --- the master switch ------------------------------------------------------

function ForwardingSwitch({ initial }: { initial: string | null }) {
  const [since, setSince] = useState<string | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function flip(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      setSince(await setForwardingOn(on));
    } catch (err) {
      setError(knowledgeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${styles.switchPanel} ${since ? styles.switchOn : ""}`}>
      <div className={styles.switchText}>
        <strong>{since ? "Forwarding is on" : "Forwarding is off"}</strong>
        <span>
          {since
            ? `Mail received since ${formatSince(since)} is forwarded. Earlier mail never is.`
            : "Nothing is forwarded. Turning it on forwards mail received from that moment; mail already in the inbox is never sent."}
        </span>
        {error && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
      </div>
      <Button size="sm" variant={since ? "secondary" : "primary"} loading={busy} onClick={() => flip(!since)}>
        {since ? "Turn off" : "Turn on forwarding"}
      </Button>
    </div>
  );
}

function formatSince(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// --- where each category goes ------------------------------------------------

function RoutingOverview({ destinations }: { destinations: ForwardingDestination[] }) {
  const modes = useMemo(() => routingModeByCategory(toRows(destinations)), [destinations]);
  return (
    <div className={styles.block}>
      <h3 className={styles.blockTitle}>Where each category goes</h3>
      <dl className={styles.overview}>
        {TICKET_CATEGORIES.map((category) => {
          const { mode, destinations: names } = modes[category];
          return (
            <div key={category} className={styles.overviewRow}>
              <dt className={styles.overviewCategory}>{CATEGORY_LABELS[category]}</dt>
              <dd className={styles.overviewRoute}>
                {mode === "stays" && <span className={styles.stays}>Stays with the contact team</span>}
                {mode === "fixed" && <span className={styles.fixed}>→ {names[0]}</span>}
                {mode === "choice" && (
                  <span className={styles.choice}>
                    Agent decides: {names.join(" · ")} — or keeps it
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

// --- one destination ---------------------------------------------------------

function DestinationSummary({ destination, onEdit }: { destination: ForwardingDestination; onEdit: () => void }) {
  return (
    <div className={styles.summary}>
      <div className={styles.summaryMain}>
        <div className={styles.summaryTitle}>
          <span className={styles.destinationName}>{destination.label}</span>
          {destination.forwardEmail ? (
            <span className={styles.address}>{destination.forwardEmail}</span>
          ) : (
            <span className={styles.off}>Off — no address</span>
          )}
        </div>
        {destination.description && <p className={styles.description}>{destination.description}</p>}
        <p className={styles.meta}>
          {destination.categories.map((c) => CATEGORY_LABELS[c]).join(", ")}
          {destination.requestKinds.length > 0 &&
            ` · ${destination.requestKinds.map((k) => KIND_LABELS[k].toLowerCase()).join(", ")} only`}
          {destination.matchDescription && " · only when it matches the description"}
          {" · "}
          {destination.timing === "immediate"
            ? destination.acknowledge
              ? "forwarded at once, sender acknowledged"
              : "forwarded at once"
            : "forwarded after our first reply"}
        </p>
      </div>
      <Button size="sm" variant="tertiary" onClick={onEdit}>
        Edit
      </Button>
    </div>
  );
}

interface DestinationEditorProps {
  initial: ForwardingDestination | ForwardingDestinationInput;
  onCancel: () => void;
  onSaved: (destination: ForwardingDestination) => void;
  onDeleted?: (id: string) => void;
}

function DestinationEditor({ initial, onCancel, onSaved, onDeleted }: DestinationEditorProps) {
  const id = "id" in initial ? initial.id : null;
  const [draft, setDraft] = useState<ForwardingDestinationInput>(() => toInput(initial));
  const [busy, setBusy] = useState<"saving" | "deleting" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fieldId = (name: string) => `destination-${id ?? "new"}-${name}`;

  const set = <K extends keyof ForwardingDestinationInput>(key: K, value: ForwardingDestinationInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  function toggle<T extends string>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  async function save() {
    setBusy("saving");
    setError(null);
    try {
      const destination = id
        ? await updateForwardingDestination(id, draft)
        : await createForwardingDestination(draft);
      onSaved(destination);
    } catch (err) {
      setError(knowledgeErrorMessage(err));
      setBusy(null);
    }
  }

  async function remove() {
    if (!id || !onDeleted) return;
    setBusy("deleting");
    setError(null);
    try {
      await deleteForwardingDestination(id);
      onDeleted(id);
    } catch (err) {
      setError(knowledgeErrorMessage(err));
      setBusy(null);
    }
  }

  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className={styles.grid2}>
        <label className={styles.field} htmlFor={fieldId("label")}>
          <span className={styles.fieldLabel}>Name</span>
          <input
            id={fieldId("label")}
            className={styles.input}
            value={draft.label}
            onChange={(e) => set("label", e.target.value)}
            placeholder="Comptabilité"
            required
          />
        </label>
        <label className={styles.field} htmlFor={fieldId("email")}>
          <span className={styles.fieldLabel}>Forward to</span>
          <input
            id={fieldId("email")}
            className={styles.input}
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={draft.forwardEmail ?? ""}
            onChange={(e) => set("forwardEmail", e.target.value || null)}
            placeholder="Empty switches it off"
          />
        </label>
      </div>

      <label className={styles.field} htmlFor={fieldId("description")}>
        <span className={styles.fieldLabel}>What they handle</span>
        <span className={styles.hint}>
          In plain words. When a category has several destinations, this is what the agent reads to
          choose.
        </span>
        <textarea
          id={fieldId("description")}
          className={styles.textarea}
          rows={2}
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Demandes de factures / problèmes liés à la facturation des clients professionnels"
        />
      </label>

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={draft.matchDescription}
          onChange={(e) => set("matchDescription", e.target.checked)}
        />
        <span>
          Only mail that matches this description — the agent checks each one and keeps the ticket
          when it does not fit, even if this is the category&apos;s only destination
        </span>
      </label>

      <fieldset className={styles.fieldset}>
        <legend className={styles.fieldLabel}>Categories it receives</legend>
        <div className={styles.chips}>
          {TICKET_CATEGORIES.map((category) => (
            <label key={category} className={styles.chip}>
              <input
                type="checkbox"
                checked={draft.categories.includes(category)}
                onChange={() => set("categories", toggle(draft.categories, category))}
              />
              <span>{CATEGORY_LABELS[category]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.fieldLabel}>Only these request kinds</legend>
        <span className={styles.hint}>None ticked means any kind.</span>
        <div className={styles.chips}>
          {REQUEST_KINDS.map((kind) => (
            <label key={kind} className={styles.chip}>
              <input
                type="checkbox"
                checked={draft.requestKinds.includes(kind)}
                onChange={() => set("requestKinds", toggle(draft.requestKinds, kind))}
              />
              <span>{KIND_LABELS[kind]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.fieldLabel}>When it is forwarded</legend>
        <label className={styles.radio}>
          <input
            type="radio"
            name={fieldId("timing")}
            checked={draft.timing === "immediate"}
            onChange={() => setDraft((d) => ({ ...d, timing: "immediate", acknowledge: true }))}
          />
          <span>
            <strong>At once</strong> — as soon as the agent routes it
          </span>
        </label>
        <label className={styles.radio}>
          <input
            type="radio"
            name={fieldId("timing")}
            checked={draft.timing === "after_first_reply"}
            onChange={() => setDraft((d) => ({ ...d, timing: "after_first_reply", acknowledge: false }))}
          />
          <span>
            <strong>After our first reply</strong> — we ask the customer for what is missing first,
            then forward the thread
          </span>
        </label>
        {draft.timing === "immediate" && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.acknowledge}
              onChange={(e) => set("acknowledge", e.target.checked)}
            />
            <span>Tell the sender it has been passed on</span>
          </label>
        )}
      </fieldset>

      {draft.timing === "immediate" && draft.acknowledge && (
        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>In the acknowledgement</legend>
          <div className={styles.grid2}>
            <label className={styles.field} htmlFor={fieldId("name-fr")}>
              <span className={styles.hint}>French — the words after « Nous l&apos;avons transmis »</span>
              <input
                id={fieldId("name-fr")}
                className={styles.input}
                value={draft.publicNameFr ?? ""}
                onChange={(e) => set("publicNameFr", e.target.value || null)}
                placeholder="au service concerné"
              />
            </label>
            <label className={styles.field} htmlFor={fieldId("name-en")}>
              <span className={styles.hint}>English — the words after « passed it on to »</span>
              <input
                id={fieldId("name-en")}
                className={styles.input}
                value={draft.publicNameEn ?? ""}
                onChange={(e) => set("publicNameEn", e.target.value || null)}
                placeholder="the relevant team"
              />
            </label>
            <label className={styles.field} htmlFor={fieldId("note-fr")}>
              <span className={styles.hint}>Extra paragraph (French)</span>
              <textarea
                id={fieldId("note-fr")}
                className={styles.textarea}
                rows={2}
                value={draft.ackNoteFr ?? ""}
                onChange={(e) => set("ackNoteFr", e.target.value || null)}
              />
            </label>
            <label className={styles.field} htmlFor={fieldId("note-en")}>
              <span className={styles.hint}>Extra paragraph (English)</span>
              <textarea
                id={fieldId("note-en")}
                className={styles.textarea}
                rows={2}
                value={draft.ackNoteEn ?? ""}
                onChange={(e) => set("ackNoteEn", e.target.value || null)}
              />
            </label>
          </div>
        </fieldset>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        {id && onDeleted && (
          <span className={styles.deleteArea}>
            {confirmDelete ? (
              <>
                <span className={styles.confirmText}>Delete {draft.label || "this destination"}?</span>
                <Button size="sm" variant="danger" type="button" loading={busy === "deleting"} onClick={remove}>
                  Delete
                </Button>
                <Button size="sm" variant="tertiary" type="button" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="tertiary" type="button" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </span>
        )}
        <Button size="sm" variant="secondary" type="button" onClick={onCancel} disabled={busy !== null}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={busy === "saving"}>
          Save
        </Button>
      </div>
    </form>
  );
}

// --- the acknowledgement -----------------------------------------------------

interface AcknowledgementSettingsProps {
  initial: ForwardingAckSettings;
  defaults: { fr: string; en: string };
  destinations: ForwardingDestination[];
  shopName: string;
}

function AcknowledgementSettings({ initial, defaults, destinations, shopName }: AcknowledgementSettingsProps) {
  const [draft, setDraft] = useState<ForwardingAckSettings>(initial);
  const [savedValue, setSavedValue] = useState<ForwardingAckSettings>(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const acknowledging = destinations.filter((d) => d.timing === "immediate" && d.acknowledge);
  const [previewId, setPreviewId] = useState<string>(acknowledging[0]?.id ?? "");
  const [previewLanguage, setPreviewLanguage] = useState<"fr" | "en">("fr");

  const dirty =
    draft.ackEnabled !== savedValue.ackEnabled ||
    (draft.ackTemplateFr ?? "") !== (savedValue.ackTemplateFr ?? "") ||
    (draft.ackTemplateEn ?? "") !== (savedValue.ackTemplateEn ?? "");

  const previewDestination = acknowledging.find((d) => d.id === previewId) ?? acknowledging[0];
  const preview = renderAcknowledgement({
    destination: previewDestination ? toRows([previewDestination])[0] : {},
    settings: { ack_template_fr: draft.ackTemplateFr, ack_template_en: draft.ackTemplateEn },
    shopName,
    language: previewLanguage,
  });

  async function save() {
    setState("saving");
    setError(null);
    try {
      const next = await saveForwardingAckSettings(draft);
      setDraft(next);
      setSavedValue(next);
      setState("saved");
    } catch (err) {
      setError(knowledgeErrorMessage(err));
      setState("error");
    }
  }

  return (
    <div className={styles.block}>
      <h3 className={styles.blockTitle}>Acknowledgement to the sender</h3>
      <p className={styles.blockIntro}>
        A fixed message, never written by the AI, sent once per ticket after the forward has gone
        through — never to our own colleagues or to automated senders. It is the one email that
        leaves without a person approving it, so it is off until switched on here.
      </p>

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={draft.ackEnabled}
          onChange={(e) => setDraft((d) => ({ ...d, ackEnabled: e.target.checked }))}
        />
        <span>Send the acknowledgement</span>
      </label>

      <div className={styles.grid2}>
        <label className={styles.field} htmlFor="ack-template-fr">
          <span className={styles.fieldLabel}>French template</span>
          <textarea
            id="ack-template-fr"
            className={`${styles.textarea} ${styles.template}`}
            rows={9}
            value={draft.ackTemplateFr ?? ""}
            placeholder={defaults.fr}
            onChange={(e) => setDraft((d) => ({ ...d, ackTemplateFr: e.target.value || null }))}
          />
        </label>
        <label className={styles.field} htmlFor="ack-template-en">
          <span className={styles.fieldLabel}>English template</span>
          <textarea
            id="ack-template-en"
            className={`${styles.textarea} ${styles.template}`}
            rows={9}
            value={draft.ackTemplateEn ?? ""}
            placeholder={defaults.en}
            onChange={(e) => setDraft((d) => ({ ...d, ackTemplateEn: e.target.value || null }))}
          />
        </label>
      </div>
      <p className={styles.hint}>
        Empty uses the default shown. <code>{"{service}"}</code> is the destination&apos;s name in the
        acknowledgement, <code>{"{note}"}</code> its extra paragraph, <code>{"{shop}"}</code> the shop
        name. French mail is answered in French, everything else in English.
      </p>

      <div className={styles.actions}>
        <span className={styles.status} aria-live="polite">
          {state === "saved" && !dirty && <span className={styles.saved}>Saved</span>}
        </span>
        <Button size="sm" variant="primary" onClick={save} disabled={!dirty} loading={state === "saving"}>
          Save acknowledgement
        </Button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.preview}>
        <div className={styles.previewHead}>
          <span className={styles.fieldLabel}>Preview</span>
          {acknowledging.length > 0 && (
            <select
              className={styles.select}
              value={previewDestination?.id ?? ""}
              onChange={(e) => setPreviewId(e.target.value)}
              aria-label="Destination to preview"
            >
              {acknowledging.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
          <select
            className={styles.select}
            value={previewLanguage}
            onChange={(e) => setPreviewLanguage(e.target.value as "fr" | "en")}
            aria-label="Language to preview"
          >
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </div>
        <pre className={styles.previewBody}>{preview}</pre>
      </div>
    </div>
  );
}

// --- helpers -----------------------------------------------------------------

function toInput(value: ForwardingDestination | ForwardingDestinationInput): ForwardingDestinationInput {
  const { label, forwardEmail, description, categories, requestKinds, matchDescription, timing, acknowledge } = value;
  return {
    label,
    forwardEmail,
    description,
    categories: [...categories] as KnowledgeCategory[],
    requestKinds: [...requestKinds] as RequestKind[],
    matchDescription,
    timing,
    acknowledge,
    publicNameFr: value.publicNameFr,
    publicNameEn: value.publicNameEn,
    ackNoteFr: value.ackNoteFr,
    ackNoteEn: value.ackNoteEn,
    position: value.position,
  };
}

/** The table's own shape, which the shared module reads. */
function toRows(destinations: ForwardingDestination[]) {
  return destinations.map((d) => ({
    label: d.label,
    forward_email: d.forwardEmail,
    categories: d.categories,
    request_kinds: d.requestKinds,
    match_description: d.matchDescription,
    public_name_fr: d.publicNameFr,
    public_name_en: d.publicNameEn,
    ack_note_fr: d.ackNoteFr,
    ack_note_en: d.ackNoteEn,
  }));
}

function nextPosition(destinations: ForwardingDestination[]) {
  return destinations.reduce((max, d) => Math.max(max, d.position), -1) + 1;
}
