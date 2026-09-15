import Link from "next/link";
import type { AgentRoster, AgentRosterRow } from "@/lib/server/agent-settings-service";
import { Caption, Card, EmptyState, Grid, KpiCard, PanelError, compactNumber, percent } from "../insights/InsightsKit";
import header from "../insights/InsightsHeader.module.css";
import t from "../insights/tables.module.css";
import styles from "./SettingsView.module.css";

export type SettingsTab = "me" | "agents";

export interface SettingsMe {
  name: string | null;
  email: string | null;
  roleLabel: string;
  access: { label: string; allowed: boolean }[];
}

const TABS: { id: SettingsTab; label: string; href: string }[] = [
  { id: "me", label: "My info", href: "/settings" },
  { id: "agents", label: "Agent settings", href: "/settings?tab=agents" },
];

/**
 * Settings, built from the Insights kit — the same page frame, tab bar, cards
 * and tables — so it reads as part of the dashboard rather than a form page.
 * Server-rendered: the tabs are plain links and nothing here holds state.
 */
export function SettingsView({ tab, me, roster }: { tab: SettingsTab; me: SettingsMe | null; roster: AgentRoster | null }) {
  return (
    <div className={header.page}>
      <header className={header.header}>
        <div className={header.titleRow}>
          <h1 className={header.title}>Settings</h1>
        </div>
        <nav className={header.nav} aria-label="Settings sections">
          <ul className={header.tabs}>
            {TABS.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className={`${header.tab} ${item.id === tab ? header.tabActive : ""}`}
                  aria-current={item.id === tab ? "page" : undefined}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      {tab === "me" ? <MyInfo me={me} /> : <AgentSettings roster={roster} />}
    </div>
  );
}

function MyInfo({ me }: { me: SettingsMe | null }) {
  if (!me) return <PanelError message="Could not read who is signed in. Try signing in again." />;

  return (
    <Grid min={22}>
      <Card title="Your account">
        <dl className={styles.facts}>
          <dt>Name</dt>
          <dd>{me.name?.trim() || <span className={t.muted}>Not set</span>}</dd>
          <dt>Email</dt>
          <dd>{me.email ?? <span className={t.muted}>Not set</span>}</dd>
          <dt>Role</dt>
          <dd>
            <span className={styles.role}>{me.roleLabel}</span>
          </dd>
        </dl>
      </Card>
      <Card title="What you can open" aside={<span>Set by your role</span>}>
        <ul className={styles.access}>
          {me.access.map((area) => (
            <li key={area.label}>
              <span>{area.label}</span>
              <span className={area.allowed ? styles.allowed : styles.denied}>{area.allowed ? "Yes" : "No access"}</span>
            </li>
          ))}
        </ul>
      </Card>
    </Grid>
  );
}

function usd(value: number): string {
  if (value > 0 && value < 0.01) return "< $0.01";
  return `$${value.toFixed(2)}`;
}

function AgentSettings({ roster }: { roster: AgentRoster | null }) {
  if (!roster) return null;
  if (roster.error) return <PanelError message={roster.error} />;

  const { rows, windowDays } = roster;
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const failed = rows.reduce((sum, row) => sum + row.failed, 0);
  const priced = rows.every((row) => row.costUsd !== null);
  const cost = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const window = `Last ${windowDays} days`;

  return (
    <>
      <Grid>
        <KpiCard label="Model calls" value={compactNumber(calls)} sub={[{ label: "Window", value: window }]} />
        <KpiCard
          label="Failed calls"
          value={compactNumber(failed)}
          tone={calls > 0 && failed / calls > 0.05 ? "warn" : undefined}
          sub={[{ label: "Of all calls", value: calls > 0 ? percent(failed, calls) : "—" }]}
        />
        <KpiCard
          label="Spend"
          value={usd(cost)}
          sub={[{ label: priced ? "At list price, USD" : "Some models have no rate", value: priced ? "Estimated" : "Partial" }]}
        />
      </Grid>

      <Grid min={100}>
        <Card title="Agents" aside={<span>{window}</span>}>
          {rows.length === 0 ? (
            <EmptyState>No agents are configured.</EmptyState>
          ) : (
            <div className={t.wrap}>
              <table className={t.table}>
                <caption className={t.srOnly}>Each agent, the model it runs on, and its calls, failures and cost over the last {windowDays} days</caption>
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Model</th>
                    <th scope="col" className={t.n}>Calls</th>
                    <th scope="col" className={t.n}>Failed</th>
                    <th scope="col" className={t.n}>Cost</th>
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
  return (
    <tr>
      <th scope="row">
        {row.name}
        <span className={t.sub}>{row.job}</span>
      </th>
      <td>
        {row.modelSource === "off" ? (
          <span className={t.muted}>Turned off</span>
        ) : row.model ? (
          <span className={styles.model}>{row.model}</span>
        ) : (
          <span className={t.muted}>—</span>
        )}
        <span className={t.sub}>
          {row.modelSource === "configured" ? "Not run · " : ""}
          {row.otherModels.length > 0 ? `Also ran ${row.otherModels.join(", ")} · ` : ""}
          {row.envVar}
        </span>
      </td>
      <td className={t.n}>{row.calls.toLocaleString("en-GB")}</td>
      <td className={t.n}>
        {row.failed.toLocaleString("en-GB")}
        {row.calls > 0 ? <span className={t.sub}>{percent(row.failed, row.calls)}</span> : null}
      </td>
      <td className={t.n}>
        {row.costUsd === null ? (
          <>
            —<span className={t.sub}>No rate for this model</span>
          </>
        ) : (
          usd(row.costUsd)
        )}
      </td>
    </tr>
  );
}
