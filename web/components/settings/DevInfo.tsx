import type { AgentRoster } from "@/lib/server/agent-settings-service";
import { LANES, STACK, SUBSCRIPTIONS, type StackNode, type StackStatus } from "@/lib/dev-stack";
import { getFormat, getT } from "@/lib/i18n/server";
import { Card, Grid, KpiCard } from "../insights/InsightsKit";
import t from "../insights/tables.module.css";
import styles from "./DevInfo.module.css";

const BY_ID = new Map(STACK.map((node) => [node.id, node]));

/**
 * Settings → Dev info: the architecture as a diagram and the paid services as
 * a table, both drawn from `lib/dev-stack.ts`. The only live figures are the
 * OpenAI models and spend, read off the agent roster (last 30 days).
 */
export function DevInfo({ roster }: { roster: AgentRoster | null }) {
  const tr = getT();
  const { integer, usd } = getFormat();
  const rows = roster && !roster.error ? roster.rows : [];
  const models = Array.from(new Set(rows.flatMap((row) => [row.model, ...row.otherModels]).filter((m): m is string => Boolean(m)))).sort();
  const spend = rows.length > 0 && rows.every((row) => row.costUsd !== null) ? rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) : null;
  const services = STACK.filter((node) => node.name !== null);
  const count = (status: StackStatus) => services.filter((node) => node.status === status).length;
  const nameOf = (node: StackNode) => node.name ?? tr(`settings.dev.name.${node.id}`);
  const days = roster?.windowDays ?? 30;
  const window = tr("settings.lastDays", { count: days, n: days });

  return (
    <>
      <Grid>
        <KpiCard label={tr("settings.dev.services")} value={integer(services.length)} />
        <KpiCard label={tr("settings.dev.status.live")} value={integer(count("live"))} />
        <KpiCard label={tr("settings.dev.status.planned")} value={integer(count("planned") + count("partial"))} />
        <KpiCard
          label={tr("settings.dev.aiSpend")}
          value={spend === null ? "—" : usd(spend)}
          sub={[{ label: "OpenAI", value: window }]}
        />
      </Grid>

      <Grid min={100}>
        <Card title={tr("settings.dev.architecture")} aside={<Legend />}>
          <div className={styles.diagram}>
            {LANES.map((lane, index) => (
              <section key={lane} className={styles.lane} aria-label={tr(`settings.dev.lane.${lane}`)}>
                <h3 className={styles.laneTitle}>
                  <span className={styles.step}>{index + 1}</span>
                  {tr(`settings.dev.lane.${lane}`)}
                </h3>
                {STACK.filter((node) => node.lane === lane).map((node) => (
                  <Node key={node.id} node={node} name={nameOf(node)} extra={node.id === "openai" ? models : []} />
                ))}
              </section>
            ))}
          </div>
        </Card>
      </Grid>

      <Grid min={100}>
        <Card title={tr("settings.dev.subscriptions")}>
          <div className={t.wrap}>
            <table className={t.table}>
              <caption className={t.srOnly}>{tr("settings.dev.subscriptions")}</caption>
              <thead>
                <tr>
                  <th scope="col">{tr("settings.dev.service")}</th>
                  <th scope="col">{tr("settings.dev.billing")}</th>
                  <th scope="col">{tr("settings.dev.plan")}</th>
                  <th scope="col" className={t.n}>{tr("settings.dev.monthly")}</th>
                  <th scope="col">{tr("settings.dev.statusCol")}</th>
                </tr>
              </thead>
              <tbody>
                {SUBSCRIPTIONS.map((sub) => {
                  const node = BY_ID.get(sub.node);
                  if (!node) return null;
                  const usage =
                    sub.node === "openai" && spend !== null ? (
                      <>
                        {usd(spend)}
                        <span className={t.sub}>{window}</span>
                      </>
                    ) : null;
                  return (
                    <tr key={sub.node}>
                      <th scope="row">
                        {nameOf(node)}
                        <span className={t.sub}>{tr(`settings.dev.role.${node.role}`)}</span>
                      </th>
                      <td>
                        <span className={`${styles.chip} ${styles[`bill_${sub.billing}`]}`}>{tr(`settings.dev.billing.${sub.billing}`)}</span>
                      </td>
                      <td>{sub.plan ?? <span className={t.muted}>—</span>}</td>
                      <td className={t.n}>{sub.monthly ?? usage ?? <span className={t.muted}>—</span>}</td>
                      <td>
                        <Status status={node.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </Grid>
    </>
  );
}

function Node({ node, name, extra }: { node: StackNode; name: string; extra: string[] }) {
  const tr = getT();
  return (
    <article className={`${styles.node} ${styles[node.status]}`}>
      <header className={styles.nodeHead}>
        <span className={styles.nodeName}>{name}</span>
        <Status status={node.status} bare />
      </header>
      <span className={styles.nodeRole}>{tr(`settings.dev.role.${node.role}`)}</span>
      {node.host ? <span className={styles.host}>{node.host}</span> : null}
      <ul className={styles.chips}>
        {node.tech.map((tech) => (
          <li key={tech} className={styles.chip}>{tech}</li>
        ))}
        {extra.map((model) => (
          <li key={model} className={`${styles.chip} ${styles.model}`}>{model}</li>
        ))}
      </ul>
      {node.links && node.links.length > 0 ? (
        <ul className={styles.links}>
          {node.links.map((link) => {
            const target = BY_ID.get(link.to);
            const status = link.status ?? node.status;
            return (
              <li key={`${link.to}-${link.via}`} className={status === "live" ? styles.link : `${styles.link} ${styles.linkPlanned}`}>
                <span aria-hidden="true">→</span> {target?.name ?? link.to}
                {link.via ? <span className={styles.via}>{link.via}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}

function Status({ status, bare = false }: { status: StackStatus; bare?: boolean }) {
  const tr = getT();
  const label = tr(`settings.dev.status.${status}`);
  return (
    <span className={styles.status} title={label}>
      <span className={`${styles.dot} ${styles[`dot_${status}`]}`} aria-hidden="true" />
      {bare ? <span className={t.srOnly}>{label}</span> : label}
    </span>
  );
}

function Legend() {
  return (
    <span className={styles.legend}>
      {(["live", "partial", "planned"] as const).map((status) => (
        <Status key={status} status={status} />
      ))}
    </span>
  );
}
