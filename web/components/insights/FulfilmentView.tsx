import type { FulfilmentCarrier, FulfilmentPanel } from "@/lib/types";
import { getFormat, getT } from "@/lib/i18n/server";
import { BarList, BlockedCard, Card, DeltaChip, Grid, KpiCard } from "./InsightsKit";
import { InventoryTable, inventoryAside } from "./InventoryCard";
import { OpenOrders } from "./OpenOrders";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { perGrain } from "./grain";
import t from "./tables.module.css";

/**
 * Fulfilment over the chosen range and platform: how long orders take to leave,
 * how many, and — once a carrier feed exists — how long they take to arrive.
 */
export function FulfilmentView({ panel, compareLabel }: { panel: FulfilmentPanel; compareLabel: string }) {
  const tr = getT();
  const { euros, hours, integer, percent, percentOf } = getFormat();
  const { current, previous } = panel.summary;
  const lateShare = current.measured ? (current.over72h / current.measured) * 100 : null;
  const previousLate = previous && previous.measured ? (previous.over72h / previous.measured) * 100 : null;
  const grain = tr(`insights.sales.per.${perGrain(panel.orders)}`);

  return (
    <>
      <Grid pin="headline" label={tr("insights.fulfilment.headline")}>
        <KpiCard
          label={tr("insights.overview.orders")}
          value={integer(current.orders)}
          delta={<DeltaChip current={current.orders} previous={previous?.orders} polarity="up" compareLabel={compareLabel} />}
          sub={[
            { label: tr("insights.fulfilment.shipped"), value: integer(current.measured) },
            { label: tr("insights.sales.cancelled"), value: integer(current.cancelledOrders) },
          ]}
        />
        <KpiCard
          label={tr("insights.fulfilment.median")}
          value={hours(current.p50Hours)}
          delta={
            <DeltaChip current={current.p50Hours} previous={previous?.p50Hours} polarity="down" compareLabel={compareLabel} />
          }
          sub={[
            { label: tr("insights.fulfilment.p90"), value: hours(current.p90Hours) },
            { label: tr("insights.fulfilment.average"), value: hours(current.meanHours) },
          ]}
        />
        <KpiCard
          label={tr("insights.fulfilment.after3")}
          value={lateShare === null ? "—" : percentOf(lateShare, 1)}
          tone={lateShare !== null && lateShare > 10 ? "bad" : undefined}
          delta={<DeltaChip current={lateShare} previous={previousLate} polarity="down" points compareLabel={compareLabel} />}
          sub={[{ label: tr("insights.fulfilment.past72"), value: tr("insights.fulfilment.ofTotal", { n: integer(current.over72h), total: integer(current.measured) }) }]}
        />
        <KpiCard
          label={tr("insights.fulfilment.noTracking")}
          value={integer(current.shippedWithoutTracking)}
          tone={current.shippedWithoutTracking > 0 ? "warn" : undefined}
          delta={
            <DeltaChip
              current={current.shippedWithoutTracking}
              previous={previous?.shippedWithoutTracking}
              polarity="down"
              compareLabel={compareLabel}
            />
          }
          sub={[{ label: tr("insights.fulfilment.shareOfShipped"), value: percent(current.shippedWithoutTracking, current.measured) }]}
        />
      </Grid>

      <Grid min={100} pin="open-orders" label={tr("insights.fulfilment.waiting")}>
        <Card
          title={tr("insights.fulfilment.waiting")}
          aside={<span>{tr("insights.fulfilment.waitingAside")}</span>}
        >
          <OpenOrders orders={panel.openOrders} vipRuleSet={panel.vipRuleSet} />
        </Card>
      </Grid>

      <Grid min={100} pin="inventory" label={tr("insights.overview.inventory")}>
        <Card title={tr("insights.overview.inventory")} aside={<span>{inventoryAside(panel.inventory, tr)}</span>}>
          <InventoryTable inventory={panel.inventory} />
        </Card>
      </Grid>

      <Grid min={100} pin="orders-chart" label={tr("insights.fulfilment.ordersChart")}>
        <Card title={tr("insights.fulfilment.ordersPer", { grain })}>
          <TimeSeriesChart
            points={panel.orders}
            unit="count"
            ariaLabel={tr("insights.fulfilment.ordersPer", { grain })}
            missingLabel="insights.sales.notSynced"
          />
        </Card>
      </Grid>

      <Grid min={26} pin="timing" label={tr("insights.fulfilment.timeToShip")}>
        <Card title={tr("insights.fulfilment.medianPer", { grain })}>
          <TimeSeriesChart
            points={panel.medianHours}
            unit="hours"
            ariaLabel={tr("insights.fulfilment.medianAria", { grain })}
            height={240}
            threshold={{ value: 72, label: tr("insights.fulfilment.threeDays") }}
            missingLabel="insights.sales.notSynced"
          />
        </Card>
        <Card title={tr("insights.fulfilment.howLong")}>
          <BarList
            ariaLabel={tr("insights.fulfilment.byTime")}
            data={panel.buckets.map((b) => ({
              key: b.bucket,
              label: b.waiting ? tr("insights.fulfilment.notShipped") : b.bucket,
              value: b.orders,
              emphasis: b.late || b.waiting,
              // The waiting bar is a count of open orders, not a share of the
              // shipped ones, so it carries no percentage of that denominator.
              display: b.waiting
                ? integer(b.orders)
                : `${integer(b.orders)}  ·  ${percent(b.orders, current.measured, 0)}`,
              title: b.waiting
                ? tr("insights.fulfilment.notShippedHint", { count: b.orders })
                : tr("insights.fulfilment.shippedIn", { count: b.orders, bucket: b.bucket }),
            }))}
          />
        </Card>
      </Grid>

      <Grid pin="returns" label={tr("insights.fulfilment.refundsRow")}>
        <KpiCard
          label={tr("insights.fulfilment.refundedOrders")}
          value={integer(current.refundedOrders)}
          unit={tr("insights.fulfilment.of", { total: integer(current.orders) })}
          sub={[
            { label: tr("insights.sales.refunded"), value: euros(current.refundedAmount) },
            { label: tr("insights.fulfilment.returnsOpened"), value: integer(current.returnsOpened) },
          ]}
        />
        {panel.hasDeliveryData ? null : (
          <>
            <BlockedCard label={tr("insights.fulfilment.deliveryMedian")} reason="insights.fulfilment.noScans" />
            <BlockedCard label={tr("insights.fulfilment.deliveredAfter4")} reason="insights.fulfilment.needsFeed" />
            <BlockedCard label={tr("insights.fulfilment.stuck")} reason="insights.fulfilment.needsScans" />
          </>
        )}
      </Grid>

      <Grid min={100} pin="carriers" label={tr("insights.fulfilment.carriers")}>
        <Card title={tr("insights.fulfilment.carriers")}>
          {panel.carriers.length === 0 ? (
            <p className={t.muted}>{tr("insights.fulfilment.noCarrier")}</p>
          ) : (
            <CarrierTable rows={panel.carriers} />
          )}
        </Card>
      </Grid>
    </>
  );
}

