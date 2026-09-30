import Link from "next/link";
import type { AgentRoster, AgentRosterRow } from "@/lib/server/agent-settings-service";
import type { KlaviyoStatus } from "@/lib/server/integrations-service";
import { Caption, Card, EmptyState, Grid, KpiCard, PanelError } from "../insights/InsightsKit";
import { LanguageSwitch } from "@/components/app-shell/LanguageSwitch";
import { getFormat, getT } from "@/lib/i18n/server";
import header from "../insights/InsightsHeader.module.css";
import t from "../insights/tables.module.css";
import { KlaviyoKeyCard } from "./KlaviyoKeyCard";
import styles from "./SettingsView.module.css";

export type SettingsTab = "me" | "agents" | "integrations";

export interface SettingsMe {
  name: string | null;
  email: string | null;
  /** The role's key (`developer` | `management` | `contact`); its words are `role.<key>`. */
  role: string;
  /** Each area's dictionary key (`settings.area.<id>`) and whether the role may open it. */
  access: { id: string; allowed: boolean }[];
}

// Tab words: `settings.tab.<id>`.
const TABS: { id: SettingsTab; href: string }[] = [
  { id: "me", href: "/settings" },
  { id: "agents", href: "/settings?tab=agents" },
  { id: "integrations", href: "/settings?tab=integrations" },
];

/**
 * Settings, built from the Insights kit — the same page frame, tab bar, cards
 * and tables — so it reads as part of the dashboard rather than a form page.
 * Server-rendered: the tabs are plain links and nothing here holds state.
 */
