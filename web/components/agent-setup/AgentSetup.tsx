"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Article, CoreTopic, KnowledgeCategory, SaveState, ShopifySource, VoiceProfile } from "@/lib/types";
import { CORE_TOPIC_DEFAULT_CATEGORY, CORE_TOPIC_LABELS, EMPTY_VOICE_PROFILE } from "@/lib/types";
import {
  createArticle,
  deleteArticle,
  knowledgeErrorMessage,
  resyncArticle,
  updateArticle,
} from "@/lib/api/knowledge";
import { SetupHeader } from "./SetupHeader";
import { ArticleLibrary, type StatusFilter } from "./ArticleLibrary";
import { ArticleWorkspace } from "./ArticleWorkspace";
import { BrandVoiceWorkspace } from "./BrandVoiceWorkspace";
import { EmptyWorkspace } from "./EmptyWorkspace";
import { LoadError } from "./LoadError";
import { Toast, type ToastMessage, type ToastVariant } from "./Toast";
import styles from "./AgentSetup.module.css";

const OPTIMIZE_MS = 1300;

interface AgentSetupProps {
  initialArticles: Article[];
  initialSources: ShopifySource[];
  loadError: string | null;
}

function wordsIn(html: string): number {
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Client-only placeholder for the future AI "optimize" feature — no backend endpoint exists yet. */
function tidyContent(html: string): string {
  return html
    .replace(/<p>\s*(&nbsp;)?\s*<\/p>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function AgentSetup({ initialArticles, initialSources, loadError }: AgentSetupProps) {
  const [articles, setArticles] = useState<Article[]>(initialArticles);
  const [sources] = useState<ShopifySource[]>(initialSources);
  const [selectedId, setSelectedId] = useState<string | null>(initialArticles[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [optimizing, setOptimizing] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [editorVersion, setEditorVersion] = useState<Record<string, number>>({});
  const [mobilePane, setMobilePane] = useState<"list" | "workspace">("list");
  const [focusNonce, setFocusNonce] = useState(0);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toastId = useRef(0);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  function later(fn: () => void, ms: number) {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  }

  function showToast(message: string, variant: ToastVariant = "success") {
    const id = ++toastId.current;
    setToast({ id, message, variant });
    later(() => setToast((t) => (t && t.id === id ? null : t)), 3200);
  }

  const selected = useMemo(
    () => articles.find((a) => a.id === selectedId) ?? null,
    [articles, selectedId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return articles.filter((a) => {
      const matchesQuery = q === "" || a.title.toLowerCase().includes(q);
      const matchesStatus = statusFilter === "all" || a.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [articles, query, statusFilter]);

  const approvedCount = useMemo(
    () => articles.filter((a) => a.status === "approved").length,
    [articles],
  );

  const brandVoice = articles.find((a) => a.coreTopic === "brand");

  // Recompute word count whenever the selected article changes.
  useEffect(() => {
    setWordCount(selected ? wordsIn(selected.content) : 0);
  }, [selectedId, selected]);

  function patchArticle(id: string, patch: Partial<Article>) {
    setArticles((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  function bumpEditor(id: string) {
    setEditorVersion((v) => ({ ...v, [id]: (v[id] ?? 0) + 1 }));
  }

  function handleSelect(id: string) {
    if (id === selectedId) {
      setMobilePane("workspace");
      return;
    }
    setSelectedId(id);
    setSaveState("saved");
    setOptimizing(false);
    setMobilePane("workspace");
  }

  // Editing an approved article invalidates the approval it already went
  // through, the same way resync flags a needs-optimization review — so any
  // title/content/category edit demotes "approved" back to "draft" here, and
  // handleSave below carries that status change to the server.
  function applyEdit(patch: Partial<Article>) {
    if (!selected) return;
    const demoted = selected.status === "approved";
    patchArticle(selected.id, demoted ? { ...patch, status: "draft" } : patch);
    setSaveState("unsaved");
    if (demoted) {
      showToast("Moved back to draft — approve again once you're happy with the changes.", "info");
    }
  }

  function handleTitleChange(title: string) {
    applyEdit({ title });
  }

  function handleContentChange(html: string, wc: number) {
    applyEdit({ content: html });
    setWordCount(wc);
  }

  function handleCategoryChange(category: KnowledgeCategory) {
    applyEdit({ category });
  }

  function handleVoiceProfileChange(patch: Partial<VoiceProfile>) {
    if (!selected) return;
    const current = selected.voiceProfile ?? EMPTY_VOICE_PROFILE;
    applyEdit({ voiceProfile: { ...current, ...patch } });
  }

  const handleToneChange = (tone: string[]) => handleVoiceProfileChange({ tone });
  const handleVoiceChange = (voice: string) => handleVoiceProfileChange({ voice });
  const handleDosChange = (dos: string[]) => handleVoiceProfileChange({ dos });
  const handleDontsChange = (donts: string[]) => handleVoiceProfileChange({ donts });

  async function handleSourceChange(sourceId: string | null) {
    if (!selected || sourceId === null || sourceId === selected.sourcePageId) return;
    const id = selected.id;
    const source = sources.find((s) => s.id === sourceId);

    patchArticle(id, { syncState: "syncing" });
    try {
      const updated = await updateArticle(id, { sourceId });
      patchArticle(id, updated);
      bumpEditor(id);
      showToast(`Imported from ${source?.title ?? "Shopify"}.`);
    } catch (error) {
      patchArticle(id, { syncState: "error" });
      showToast(knowledgeErrorMessage(error), "error");
    }
  }

  async function handleResync() {
    if (!selected?.sourcePageId) return;
    const id = selected.id;
    const source = sources.find((s) => s.id === selected.sourcePageId);

    patchArticle(id, { syncState: "syncing" });
    try {
      const updated = await resyncArticle(id);
      patchArticle(id, updated);
      bumpEditor(id);
      showToast(`Resynced from ${source?.title ?? "Shopify"}.`);
    } catch (error) {
      patchArticle(id, { syncState: "error" });
      showToast(knowledgeErrorMessage(error), "error");
    }
  }

  async function handleSave() {
    if (!selected || saveState !== "unsaved") return;
    const id = selected.id;
    const { title, content, category, status, voiceProfile } = selected;
    setSaveState("saving");
    try {
      const updated = await updateArticle(id, {
        title,
        content,
        category,
        approvalStatus: status,
        voiceProfile: selected.coreTopic === "brand" ? voiceProfile ?? EMPTY_VOICE_PROFILE : undefined,
      });
      patchArticle(id, updated);
      setSaveState("saved");
      showToast("Draft saved.");
    } catch (error) {
      setSaveState("unsaved");
      showToast(knowledgeErrorMessage(error), "error");
    }
  }

  function handleOptimize() {
    if (!selected || optimizing) return;
    const id = selected.id;
    setOptimizing(true);
    later(() => {
      const current = articles.find((a) => a.id === id);
      const tidied = current ? tidyContent(current.content) : "";
      patchArticle(id, { content: tidied });
      bumpEditor(id);
      setWordCount(wordsIn(tidied));
      setOptimizing(false);
      setSaveState("unsaved");
      showToast("Draft tidied up — review before approving.", "info");
    }, OPTIMIZE_MS);
  }

  async function handleApprove() {
    if (!selected || selected.status === "approved") return;
    const id = selected.id;
    const { title, content, category, voiceProfile } = selected;
    setSaveState("saving");
    try {
      const updated = await updateArticle(id, {
        title,
        content,
        category,
        approvalStatus: "approved",
        voiceProfile: selected.coreTopic === "brand" ? voiceProfile ?? EMPTY_VOICE_PROFILE : undefined,
      });
      patchArticle(id, updated);
      setSaveState("saved");
      showToast("Approved for the agent.");
    } catch (error) {
      setSaveState("unsaved");
      showToast(knowledgeErrorMessage(error), "error");
    }
  }

  async function handleUnapprove() {
    if (!selected || selected.status !== "approved") return;
    const id = selected.id;
    const { title, content, category, voiceProfile } = selected;
    setSaveState("saving");
    try {
      const updated = await updateArticle(id, {
        title,
        content,
        category,
        approvalStatus: "draft",
        voiceProfile: selected.coreTopic === "brand" ? voiceProfile ?? EMPTY_VOICE_PROFILE : undefined,
      });
      patchArticle(id, updated);
      setSaveState("saved");
      showToast("Unapproved — moved back to draft.");
    } catch (error) {
      setSaveState("unsaved");
      showToast(knowledgeErrorMessage(error), "error");
    }
  }

  async function handleCreate(preset?: { title: string; category: KnowledgeCategory; coreTopic: CoreTopic }) {
    if (creating) return;
    setCreating(true);
    try {
      const article = await createArticle(preset ?? {});
      setArticles((prev) => [article, ...prev]);
      setSelectedId(article.id);
      setQuery("");
      setStatusFilter("all");
      setSaveState("saved");
      setOptimizing(false);
      setMobilePane("workspace");
      setFocusNonce((n) => n + 1);
    } catch (error) {
      showToast(knowledgeErrorMessage(error), "error");
    } finally {
      setCreating(false);
    }
  }

  function handleCreateCoreTopic(topic: CoreTopic) {
    return handleCreate({
      title: CORE_TOPIC_LABELS[topic],
      category: CORE_TOPIC_DEFAULT_CATEGORY[topic],
      coreTopic: topic,
    });
  }

  async function handleDelete() {
    if (!selected || deleting) return;
    const id = selected.id;
    setDeleting(true);
    try {
      await deleteArticle(id);
      setArticles((prev) => {
        const next = prev.filter((a) => a.id !== id);
        setSelectedId(next[0]?.id ?? null);
        return next;
      });
      setMobilePane("list");
      showToast("Article deleted.");
    } catch (error) {
      showToast(knowledgeErrorMessage(error), "error");
    } finally {
      setDeleting(false);
    }
  }

  function handleClearFilters() {
    setQuery("");
    setStatusFilter("all");
  }

  if (loadError) {
    return <LoadError message={loadError} />;
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SetupHeader approved={approvedCount} total={articles.length} />

        <div className={styles.panes} data-pane={mobilePane}>
          <div className={styles.listPane}>
            <ArticleLibrary
              articles={filtered}
              totalCount={articles.length}
              query={query}
              statusFilter={statusFilter}
              selectedId={selectedId}
              onQueryChange={setQuery}
              onStatusFilterChange={setStatusFilter}
              onSelect={handleSelect}
              onCreate={() => handleCreate()}
              onCreateCoreTopic={handleCreateCoreTopic}
              onClearFilters={handleClearFilters}
            />
          </div>

          <div className={styles.workPane}>
            {selected ? (
              selected.coreTopic === "brand" ? (
                <BrandVoiceWorkspace
                  article={selected}
                  saveState={saveState}
                  optimizing={optimizing}
                  deleting={deleting}
                  wordCount={wordCount}
                  editorVersion={editorVersion[selected.id] ?? 0}
                  focusTitleNonce={focusNonce}
                  onBack={() => setMobilePane("list")}
                  onTitleChange={handleTitleChange}
                  onToneChange={handleToneChange}
                  onVoiceChange={handleVoiceChange}
                  onDosChange={handleDosChange}
                  onDontsChange={handleDontsChange}
                  onGeneralContextChange={handleContentChange}
                  onSave={handleSave}
                  onOptimize={handleOptimize}
                  onApprove={handleApprove}
                  onUnapprove={handleUnapprove}
                  onDelete={handleDelete}
                />
              ) : (
                <ArticleWorkspace
                  article={selected}
                  sources={sources}
                  saveState={saveState}
                  optimizing={optimizing}
                  deleting={deleting}
                  wordCount={wordCount}
                  editorVersion={editorVersion[selected.id] ?? 0}
                  focusTitleNonce={focusNonce}
                  brandVoiceTitle={brandVoice?.title ?? null}
                  brandVoiceApproved={brandVoice?.status === "approved"}
                  tone={brandVoice?.voiceProfile?.tone ?? []}
                  onBack={() => setMobilePane("list")}
                  onTitleChange={handleTitleChange}
                  onContentChange={handleContentChange}
                  onSourceChange={handleSourceChange}
                  onCategoryChange={handleCategoryChange}
                  onResync={handleResync}
                  onSave={handleSave}
                  onOptimize={handleOptimize}
                  onApprove={handleApprove}
                  onUnapprove={handleUnapprove}
                  onDelete={handleDelete}
                />
              )
            ) : (
              <EmptyWorkspace onCreate={() => handleCreate()} />
            )}
          </div>
        </div>
      </div>

      <Toast toast={toast} />
    </div>
  );
}
