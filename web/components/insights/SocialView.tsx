import type { ReactNode } from "react";
import { getFormat, getLocale, getT } from "@/lib/i18n/server";
import { formatMoney } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type {
  OrganicKind,
  OrganicPanel,
  OrganicTotals,
  PaidKind,
  PaidPanel,
  PaidTotals,
  PostActivity,
  SocialPost,
  SocialAudience,
  SocialPanel,
} from "@/lib/social-types";
import { BarList, BlockedCard, Caption, Card, DeltaChip, Grid, KpiCard, type Polarity } from "./InsightsKit";
import { ConnectPrompt, PlatformCardLink, SocialHeader } from "./SocialHeader";
import { BandsEditor } from "./BandsEditor";
import { MetricIcon, PlatformIcon } from "./PlatformIcon";
import { EngagementBasisSelect } from "./EngagementBasisSelect";
import { PaidCampaignsTable } from "./PaidCampaignsTable";
import { PaidTrend } from "./PaidTrend";
import { SocialPostsTable } from "./SocialPostsTable";
import { SocialTrend } from "./SocialTrend";
import o from "./OverviewView.module.css";
import t from "./tables.module.css";
import styles from "./SocialView.module.css";

/**
 * Social media: organic (Instagram, Facebook Page) and paid (Meta Ads, Google
 * Ads), laid out as the owner's mockup (HTML_DROPFILE/qiriness_social_media_
 * dashboard_mockup.html) with the house rules on top: a figure the platform did
 * not answer is a dash with its reason, paid money is never added across
 * currencies, and what moved is a rule (scripts/lib/social-figures.mjs).
 */
export function SocialView({
  panel,
  compareLabel,
  openConnections,
  connected,
  connectError,
  connectProvider,
}: {
  panel: SocialPanel;
  compareLabel: string;
  openConnections: boolean;
  connected: string | null;
  connectError: string | null;
  connectProvider: string | null;
}) {
  const kinds = panel.mode === "organic" ? panel.organic?.kinds ?? [] : panel.paid?.kinds ?? [];
  return (
    <>
      <SocialHeader
        mode={panel.mode}
        network={panel.network}
        view={panel.view}
        kinds={kinds}
        connections={panel.connections}
        openConnections={openConnections}
        connected={connected}
        connectError={connectError}
        connectProvider={connectProvider}
      />
      {panel.mode === "organic" ? (
        panel.organic ? (
          <Organic panel={panel.organic} network={panel.network as "all" | OrganicKind} view={panel.view} compareLabel={compareLabel} />
        ) : (
          <ConnectPrompt kind="organic" />
        )
      ) : panel.paid && panel.paid.kinds.length ? (
        <Paid panel={panel.paid} network={panel.network as "all" | PaidKind} compareLabel={compareLabel} />
      ) : (
        <ConnectPrompt kind="paid" />
      )}
    </>
  );
}

// --- organic -------------------------------------------------------------------

const TOP_POSTS = 9;

function Organic({
  panel,
  network,
  view,
  compareLabel,
}: {
  panel: OrganicPanel;
  network: "all" | OrganicKind;
  view: "profile" | "content" | "posts";
  compareLabel: string;
}) {
  const tr = getT();
  if (view === "posts" && network !== "all") {
    return (
      <>
        <EngagementBasisSelect kind={network} basis={panel.engagementBases[network] ?? "reach"} />
        {panel.bandRules[network] ? <BandsEditor kind={network} rules={panel.bandRules[network]!} custom={Boolean(panel.bandsCustom[network])} /> : null}
        <Card title={tr("insights.social.posts.title")} aside={<span>{tr("insights.social.posts.aside")}</span>}>
          <SocialPostsTable posts={panel.posts} capped={panel.postsCapped} tags={panel.postTags} links={panel.postTagLinks} />
        </Card>
      </>
    );
  }

  return (
    <div className={network === "all" ? undefined : styles.tinted} data-kind={network === "all" ? undefined : network}>
      {network !== "all" ? <EngagementBasisSelect kind={network} basis={panel.engagementBases[network] ?? "reach"} /> : null}
      <OrganicKpis panel={panel} network={network} compareLabel={compareLabel} />

      <Grid min={26} pin="social-trend" label={tr("insights.social.trend.title")}>
        <Card title={tr("insights.social.trend.title")} span={2} aside={<span>{tr("insights.kit.vs", { label: compareLabel })}</span>}>
          {panel.series ? (
            <SocialTrend series={panel.series} />
          ) : (
            <p className={o.chartBlocked}>{tr("insights.social.hourly")}</p>
          )}
        </Card>
        <Card title={tr("insights.social.drivers.title")}>
          <Drivers panel={panel} compareLabel={compareLabel} />
        </Card>
      </Grid>

      {network === "all" ? <PlatformCards panel={panel} /> : null}
      {network === "all" ? <TopPosts panel={panel} /> : null}
      {view === "profile" && network === "instagram" ? <Audience audience={panel.audience} /> : null}
      {view === "profile" && network !== "all" && panel.activity ? <ContentActivity activity={panel.activity} /> : null}
    </div>
  );
}

