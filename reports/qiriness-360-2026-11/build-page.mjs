// Builds qiriness-360.html from page-template.html + data/*.csv (aggregates only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
function csv(name) {
  const text = fs.readFileSync(path.join(here, 'data', name + '.csv'), 'utf8').trim();
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += ch;
  }
  row.push(cur); rows.push(row);
  const [h, ...r] = rows; return r.map((x) => Object.fromEntries(h.map((k, i) => [k, x[i]])));
}
const n = (v) => Number(v);

const monthly = csv('q02_monthly').map((r) => ({ m: r.m.slice(0, 7), new: n(r.net_ht_new), legacy: n(r.net_ht_legacy_first || 0), repeat: n(r.net_ht_returning) }));
const kmRows = csv('q04_km_second');
const km = ['new', 'legacy'].map((t) => ({ name: t === 'new' ? 'New customers' : 'Legacy customers',
  pts: kmRows.filter((r) => r.ctype === t && n(r.t) >= 30 && n(r.at_risk_at_t) >= 20).map((r) => [n(r.t), n(r.cum_repurchase_pct)]) }));
const ladder = csv('q04_transitions').map((r) => ({ label: `Order ${r.from_order} → next`, v: n(r.pct_next_ever), n: n(r.eligible_180d), extra: `within 180 d: ${r.pct_next_within_180d}%` }));
const entry = csv('q06_entry_range').filter((r) => n(r.matured_180) >= 40)
  .map((r) => ({ label: r.entry_range, v: n(r.pct_2nd_180d), n: n(r.matured_180), extra: `value 180 d €${Math.round(n(r.value_180d))} · 1st AOV €${Math.round(n(r.first_aov_ht))}` }))
  .sort((a, b) => b.v - a.v);
const promo = csv('q14_true_promo_share').map((r) => ({ m: r.m.slice(0, 7), any: n(r.pct_any_incentive), app: n(r.pct_discount_app) }));
const actions = {
  '01': 'Post-purchase series by entry range', '02': 'Replenishment and routine step now', '03': 'One targeted win-back (mostly BF/Christmas 2025)',
  '04': 'Campaigns only; low priority', '05': 'Early access and recognition, no extra discount', '06': 'Push the 3rd order',
  '07': 'Best win-back target: favourite range + gift', '08': 'Two-touch win-back, then suppress from blasts' };
const segments = csv('q05_segments').map((r) => ({ seg: r.seg.slice(3), customers: n(r.customers), rev: r.pct_revenue, aov: Math.round(n(r.aov_ht)),
  orders: r.avg_orders, subs: n(r.email_subscribed), action: actions[r.seg.slice(0, 2)] }));
const markdown = csv('q14_product_markdown').filter((r) => n(r.units_t12) >= 150).slice(0, 10)
  .map((r) => ({ p: r.product.length > 60 ? r.product.slice(0, 58) + '…' : r.product, u: r.units_t12, list: '€' + n(r.list_ttc).toFixed(2), paid: '€' + n(r.avg_net_unit_ttc).toFixed(2), red: r.total_reduction_pct + '%' }));
const acq = csv('acq_first_orders_by_channel').filter((r) => r.ctype === 'new' && n(r.customers) >= 50)
  .map((r) => ({ ch: r.first_touch_channel, n: n(r.customers), aov: Math.round(n(r.first_aov_ht)), r: r.pct_2nd_180d, v: Math.round(n(r.value_180d)) }));
const fl = csv('q11_flows').map((r) => ({ f: 'Flow · ' + r.flow_name, d: n(r.delivered).toLocaleString('en-GB'), v: '€' + n(r.value_ttc).toLocaleString('en-GB'), pd: '€' + n(r.value_per_delivered).toFixed(2) }));
const camp = csv('q11_campaign_months').reduce((a, r) => ({ d: a.d + n(r.delivered), v: a.v + n(r.value_ttc) }), { d: 0, v: 0 });
const flows = [{ f: 'All campaigns (Sep 2025 – Oct 2026)', d: camp.d.toLocaleString('en-GB'), v: '€' + Math.round(camp.v).toLocaleString('en-GB'), pd: '€' + (camp.v / camp.d).toFixed(2) }, ...fl];

