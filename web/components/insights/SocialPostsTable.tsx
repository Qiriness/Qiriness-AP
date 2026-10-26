"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { foldForSearch } from "@/lib/insights-format";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { formatDayL } from "@/lib/insights-labels";
import type { Band, BandMetric, SocialPost, SocialTag, SocialTagLink, ManualPostMetric } from "@/lib/social-types";
import { ManualMetricCell } from "./ManualMetricCell";
import { applySavedPostMetrics } from '../../../scripts/lib/social-post-manual.mjs';
import t from "./tables.module.css";
import styles from "./SocialView.module.css";
import { useInsightsFrame } from "./InsightsFrame";

type MetricKey = "views" | "reach" | "engagementRate" | "likes" | "comments" | "shares" | "follows" | "engagement" | "nonFollowersPct";
type SortKey = "published" | MetricKey;
/** The metric columns, in the order the team reads them. */
const METRICS: MetricKey[] = ["views", "reach", "engagementRate", "likes", "comments", "shares", "follows", "engagement", "nonFollowersPct"];

/** What the team calls a stored media type; the stored value (`image`) is unchanged, so filters keep matching. */
const TYPE_LABELS: Record<string, string> = { image: "insights.social.posts.mediaType.image" };

const postKey = (accountId: string, postId: string) => `${accountId}|${postId}`;
const sortValue = (post: SocialPost, key: SortKey) => (key === "published" ? Date.parse(post.publishedAt) : post[key]);

/**
 * Post Insights: every post published in the range, ranked by the column the
 * reader picks. # is the post's place in the current sort — by views, 1 is the
 * most viewed; by # itself, 1 is the newest — so a search or a filter keeps it
 * (as Best products does). A figure the platform did not report is a dash, and
 * sorts last whichever way the column runs; ties fall back to newest first.
 *
 * Tags are the team's own (81_social_post_tags.sql): made and applied here,
 * written at once, held in this component so a tag shows without a reload.
 */