export function SettingsView({
  tab,
  me,
  roster,
  klaviyo,
  canManageIntegrations,
}: {
  tab: SettingsTab;
  me: SettingsMe | null;
  roster: AgentRoster | null;
  klaviyo: KlaviyoStatus | { error: string } | null;
  /** The contact team is not shown the Integrations tab (dashboard-auth.mjs). */
  canManageIntegrations: boolean;
}) {
  const tr = getT();
  return (
    <div className={header.page}>
      <header className={header.header}>
        <div className={header.titleRow}>
          <h1 className={header.title}>{tr("nav.settings")}</h1>
        </div>
        <nav className={header.nav} aria-label={tr("settings.sections")}>
          <ul className={header.tabs}>
            {TABS.filter((item) => item.id !== "integrations" || canManageIntegrations).map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className={`${header.tab} ${item.id === tab ? header.tabActive : ""}`}
                  aria-current={item.id === tab ? "page" : undefined}
                >
                  {tr(`settings.tab.${item.id}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      {tab === "me" ? <MyInfo me={me} /> : tab === "agents" ? <AgentSettings roster={roster} /> : <Integrations klaviyo={klaviyo} />}
    </div>
  );
}

function MyInfo({ me }: { me: SettingsMe | null }) {
  const tr = getT();
  if (!me) return <PanelError message={tr("settings.noSession")} />;

  return (
    <Grid min={22}>
      <Card title={tr("settings.account")}>
        <dl className={styles.facts}>
          <dt>{tr("orders.name")}</dt>
          <dd>{me.name?.trim() || <span className={t.muted}>{tr("settings.notSet")}</span>}</dd>
          <dt>{tr("tickets.panels.row.email")}</dt>
          <dd>{me.email ?? <span className={t.muted}>{tr("settings.notSet")}</span>}</dd>
          <dt>{tr("settings.role")}</dt>
          <dd>
            <span className={styles.role}>{tr(`role.${me.role}`)}</span>
          </dd>
        </dl>
      </Card>
      <Card title={tr("common.language")} aside={<span>{tr("settings.languageAside")}</span>}>
        <LanguageSwitch showLabel={false} />
        <Caption>{tr("settings.languageNote")}</Caption>
      </Card>
      <Card title={tr("settings.canOpen")} aside={<span>{tr("settings.byRole")}</span>}>
        <ul className={styles.access}>
          {me.access.map((area) => (
            <li key={area.id}>
              <span>{tr(`settings.area.${area.id}`)}</span>
              <span className={area.allowed ? styles.allowed : styles.denied}>{area.allowed ? tr("tickets.panels.yes") : tr("settings.noAccess")}</span>
            </li>
          ))}
        </ul>
      </Card>
    </Grid>
  );
}

function Integrations({ klaviyo }: { klaviyo: KlaviyoStatus | { error: string } | null }) {
  const tr = getT();
  if (!klaviyo) return null;
  if ("error" in klaviyo) return <PanelError message={klaviyo.error} />;
  return (
    <>
      <Grid min={30}>
        <Card title="Klaviyo" aside={<span>{tr("settings.klaviyoAside")}</span>}>
          <KlaviyoKeyCard status={klaviyo} />
        </Card>
      </Grid>
      <Caption>
        The nightly sync reads flow and campaign performance with this key (<code>npm run sync:klaviyo</code> runs it on demand). Revenue is what Klaviyo attributes to its own messages on Shopify&apos;s &ldquo;Placed Order&rdquo; — Klaviyo&apos;s attribution window, not the Acquisition channels card&apos;s.
      </Caption>
    </>
  );
}

function AgentSettings({ roster }: { roster: AgentRoster | null }) {
  const tr = getT();
  const { compactNumber, percent, usd } = getFormat();
  if (!roster) return null;
  if (roster.error) return <PanelError message={roster.error} />;

  const { rows, windowDays } = roster;
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const failed = rows.reduce((sum, row) => sum + row.failed, 0);
  const priced = rows.every((row) => row.costUsd !== null);
  const cost = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const window = tr("settings.lastDays", { count: windowDays, n: windowDays });

  return (
    <>
      <Grid>
        <KpiCard label={tr("insights.agent.calls")} value={compactNumber(calls)} sub={[{ label: tr("settings.window"), value: window }]} />
        <KpiCard
          label={tr("settings.failedCalls")}
          value={compactNumber(failed)}
          tone={calls > 0 && failed / calls > 0.05 ? "warn" : undefined}
          sub={[{ label: tr("settings.ofAllCalls"), value: calls > 0 ? percent(failed, calls) : "—" }]}
        />
        <KpiCard
          label={tr("settings.spend")}
          value={usd(cost)}
          sub={[{ label: priced ? tr("settings.listPrice") : tr("settings.noRate"), value: priced ? tr("settings.estimated") : tr("settings.partial") }]}
        />
      </Grid>

      <Grid min={100}>
        <Card title={tr("settings.agents")} aside={<span>{window}</span>}>
          {rows.length === 0 ? (
            <EmptyState>{tr("settings.noAgents")}</EmptyState>
          ) : (
            <div className={t.wrap}>
              <table className={t.table}>
                <caption className={t.srOnly}>{tr("settings.agentsCaption", { days: windowDays })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{tr("settings.agent")}</th>
                    <th scope="col">{tr("settings.model")}</th>
                    <th scope="col" className={t.n}>{tr("settings.calls")}</th>
                    <th scope="col" className={t.n}>{tr("settings.failed")}</th>
                    <th scope="col" className={t.n}>{tr("settings.cost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <AgentRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Grid>

      <Caption>
        Models are chosen by environment variables (the name under each model) on the worker, and CHAT_MODEL on the dashboard; this page shows them and does not change them. The model shown is the one that actually ran; &ldquo;not run&rdquo; means no call in the window, so the configured model is shown instead. Agent test-chat runs are not counted.
      </Caption>
    </>
  );
}

function AgentRow({ row }: { row: AgentRosterRow }) {
  const tr = getT();
  const { integer, percent, usd } = getFormat();
  return (
    <tr>
      <th scope="row">
        {row.name}
        <span className={t.sub}>{row.job}</span>
      </th>
      <td>
        {row.modelSource === "off" ? (
          <span className={t.muted}>{tr("settings.turnedOff")}</span>
        ) : row.model ? (
          <span className={styles.model}>{row.model}</span>
        ) : (
          <span className={t.muted}>—</span>
        )}
        <span className={t.sub}>
          {row.modelSource === "configured" ? `${tr("settings.notRun")} · ` : ""}
          {row.otherModels.length > 0 ? `${tr("settings.alsoRan", { models: row.otherModels.join(", ") })} · ` : ""}
          {row.envVar}
        </span>
      </td>
      <td className={t.n}>{integer(row.calls)}</td>
      <td className={t.n}>
        {integer(row.failed)}
        {row.calls > 0 ? <span className={t.sub}>{percent(row.failed, row.calls)}</span> : null}
      </td>
      <td className={t.n}>
        {row.costUsd === null ? (
          <>
            —<span className={t.sub}>{tr("settings.noRateModel")}</span>
          </>
        ) : (
          usd(row.costUsd)
        )}
      </td>
    </tr>
  );
}