function OrganicKpis({ panel, network, compareLabel }: { panel: OrganicPanel; network: "all" | OrganicKind; compareLabel: string }) {
  const tr = getT();
  const { integer, percentOf } = getFormat();
  const c = panel.totals.current;
  const p = panel.totals.previous;
  const count = (v: number | null) => (v === null ? "—" : integer(v));
  const kpi = (label: string, key: keyof OrganicTotals, polarity: Polarity = "up", reason = "insights.social.notAnswered") => {
    const value = c[key];
    if (value === null) return <BlockedCard key={key} label={label} reason={reason} />;
    return (
      <KpiCard
        key={key}
        label={label}
        value={key === "engagementRate" ? percentOf(value, 2) : key === "growth" ? signed(value, integer) : integer(value)}
        delta={<DeltaChip current={value} previous={p?.[key]} polarity={polarity} points={key === "engagementRate"} compareLabel={compareLabel} />}
      />
    );
  };
  const reachCard = (label: string, value: number | null) =>
    value === null ? (
      <BlockedCard key={label} label={label} reason={panel.reach.blockedReason ?? "insights.social.notAnswered"} />
    ) : (
      <KpiCard key={label} label={label} value={count(value)} unit={tr("insights.social.reach.unique")} />
    );

  const cards: ReactNode[] =
    network === "instagram"
      ? [
          reachCard(tr("insights.social.kpi.accountsEngaged"), panel.reach.accountsEngaged),
          kpi(tr("insights.social.kpi.profileVisits"), "profileVisits"),
          kpi(tr("insights.social.kpi.linkTaps"), "linkTaps"),
          kpi(tr("insights.social.kpi.followers"), "followers"),
          kpi(tr("insights.social.kpi.growth"), "growth"),
          kpi(tr("insights.social.kpi.posts"), "posts", "neutral"),
        ]
      : network === "facebook"
        ? [
            reachCard(tr("insights.social.kpi.reach"), null),
            kpi(tr("insights.social.kpi.engagement"), "engagement"),
            kpi(tr("insights.social.kpi.views"), "views"),
            kpi(tr("insights.social.kpi.followers"), "followers"),
            kpi(tr("insights.social.kpi.growth"), "growth"),
            kpi(tr("insights.social.kpi.posts"), "posts", "neutral"),
          ]
        : [
            kpi(tr("insights.social.kpi.totalEngagement"), "engagement"),
            kpi(tr("insights.social.kpi.engagementRate"), "engagementRate", "up", new Set(Object.values(panel.engagementBases)).size > 1 ? "insights.social.rateMixedBasis" : "insights.social.rateNeedsData"),
            kpi(tr("insights.social.kpi.totalViews"), "views"),
            kpi(tr("insights.social.kpi.totalFollowers"), "followers"),
            kpi(tr("insights.social.kpi.growth"), "growth"),
            kpi(tr("insights.social.kpi.totalPosts"), "posts", "neutral"),
          ];

  return (
    <Grid min={11} pin="social-kpis" label={tr("insights.social.kpi.row")}>
      {cards}
    </Grid>
  );
}