export function SocialPostsTable({
  posts: listed,
  capped,
  tags: initialTags,
  links: initialLinks,
}: {
  posts: SocialPost[];
  capped: boolean;
  tags: SocialTag[];
  links: SocialTagLink[];
}) {
  const { api } = useInsightsFrame();
  const tr = useT();
  const locale = useLocale();
  const router = useRouter();
  const { integer, percentOf } = useFormat();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>("views");
  const [desc, setDesc] = useState(true);
  const [tags, setTags] = useState(initialTags);
  const [links, setLinks] = useState(initialLinks);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMetrics,setSavedMetrics] = useState<Record<string,Partial<Record<ManualPostMetric,{value:number|null;basis:SocialPost['engagementBasis']}>>>>({});
  const posts = useMemo(() => listed.map(post => applySavedPostMetrics(post,
    Object.entries(savedMetrics[postKey(post.accountId,post.id)] ?? {}).map(([metric,entry]) => ({metric,...entry}))
  ) as SocialPost),[listed,savedMetrics]);

  useEffect(() => setTags(initialTags), [initialTags]);
  useEffect(() => setLinks(initialLinks), [initialLinks]);

  const tagsByPost = useMemo(() => {
    const byId = new Map(tags.map((tag) => [tag.id, tag]));
    const map = new Map<string, SocialTag[]>();
    for (const link of links) {
      const tag = byId.get(link.tagId);
      if (!tag) continue;
      const key = postKey(link.accountId, link.postId);
      map.set(key, [...(map.get(key) ?? []), tag].sort((a, b) => a.name.localeCompare(b.name)));
    }
    return map;
  }, [tags, links]);

  const types = useMemo(() => [...new Set(posts.map((p) => p.mediaType).filter(Boolean) as string[])].sort(), [posts]);
  const ranked = useMemo(() => {
    const sorted = [...posts].sort((a, b) => {
      const av = sortValue(a, sort);
      const bv = sortValue(b, sort);
      if (av === null && bv === null) return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av !== bv) return desc ? bv - av : av - bv;
      return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    });
    return sorted.map((post, i) => ({ post, rank: i + 1 }));
  }, [posts, sort, desc]);
  const needle = foldForSearch(query.trim());
  const shown = ranked.filter(
    ({ post }) =>
      (type === "all" || post.mediaType === type) &&
      (tagFilter === "all" ||
        (tagFilter === "none"
          ? !tagsByPost.has(postKey(post.accountId, post.id))
          : (tagsByPost.get(postKey(post.accountId, post.id)) ?? []).some((tag) => tag.id === tagFilter))) &&
      (!needle || foldForSearch(post.caption ?? "").includes(needle))
  );

  async function call(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setError(null);
    try {
      const response = await fetch(api(url), { ...init, headers: { "Content-Type": "application/json" } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      return body;
    } catch (e) {
      setError(tr("insights.social.posts.changeFailed", { reason: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }

  async function toggle(post: SocialPost, tag: SocialTag, tagged: boolean) {
    const link = { tagId: tag.id, accountId: post.accountId, postId: post.id };
    const same = (l: SocialTagLink) => l.tagId === link.tagId && l.accountId === link.accountId && l.postId === link.postId;
    const before = links;
    setLinks(tagged ? [...links.filter((l) => !same(l)), link] : links.filter((l) => !same(l)));
    const ok = await call(`/api/insights/social/tags/${tag.id}/posts`, { method: "PUT", body: JSON.stringify({ accountId: post.accountId, postId: post.id, tagged }) });
    if (!ok) setLinks(before);
    else router.refresh();
  }

  async function saveMetric(post: SocialPost, metric: ManualPostMetric, value: number | null): Promise<boolean> {
    const body = await call("/api/insights/social/manual-metrics", { method: "PUT", body: JSON.stringify({ accountId: post.accountId, postId: post.id, metric, value }) });
    if (!body) return false;
    const key=postKey(post.accountId,post.id);
    setSavedMetrics(current=>({...current,[key]:{...current[key],[metric]:{value:body.value as number|null,basis:post.engagementBasis}}}));
    router.refresh();
    return true;
  }

  async function create(post: SocialPost, name: string) {
    const body = await call("/api/insights/social/tags", { method: "POST", body: JSON.stringify({ name }) });
    const tag = body?.tag as SocialTag | undefined;
    if (!tag) return;
    setTags((current) => (current.some((x) => x.id === tag.id) ? current : [...current, tag].sort((a, b) => a.name.localeCompare(b.name))));
    await toggle(post, tag, true);
  }

  async function remove(tag: SocialTag) {
    const ok = await call(`/api/insights/social/tags/${tag.id}`, { method: "DELETE" });
    if (!ok) return;
    setTags((current) => current.filter((x) => x.id !== tag.id));
    setLinks((current) => current.filter((l) => l.tagId !== tag.id));
    if (tagFilter === tag.id) setTagFilter("all");
    router.refresh();
  }

  const typeLabel = (value: string) => (TYPE_LABELS[value] ? tr(TYPE_LABELS[value]) : value);
  const BAND_CLASS: Record<Band, string> = { low: styles.bandLow, medium: styles.bandMedium, high: styles.bandHigh };
  const cell = (post: SocialPost, metric: MetricKey) => {
    const band = post.bands[metric as BandMetric];
    const manual = post.manualMetrics?.includes(metric) ?? false;
    const percentage = metric === "engagementRate" || metric === "nonFollowersPct";
    const value = post[metric];
    const display = value === null ? "—" : percentage ? percentOf(value, 1) : integer(value);
    return <ManualMetricCell key={metric} metric={metric} value={value} display={display}
      manual={manual || (metric === 'engagementRate' && !!post.rateFromManual)}
      editable={value === null || manual}
      className={`${t.n} ${band ? BAND_CLASS[band] : ""}`}
      bandLabel={band ? tr(`insights.social.band.${band}`) : undefined}
      onSave={(next) => saveMetric(post, metric, next)} />;
  };
  const sortHeader = (key: SortKey, label: string, className?: string) => (
    <th key={key} className={className} aria-sort={sort === key ? (desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        className={styles.sortButton}
        title={key === "published" ? tr("insights.social.posts.col.rankHint") : undefined}
        onClick={() => {
          if (sort === key) setDesc(!desc);
          else {
            setSort(key);
            setDesc(true);
          }
        }}
      >
        {label} {sort === key ? (desc ? "↓" : "↑") : "↕"}
      </button>
    </th>
  );

  if (posts.length === 0) return <p className={t.muted}>{tr("insights.social.posts.none")}</p>;

  return (
    <>
      <div className={styles.tableTools}>
        <input
          className={styles.search}
          type="search"
          placeholder={tr("insights.social.posts.search")}
          aria-label={tr("insights.social.posts.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className={styles.select} value={type} onChange={(e) => setType(e.target.value)} aria-label={tr("insights.social.posts.type")}>
          <option value="all">{tr("insights.social.posts.allTypes")}</option>
          {types.map((x) => (
            <option key={x} value={x}>
              {typeLabel(x)}
            </option>
          ))}
        </select>
        <select className={styles.select} value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label={tr("insights.social.posts.tags.filter")}>
          <option value="all">{tr("insights.social.posts.tags.all")}</option>
          <option value="none">{tr("insights.social.posts.tags.untagged")}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p className={styles.tagError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              {sortHeader("published", "#", t.n)}
              <th>{tr("insights.social.posts.col.post")}</th>
              <th>{tr("insights.social.posts.col.platform")}</th>
              <th>{tr("insights.social.posts.col.tags")}</th>
              {METRICS.map((key) => sortHeader(key, tr(`insights.social.posts.col.${key}`), t.n))}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ post, rank }) => {
              const key = postKey(post.accountId, post.id);
              const onPost = tagsByPost.get(key) ?? [];
              return (
                <tr key={`${post.kind}-${key}`}>
                  <td className={t.n}>{rank}</td>
                  <th>
                    <span className={styles.postCell}>
                      {post.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- platform CDN URLs, signed and short-lived; not for next/image's optimiser
                        <img className={styles.thumb} src={post.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <span className={styles.thumb}>{typeLabel(post.mediaType ?? "").slice(0, 4).toUpperCase()}</span>
                      )}
                      <span className={styles.postCopy}>
                        {post.permalink ? (
                          <a href={post.permalink} target="_blank" rel="noreferrer" title={tr(`insights.social.posts.open.${post.kind}`)}>
                            {post.caption ?? tr("insights.social.posts.noCaption")}
                            <span className={styles.external} aria-hidden="true">
                              ↗
                            </span>
                            <span className={t.srOnly}> ({tr(`insights.social.posts.open.${post.kind}`)})</span>
                          </a>
                        ) : (
                          <strong>{post.caption ?? tr("insights.social.posts.noCaption")}</strong>
                        )}
                        <span className={t.sub}>
                          {formatDayL(new Date(post.publishedAt), locale)}
                          {post.mediaType ? ` · ${typeLabel(post.mediaType)}` : ""}
                        </span>
                      </span>
                    </span>
                  </th>
                  <td>
                    <span className={styles.badge}>{tr(`insights.social.kind.${post.kind}`)}</span>
                  </td>
                  <td>
                    <span className={styles.tagCell}>
                      {onPost.map((tag) => (
                        <span key={tag.id} className={styles.tag}>
                          {tag.name}
                        </span>
                      ))}
                      <TagEditor
                        open={editing === key}
                        onOpen={() => setEditing(editing === key ? null : key)}
                        onClose={() => setEditing(null)}
                        tags={tags}
                        selected={new Set(onPost.map((tag) => tag.id))}
                        onToggle={(tag, tagged) => toggle(post, tag, tagged)}
                        onCreate={(name) => create(post, name)}
                        onDelete={remove}
                      />
                    </span>
                  </td>
                  {METRICS.map((metric) => cell(post, metric))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {capped ? <p className={t.muted}>{tr("insights.social.posts.capped", { n: posts.length })}</p> : null}
    </>
  );
}

/**
 * The « + » on a post's tag cell: tick a tag on or off, type a name to make one
 * (Enter), or delete a tag everywhere — that asks twice, since it cannot be
 * undone and takes the tag off every post.
 */
function TagEditor({
  open,
  onOpen,
  onClose,
  tags,
  selected,
  onToggle,
  onCreate,
  onDelete,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  tags: SocialTag[];
  selected: Set<string>;
  onToggle: (tag: SocialTag, tagged: boolean) => void;
  onCreate: (name: string) => Promise<void>;
  onDelete: (tag: SocialTag) => void;
}) {
  const tr = useT();
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const menu = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // The menu is drawn on <body>, fixed to the button's place on screen. Inside
  // the table it was both cut off (the table scrolls sideways) and, under an
  // ancestor with a transform, positioned against that ancestor instead of the
  // window: it opened in the middle of the page. A scroll outside the menu
  // closes it rather than leaving it behind.
  useEffect(() => {
    if (!open) {
      setName("");
      setConfirming(null);
      setAt(null);
      return;
    }
    const rect = button.current?.getBoundingClientRect();
    if (rect) {
      const width = 224;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = window.innerHeight - rect.bottom > 300 || rect.top < 300;
      setAt(below ? { left, top: rect.bottom + 4 } : { left, bottom: window.innerHeight - rect.top + 4 });
    }
    const inside = (target: EventTarget | null) => Boolean(target) && (menu.current?.contains(target as Node) || button.current?.contains(target as Node));
    const outside = (e: MouseEvent) => {
      if (!inside(e.target)) onClose();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const scrolled = (e: Event) => {
      if (!inside(e.target)) onClose();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, [open, onClose]);

  const trimmed = name.trim();
  const exists = tags.find((tag) => tag.name.toLowerCase() === trimmed.toLowerCase());

  return (
    <span className={styles.tagEditor}>
      <button ref={button} type="button" className={styles.tagAdd} aria-expanded={open} aria-label={tr("insights.social.posts.tags.edit")} title={tr("insights.social.posts.tags.edit")} onClick={onOpen}>
        +
      </button>
      {open && at
        ? createPortal(
        <span ref={menu} className={styles.tagMenu} style={at} role="dialog" aria-label={tr("insights.social.posts.tags.edit")}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!trimmed || busy) return;
              if (exists) {
                if (!selected.has(exists.id)) onToggle(exists, true);
              } else {
                setBusy(true);
                await onCreate(trimmed);
                setBusy(false);
              }
              setName("");
            }}
          >
            <input
              className={styles.tagInput}
              autoFocus
              maxLength={40}
              placeholder={tr("insights.social.posts.tags.newPlaceholder")}
              aria-label={tr("insights.social.posts.tags.newPlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </form>
          {tags.length === 0 ? <span className={styles.tagEmpty}>{tr("insights.social.posts.tags.empty")}</span> : null}
          {tags.map((tag) => (
            <span key={tag.id} className={styles.tagOption}>
              <label>
                <input type="checkbox" checked={selected.has(tag.id)} onChange={(e) => onToggle(tag, e.target.checked)} />
                {tag.name}
              </label>
              {confirming === tag.id ? (
                <button type="button" className={styles.tagDeleteConfirm} onClick={() => onDelete(tag)}>
                  {tr("insights.social.posts.tags.deleteConfirm")}
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.tagDelete}
                  aria-label={tr("insights.social.posts.tags.delete", { name: tag.name })}
                  title={tr("insights.social.posts.tags.delete", { name: tag.name })}
                  onClick={() => setConfirming(tag.id)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </span>,
        document.body
      )
        : null}
    </span>
  );
}