const OUTCOMES: ("lost" | "damaged" | "late")[] = ["lost", "damaged", "late"];

/**
 * `Contacted support` counts orders, not threads, and only reaches the threads
 * whose order number the resolver confirmed — so it is a floor. Lost, damaged
 * and late are placeholders nothing writes yet: dashes, never zeros.
 */
function CarrierTable({ rows }: { rows: FulfilmentCarrier[] }) {
  const tr = getT();
  const { hours, integer, percent } = getFormat();
  const total = rows.reduce((sum, c) => sum + c.shipments, 0);
  return (
    <div className={t.wrap}>
      <table className={t.table}>
        <thead>
          <tr>
            <th scope="col">{tr("insights.fulfilment.carrier")}</th>
            <th scope="col" className={t.n}>{tr("insights.fulfilment.shipments")}</th>
            <th scope="col" className={t.n}>{tr("insights.sales.share")}</th>
            <th scope="col" className={t.n}>{tr("insights.fulfilment.medianToShip")}</th>
            <th scope="col" className={t.n}>{tr("insights.fulfilment.past3")}</th>
            <th scope="col" className={t.n} title={tr("insights.fulfilment.contactedHint")}>
              {tr("insights.fulfilment.contacted")}
            </th>
            {OUTCOMES.map((o) => (
              <th key={o} scope="col" className={t.n} title={tr("insights.fulfilment.needsCarrierFeed")}>
                {tr(`insights.fulfilment.outcome.${o}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.carrier}>
              <th scope="row">{c.carrier}</th>
              <td className={t.n}>{integer(c.shipments)}</td>
              <td className={t.n}>{percent(c.shipments, total)}</td>
              <td className={t.n}>{hours(c.p50Hours)}</td>
              <td className={t.n}>
                {integer(c.over72h)} <span className={t.muted}>({percent(c.over72h, c.shipments)})</span>
              </td>
              <td className={t.n}>
                {integer(c.ordersWithTicket)}{" "}
                <span className={t.muted}>({percent(c.ordersWithTicket, c.shipments)})</span>
              </td>
              {OUTCOMES.map((o) => (
                <td key={o} className={`${t.n} ${t.pending}`}>
                  <span aria-hidden="true">—</span>
                  <span className={t.srOnly}>{tr("insights.fulfilment.outcomeNotMeasured", { label: tr(`insights.fulfilment.outcome.${o}`) })}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