function Drivers({ panel, compareLabel }: { panel: OrganicPanel; compareLabel: string }) {
  const tr = getT();
  const { decimal, percentOf } = getFormat();
  return (
    <>
      <ul className={o.drivers}>
        {panel.drivers.map((d) => {
          const blocked = d.change === null;
          const tone = blocked ? o.flat : d.change! >= 0 ? o.up : o.down;
          const text = blocked
            ? "—"
            : d.points
              ? `${d.change! >= 0 ? "+" : "−"}${decimal(Math.abs(d.change!), 1)} ${tr("insights.kit.pts")}`
              : `${d.change! >= 0 ? "+" : "−"}${percentOf(Math.abs(d.change!), 1)}`;
          return (
            <li key={d.key} className={o.driver}>
              <span className={o.driverLabel}>
                <b>{tr(`insights.social.drivers.${d.key}`)}</b>
                <span>{tr(`insights.social.drivers.${d.key}Hint`)}</span>
              </span>
              <span className={`${o.track} ${blocked ? o.trackBlocked : ""}`}>
                {blocked ? null : (
                  <i className={d.change! < 0 ? o.fillNeg : o.fill} style={{ width: `${Math.max(3, (d.share ?? 0) * 100).toFixed(1)}%` }} />
                )}
              </span>
              <span className={`${o.driverValue} ${tone}`} title={blocked ? tr("insights.social.drivers.notComparable") : undefined}>
                {text}
              </span>
            </li>
          );
        })}
      </ul>
      <p className={o.callout}>
        {tr(`insights.social.drivers.summary.${panel.driverSummary}`)} {panel.driverSummary === "none" ? null : tr("insights.kit.vs", { label: compareLabel })}
      </p>
    </>
  );
}

function PlatformCards({ panel }: { panel: OrganicPanel }) {
  const tr = getT();
  const { integer, percentOf } = getFormat();
  const count = (v: number | null) => (v === null ? "—" : integer(v));
  return (
    <>
      <h2 className={styles.sectionTitle}>{tr("insights.social.platforms.title")}</h2>
      <Grid min={20} pin="social-platforms" label={tr("insights.social.platforms.title")}>
        {panel.byKind.map(({ kind, totals }) => {
          const c = totals.current;
          const reach = kind === "instagram" ? panel.reach.reach : null;
          return (
            <PlatformCardLink key={kind} kind={kind} label={tr(`insights.social.kind.${kind}`)}>
              <dl className={styles.miniGrid}>
                <Mini label={tr("insights.social.kpi.followers")} value={count(c.followers)} />
                <Mini label={tr("insights.social.kpi.views")} value={count(c.views)} />
                <Mini label={tr("insights.social.kpi.posts")} value={count(c.posts)} />
                <Mini label={tr("insights.social.kpi.engagement")} value={count(c.engagement)} />
                <Mini label={`${tr("insights.social.kpi.rate")} · ${tr(`insights.social.rateBasis.${panel.engagementBases[kind] ?? "reach"}.short`)}`} value={c.engagementRate === null ? "—" : percentOf(c.engagementRate, 1)} />
                <Mini label={tr("insights.social.kpi.reach")} value={count(reach)} />
              </dl>
              <div className={styles.growth}>
                <span>{tr("insights.social.kpi.growth")}</span>
                <strong className={c.growth === null ? o.flat : c.growth >= 0 ? o.up : o.down}>{c.growth === null ? "—" : signed(c.growth, integer)}</strong>
              </div>
            </PlatformCardLink>
          );
        })}
      </Grid>
    </>
  );
}

/**
 * The period's nine best posts across every platform, as cards: three to a row,
 * a platform-coloured edge, the platform's icon (not its name), the type, the
 * rank, the views / likes / comments, the engagement rate and a link to the
 * post. Each post's rate is under ITS platform's chosen basis (followers, reach
 * or views), which the card names. A post with no rate (a missing half) cannot
 * be ranked and is left out; the caption says how many.
 */