const opps = [
  { i: 1, o: 'Second-purchase programme', ev: '18.8% rebuy within 180 d; repeaters worth +€130 after the 1st order', val: '€7.8k / €13k / €21k', act: 'Post-purchase flows by entry range, on-site routine step, 15% holdout', ice: 60, p: 'High' },
  { i: 2, o: 'Holiday-cohort rescue', ev: 'Nov–Jan cohorts 12.9–17.9% at 180 d; about 1,000 customers a season', val: 'inside #1', act: 'Jan–Mar "your routine continues" sequence', ice: 64, p: 'High' },
  { i: 3, o: 'Stop or redesign paid social', ev: '€9.7k → 99 tracked new customers; CAC €59–98 vs €45 value at 180 d', val: 'avoided loss ≈ €2–3k a month', act: 'Pause cold; retest hero-product creative with a holdout', ice: 60, p: 'High' },
  { i: 4, o: 'Campaign rationalisation', ev: '~31 campaigns a month; €0.05 per delivered; attribution 2–3× inflated', val: 'not quantifiable (no unsubscribe data)', act: '8–12 segmented sends a month, engagement suppression', ice: 45, p: 'High' },
  { i: 5, o: 'Retention-quality entry products', ev: 'Temps Sublime entrants 30% vs masks 14% and devices 7%', val: '€2.0k / €4.0k / €6.0k', act: 'Lead BF and Shopping feed with TS Duo, Regard Sublime, Exception', ice: 36, p: 'High' },
  { i: 6, o: 'Replenishment reminders (11 SKUs)', ev: '15–23% reorder naturally at measured windows; ≈380 due now', val: '€2.0k / €3.3k / €5.2k (half overlaps #1)', act: 'Flow at each product’s p25 interval', ice: 36, p: 'High' },
  { i: 7, o: 'Routine completion', ev: 'Only 7.2% of Temps Sublime buyers own the eye cream; within-range lift 7–19', val: '€1.4k / €2.4k / €3.9k', act: 'Flows + PDP/cart bundles; advisor routines', ice: 36, p: 'Medium' },
  { i: 8, o: 'Basket building', ev: '51% single-product orders; +€16.7 for a 2nd product', val: '€1.6k / €3.2k / €4.8k', act: 'Cart add-ons (Kéfir, eye serum, wraps), threshold bar', ice: 36, p: 'Medium' },
  { i: 9, o: 'Repeat-customer win-back', ev: '431 at-risk/lapsed repeaters, 326 subscribed, €168 average history', val: '€1.3k / €2.2k / €3.4k', act: 'Two-touch win-back with favourite range', ice: 30, p: 'Medium' },
  { i: 10, o: 'Device owners → consumables', ev: 'LED/sauna buyers rebuy 7–9%; 42% of their next orders are masks', val: '€0.8k / €1.4k / €2.1k', act: 'Device onboarding flow', ice: 30, p: 'Medium' },
  { i: 11, o: 'Promotion discipline', ev: '36.7% below list; welcome code shows no retention edge', val: '€1.3k / €2.6k / €3.9k margin', act: 'Holdouts; gifts with purchase instead of %', ice: 24, p: 'Medium' },
  { i: 12, o: 'VIP / Champions', ev: '151 customers = 18% of revenue; no Smile.io data', val: 'protects ≈ €57k', act: 'Early access; connect Smile.io first', ice: 18, p: 'Medium' },
  { i: 13, o: 'Benelux and Italy CRM', ev: 'AOV €72–89, higher repeat', val: '< €2k', act: 'Localised flows', ice: 12, p: 'Low' },
];
const calendar = [
  { m: 'Jan', p: 'Convert the holiday cohort to a 2nd order', s: 'Soldes without deeper %', prod: 'Wraps for device owners; TS and Source d’Eau full sizes', ev: 'Holiday cohorts 12.9–17.9% at 180 d; Jan €34k', c: 'H' },
  { m: 'Feb', p: 'Eye-care routine completion', s: 'Win back at-risk repeaters', prod: 'Caresse Regard Sublime, Élixir Regard Éclat', ev: 'Eyes 17.7% of Feb revenue; 7.2% attach', c: 'M' },
  { m: 'Mar', p: 'Replenishment month, low promotion', s: 'Device owners → consumables', prod: 'The 11 replenishment SKUs; wraps', ev: 'Repeat demand only 5–9 per 100 due in Feb–May', c: 'L' },
  { m: 'Apr', p: 'Anti-ageing acquisition with Temps Sublime', s: 'AOV via €65 gift', prod: 'TS Duo, Vitamin C serum, Élixir TS', ev: 'Anti-ageing 40.5% share; TS rebuy 30.4%', c: 'M' },
  { m: 'May', p: 'Mother’s Day gifting and radiance', s: 'New-customer volume', prod: 'Coffrets, Éclat Parfait, CC/BB, UV', ev: '184 new customers in May 2026', c: 'M' },
  { m: 'Jun', p: 'Hydration routine (crème → élixir)', s: 'Father’s Day Homme trio', prod: 'Source d’Eau; Homme', ev: 'Hydration 20.4% share; Homme loop 74%', c: 'M' },
  { m: 'Jul', p: 'Summer sales with routine sets', s: 'Repeat customers’ promo-timed buying', prod: 'Summer coffrets, eye care', ev: 'Sets 34% of Jul 2025 revenue', c: 'M' },
  { m: 'Aug', p: 'Protect margin: flows only', s: 'Prepare back-to-school list', prod: '—', ev: 'Aug 2026 −42% YoY', c: 'M' },
  { m: 'Sep', p: 'Post-summer repair (hydration + anti-ageing)', s: 'Reactivate spring/summer one-timers', prod: 'Source d’Eau, Temps Sublime', ev: 'Hydration 20.9%, anti-ageing 36.7%', c: 'M' },
  { m: 'Oct', p: 'Pre-BF list building + Exception', s: 'Octobre Rose (BB/CC)', prod: 'Exception trio; BB/CC', ev: 'Exception €157 value at 180 d', c: 'L' },
  { m: 'Nov', p: 'Black Friday acquisition with retention-quality entry products', s: 'Device gifting', prod: 'TS Duo, Exception, Regard Sublime; LED as gift', ev: 'Nov €42k, 308 new; best campaign yield', c: 'H' },
  { m: 'Dec', p: 'Gifting: coffrets and SPA', s: 'Capture gift buyers for January', prod: 'Coffrets, LED, Sauna', ev: 'Sets 27.8% of revenue; devices 18.2%', c: 'H' },
];

const data = { monthly, km, ladder, entry, promo, segments, markdown, acq, flows, opps, calendar };
const tpl = fs.readFileSync(path.join(here, 'page-template.html'), 'utf8');
fs.writeFileSync(path.join(here, 'qiriness-360.html'), tpl.replace('/*DATA*/', JSON.stringify(data)));
console.log('built qiriness-360.html', JSON.stringify(data).length, 'bytes of data');
