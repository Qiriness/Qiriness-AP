"use client";

import { useMemo, useState } from "react";
import { foldForSearch } from "@/lib/insights-format";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { formatDayL } from "@/lib/insights-labels";
import type { SocialPost } from "@/lib/social-types";
import t from "./tables.module.css";
import styles from "./SocialView.module.css";

type SortKey = "views" | "reach" | "engagement" | "engagementRate" | "likes" | "comments" | "shares" | "follows";
const SORTS: SortKey[] = ["views", "reach", "engagement", "engagementRate", "likes", "comments", "shares", "follows"];

/**
 * Post Insights: every post published in the range, ranked by the column the
 * reader picks. A post's rank is its place in the current sort, so a search
 * keeps it (as Best products does). A figure the platform did not report is a
 * dash, and sorts last whichever way the column runs.
 */
export function SocialPostsTable({ posts, capped }: { posts: SocialPost[]; capped: boolean }) {
  const tr = useT();
  const locale = useLocale();
  const { integer, percentOf } = useFormat();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [sort, setSort] = useState<SortKey>("views");
  const [desc, setDesc] = useState(true);

  const types = useMemo(() => [...new Set(posts.map((p) => p.mediaType).filter(Boolean) as string[])].sort(), [posts]);
  const ranked = useMemo(() => {
    const sorted = [...posts].sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return desc ? bv - av : av - bv;
    });
    return sorted.map((post, i) => ({ post, rank: i + 1 }));
  }, [posts, sort, desc]);
  const needle = foldForSearch(query.trim());
  const shown = ranked.filter(({ post }) => (type === "all" || post.mediaType === type) && (!needle || foldForSearch(post.caption ?? "").includes(needle)));

  const n = (value: number | null) => (value === null ? "—" : integer(value));
  const header = (key: SortKey) => (
    <th key={key} className={t.n} aria-sort={sort === key ? (desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        className={styles.sortButton}
        onClick={() => {
          if (sort === key) setDesc(!desc);
          else {
            setSort(key);
            setDesc(true);
          }
        }}
      >
        {tr(`insights.social.posts.col.${key}`)} {sort === key ? (desc ? "↓" : "↑") : "↕"}
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
              {x}
            </option>
          ))}
        </select>
      </div>
      <div className={t.wrap}>
        <table className={t.table}>
          <thead>
            <tr>
              <th className={t.n}>#</th>
              <th>{tr("insights.social.posts.col.post")}</th>
              <th>{tr("insights.social.posts.col.platform")}</th>
              {SORTS.map(header)}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ post, rank }) => (
              <tr key={`${post.kind}-${post.id}`}>
                <td className={t.n}>{rank}</td>
                <th>
                  <span className={styles.postCell}>
                    {post.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- platform CDN URLs, signed and short-lived; not for next/image's optimiser
                      <img className={styles.thumb} src={post.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <span className={styles.thumb}>{(post.mediaType ?? "").slice(0, 4).toUpperCase()}</span>
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
                        {post.mediaType ? ` · ${post.mediaType}` : ""}
                      </span>
                    </span>
                  </span>
                </th>
                <td>
                  <span className={styles.badge}>{tr(`insights.social.kind.${post.kind}`)}</span>
                </td>
                <td className={t.n}>{n(post.views)}</td>
                <td className={t.n}>{n(post.reach)}</td>
                <td className={t.n}>{n(post.engagement)}</td>
                <td className={t.n}>{post.engagementRate === null ? "—" : percentOf(post.engagementRate, 1)}</td>
                <td className={t.n}>{n(post.likes)}</td>
                <td className={t.n}>{n(post.comments)}</td>
                <td className={t.n}>{n(post.shares)}</td>
                <td className={t.n}>{n(post.follows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {capped ? <p className={t.muted}>{tr("insights.social.posts.capped", { n: posts.length })}</p> : null}
    </>
  );
}