function TopPosts({ panel }: { panel: OrganicPanel }) {
  const tr = getT();
  const { integer, percentOf } = getFormat();
  const rated = panel.posts.filter((p) => p.engagementRate !== null);
  const top = [...rated].sort((a, b) => b.engagementRate! - a.engagementRate! || Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, TOP_POSTS);
  const count = (v: number | null) => (v === null ? "—" : integer(v));
  const mixed = new Set(Object.values(panel.engagementBases)).size > 1;
  const typeName = (post: SocialPost) => (post.mediaType === "image" ? tr("insights.social.posts.mediaType.image") : post.mediaType ?? "");
  return (
    <Card title={tr("insights.social.top.title", { n: TOP_POSTS })} aside={<span>{tr("insights.social.top.aside")}</span>}>
      {top.length === 0 ? (
        <p className={t.muted}>{panel.posts.length === 0 ? tr("insights.social.posts.none") : tr("insights.social.top.noRate")}</p>
      ) : (
        <ol className={styles.topGrid}>
          {top.map((post, i) => (
            <li key={`${post.accountId}-${post.id}`} className={styles.topCard} data-kind={post.kind}>
              <div className={styles.topHead}>
                <PlatformIcon kind={post.kind} size={22} label={tr(`insights.social.kind.${post.kind}`)} />
                {post.mediaType ? <span className={styles.topType}>{typeName(post)}</span> : null}
                <span className={styles.topRank}>#{i + 1}</span>
              </div>
              <div className={styles.topBody}>
                {post.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- platform CDN URLs, signed and short-lived; not for next/image's optimiser
                  <img className={styles.topThumb} src={post.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span className={styles.topThumb}>{typeName(post).slice(0, 4).toUpperCase()}</span>
                )}
                <p className={styles.topCaption}>{post.caption ?? tr("insights.social.posts.noCaption")}</p>
              </div>
              <ul className={styles.topFigures} aria-label={tr("insights.social.top.figures")}>
                <li title={tr("insights.social.posts.col.views")}>
                  <MetricIcon name="views" />
                  {count(post.views)}
                  <span className={t.srOnly}> {tr("insights.social.posts.col.views")}</span>
                </li>
                <li title={tr("insights.social.posts.col.likes")}>
                  <MetricIcon name="likes" />
                  {count(post.likes)}
                  <span className={t.srOnly}> {tr("insights.social.posts.col.likes")}</span>
                </li>
                <li title={tr("insights.social.posts.col.comments")}>
                  <MetricIcon name="comments" />
                  {count(post.comments)}
                  <span className={t.srOnly}> {tr("insights.social.posts.col.comments")}</span>
                </li>
              </ul>
              <div className={styles.topFoot}>
                <span className={styles.topRate}>
                  <strong>{percentOf(post.engagementRate!, 1)}</strong> {tr("insights.social.top.engagement")}
                  <small> · {tr(`insights.social.rateBasis.${post.engagementBasis}.short`)}</small>
                </span>
                {post.permalink ? (
                  <a className={styles.topLink} href={post.permalink} target="_blank" rel="noreferrer">
                    <MetricIcon name="open" />
                    {tr("insights.social.top.view")}
                    <span className={t.srOnly}> ({tr(`insights.social.posts.open.${post.kind}`)})</span>
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
      {top.length > 0 ? (
        <Caption>
          {tr(mixed ? "insights.social.top.captionMixed" : "insights.social.top.caption", { rated: rated.length, total: panel.posts.length })}
          {panel.postsCapped ? ` ${tr("insights.social.top.capped", { n: panel.posts.length })}` : ""}
        </Caption>
      ) : null}
    </Card>
  );
}

function Mini({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Audience({ audience }: { audience: SocialAudience | null }) {
  const tr = getT();
  const { percentOf, integer } = getFormat();
  if (!audience) {
    return (
      <Card title={tr("insights.social.audience.title")}>
        <p className={t.muted}>{tr("insights.social.audience.none")}</p>
      </Card>
    );
  }
  const dims = ["gender", "age", "country", "city"] as const;
  return (
    <>
      <h2 className={styles.sectionTitle}>
        {tr("insights.social.audience.title")} <span className={styles.asOf}>{tr("insights.social.audience.asOf", { date: audience.capturedOn ?? "—" })}</span>
      </h2>
      <Grid min={14} pin="social-audience" label={tr("insights.social.audience.title")}>
        {dims.map((dim) => (
          <Card key={dim} title={tr(`insights.social.audience.${dim}`)}>
            {audience[dim].length ? (
              <BarList
                ariaLabel={tr(`insights.social.audience.${dim}`)}
                data={audience[dim].map((b) => ({
                  key: b.key,
                  label: dim === "gender" ? tr(`insights.social.audience.gender.${b.key}`) : b.key,
                  value: b.share,
                  display: percentOf(b.share, 1),
                  title: integer(b.value),
                }))}
              />
            ) : (
              <p className={t.muted}>{tr("insights.social.audience.dimNone")}</p>
            )}
          </Card>
        ))}
      </Grid>
      <Caption>{tr("insights.social.audience.caption")}</Caption>
    </>
  );
}

/**
 * The mix and timing of the period's posts, for one platform: how many of each
 * type, how many under each of the team's tags, and the hours and weekdays whose
 * posts earned the most engagement on average. Peak times are when posts went
 * out, not when people reacted (Meta timestamps no like): the caption says so.
 */
function ContentActivity({ activity }: { activity: PostActivity }) {
  const tr = getT();
  const { integer } = getFormat();
  const hour = (h: number) => `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;
  const typeLabel = (key: string) => (key === "image" ? tr("insights.social.posts.mediaType.image") : key);
  const posts = (n: number) => tr("insights.social.activity.posts", { n: integer(n) });
  const peaks = (rows: PostActivity["peakHours"], label: (slot: number) => string) =>
    rows.map((r) => ({
      key: String(r.slot),
      label: label(r.slot),
      value: r.average,
      display: tr("insights.social.activity.avg", { avg: integer(Math.round(r.average)), posts: posts(r.posts) }),
    }));
  const counts = (rows: { key: string; label: string; n: number }[]) =>
    rows.map((r) => ({ key: r.key, label: r.label, value: r.n, display: posts(r.n) }));
  const tagRows = [
    ...activity.byTag.map((x) => ({ key: x.id, label: x.name, n: x.posts })),
    ...(activity.untagged > 0 ? [{ key: "untagged", label: tr("insights.social.posts.tags.untagged"), n: activity.untagged }] : []),
  ];
  return (
    <>
      <h2 className={styles.sectionTitle}>{tr("insights.social.activity.title")}</h2>
      {activity.total === 0 ? (
        <p className={t.muted}>{tr("insights.social.posts.none")}</p>
      ) : (
        <>
          <Grid min={14} pin="social-activity" label={tr("insights.social.activity.title")}>
            <Card title={tr("insights.social.activity.byType")}>
              <BarList ariaLabel={tr("insights.social.activity.byType")} data={counts(activity.byType.map((x) => ({ key: x.key, label: typeLabel(x.key), n: x.posts })))} />
            </Card>
            <Card title={tr("insights.social.activity.byTag")}>
              {activity.byTag.length ? (
                <BarList ariaLabel={tr("insights.social.activity.byTag")} data={counts(tagRows)} />
              ) : (
                <p className={t.muted}>{tr("insights.social.activity.noTags")}</p>
              )}
            </Card>
            <Card title={tr("insights.social.activity.peakHours")}>
              {activity.peakHours.length ? (
                <BarList ariaLabel={tr("insights.social.activity.peakHours")} data={peaks(activity.peakHours, hour)} />
              ) : (
                <p className={t.muted}>{tr("insights.social.activity.noEngagement")}</p>
              )}
            </Card>
            <Card title={tr("insights.social.activity.peakDays")}>
              {activity.peakDays.length ? (
                <BarList ariaLabel={tr("insights.social.activity.peakDays")} data={peaks(activity.peakDays, (d) => tr(`insights.social.activity.day.${d}`))} />
              ) : (
                <p className={t.muted}>{tr("insights.social.activity.noEngagement")}</p>
              )}
            </Card>
          </Grid>
          <Caption>{tr("insights.social.activity.caption")}</Caption>
        </>
      )}
    </>
  );
}

// --- paid --------------------------------------------------------------------------

function Paid({ panel, network, compareLabel }: { panel: PaidPanel; network: "all" | PaidKind; compareLabel: string }) {
  const tr = getT();
  const locale = getLocale();
  const { integer, percentOf, decimal } = getFormat();
  const current = panel.totals.current;
  const previous = panel.totals.previous;
  const single = current.length === 1 ? current[0] : null;
  const prevSingle = single && previous ? previous.find((x) => x.currency === single.currency) ?? null : null;
  const sum = (list: PaidTotals[] | null, key: "impressions" | "clicks" | "conversions") => (list ? list.reduce((a, b) => a + b[key], 0) : null);
  const impressions = sum(current, "impressions") ?? 0;
  const clicks = sum(current, "clicks") ?? 0;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const prevImpressions = sum(previous, "impressions");
  const prevClicks = sum(previous, "clicks");
  const prevCtr = prevImpressions && prevClicks !== null ? (prevClicks / prevImpressions) * 100 : null;
  const money = (value: number | null, currency: string) => (value === null ? "—" : formatMoney(value, currency, locale as Locale, { maximumFractionDigits: 2 }));

  const mixed = current.length > 1;
  const empty = current.length === 0;

  return (
    <>
      <Grid min={11} pin="paid-kpis" label={tr("insights.social.paid.kpiRow")}>
        {single ? (
          <KpiCard
            label={tr("insights.social.paid.spend")}
            value={money(single.spend, single.currency)}
            delta={<DeltaChip current={single.spend} previous={prevSingle?.spend} polarity="neutral" compareLabel={compareLabel} />}
          />
        ) : (
          <BlockedCard label={tr("insights.social.paid.spend")} reason={empty ? "insights.social.paid.noSpend" : "insights.social.paid.mixedCurrency"} />
        )}
        <KpiCard
          label={tr("insights.social.paid.impressions")}
          value={integer(impressions)}
          delta={<DeltaChip current={impressions} previous={prevImpressions} polarity="up" compareLabel={compareLabel} />}
        />
        <KpiCard
          label={tr("insights.social.paid.clicks")}
          value={integer(clicks)}
          delta={<DeltaChip current={clicks} previous={prevClicks} polarity="up" compareLabel={compareLabel} />}
        />
        <KpiCard
          label={tr("insights.social.paid.ctr")}
          value={ctr === null ? "—" : percentOf(ctr, 2)}
          delta={<DeltaChip current={ctr} previous={prevCtr} polarity="up" points compareLabel={compareLabel} />}
        />
        <KpiCard
          label={tr("insights.social.paid.conversions")}
          value={decimal(sum(current, "conversions") ?? 0, 0)}
          delta={<DeltaChip current={sum(current, "conversions")} previous={sum(previous, "conversions")} polarity="up" compareLabel={compareLabel} />}
        />
        {single && single.roas !== null ? (
          <KpiCard
            label={tr("insights.social.paid.roas")}
            value={`${decimal(single.roas, 2)}×`}
            delta={<DeltaChip current={single.roas} previous={prevSingle?.roas} polarity="up" compareLabel={compareLabel} />}
          />
        ) : (
          <BlockedCard label={tr("insights.social.paid.roas")} reason={mixed ? "insights.social.paid.mixedCurrency" : "insights.social.paid.noSpend"} />
        )}
      </Grid>

      <Grid min={26} pin="paid-trend" label={tr("insights.social.paid.trend")}>
        <Card title={tr("insights.social.paid.trend")} span={2} aside={<span>{tr("insights.social.paid.trendAside")}</span>}>
          {panel.series && panel.currency ? (
            <PaidTrend series={panel.series} currency={panel.currency} />
          ) : (
            <p className={o.chartBlocked}>{tr(panel.seriesBlockedReason ?? "insights.social.paid.noSpend")}</p>
          )}
        </Card>
        <Card title={tr("insights.social.paid.efficiency")}>
          {single ? (
            <ul className={styles.efficiency}>
              <Efficiency label={tr("insights.social.paid.roas")} hint={tr("insights.social.paid.roasHint")} value={single.roas === null ? "—" : `${decimal(single.roas, 2)}×`}
                delta={<DeltaChip current={single.roas} previous={prevSingle?.roas} polarity="up" compareLabel={compareLabel} />} />
              <Efficiency label={tr("insights.social.paid.ctr")} hint={tr("insights.social.paid.ctrHint")} value={single.ctr === null ? "—" : percentOf(single.ctr, 2)}
                delta={<DeltaChip current={single.ctr} previous={prevSingle?.ctr} polarity="up" points compareLabel={compareLabel} />} />
              <Efficiency label={tr("insights.social.paid.cpc")} hint={tr("insights.social.paid.cpcHint")} value={money(single.cpc, single.currency)}
                delta={<DeltaChip current={single.cpc} previous={prevSingle?.cpc} polarity="down" compareLabel={compareLabel} />} />
              <Efficiency label={tr("insights.social.paid.cpa")} hint={tr("insights.social.paid.cpaHint")} value={money(single.cpa, single.currency)}
                delta={<DeltaChip current={single.cpa} previous={prevSingle?.cpa} polarity="down" compareLabel={compareLabel} />} />
            </ul>
          ) : (
            <p className={t.muted}>{tr(mixed ? "insights.social.paid.mixedCurrency" : "insights.social.paid.noSpend")}</p>
          )}
          <p className={o.callout}>{tr("insights.social.paid.attribution")}</p>
        </Card>
      </Grid>

      {network === "all" && panel.byKind.length > 0 ? (
        <Card title={tr("insights.social.paid.byPlatform")}>
          <div className={t.wrap}>
            <table className={t.table}>
              <thead>
                <tr>
                  <th>{tr("insights.social.paid.platform")}</th>
                  <th className={t.n}>{tr("insights.social.paid.spend")}</th>
                  <th className={t.n}>{tr("insights.social.paid.impressions")}</th>
                  <th className={t.n}>{tr("insights.social.paid.clicks")}</th>
                  <th className={t.n}>{tr("insights.social.paid.conversions")}</th>
                  <th className={t.n}>{tr("insights.social.paid.revenue")}</th>
                  <th className={t.n}>{tr("insights.social.paid.roas")}</th>
                </tr>
              </thead>
              <tbody>
                {panel.byKind.flatMap(({ kind, totals }) =>
                  totals.current.length === 0
                    ? [
                        <tr key={kind}>
                          <th>{tr(`insights.social.kind.${kind}`)}</th>
                          <td className={t.n} colSpan={6}>
                            <span className={t.muted}>{tr("insights.social.paid.noSpend")}</span>
                          </td>
                        </tr>,
                      ]
                    : totals.current.map((row) => (
                        <tr key={`${kind}-${row.currency}`}>
                          <th>
                            {tr(`insights.social.kind.${kind}`)}
                            {totals.current.length > 1 ? <span className={t.sub}>{row.currency}</span> : null}
                          </th>
                          <td className={t.n}>{money(row.spend, row.currency)}</td>
                          <td className={t.n}>{integer(row.impressions)}</td>
                          <td className={t.n}>{integer(row.clicks)}</td>
                          <td className={t.n}>{decimal(row.conversions, 0)}</td>
                          <td className={t.n}>{money(row.conversionValue, row.currency)}</td>
                          <td className={t.n}>{row.roas === null ? "—" : `${decimal(row.roas, 2)}×`}</td>
                        </tr>
                      ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card title={tr("insights.social.campaigns.title")} aside={<span>{tr("insights.social.campaigns.aside")}</span>}>
        {panel.campaignsBlockedReason ? (
          <p className={t.muted}>{tr(panel.campaignsBlockedReason)}</p>
        ) : (
          <PaidCampaignsTable campaigns={panel.campaigns} capped={panel.campaignsCapped} />
        )}
      </Card>
    </>
  );
}

function Efficiency({ label, hint, value, delta }: { label: string; hint: string; value: string; delta: ReactNode }) {
  return (
    <li>
      <span className={o.driverLabel}>
        <b>{label}</b>
        <span>{hint}</span>
      </span>
      <span className={styles.effValue}>
        <strong>{value}</strong>
        {delta}
      </span>
    </li>
  );
}

function signed(value: number, integer: (n: number) => string): string {
  return value > 0 ? `+${integer(value)}` : value < 0 ? `−${integer(Math.abs(value))}` : integer(0);
}

