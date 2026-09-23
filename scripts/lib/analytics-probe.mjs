/**
 * What to ask Shopify's analytics API, and how to read what comes back.
 *
 * WHY A PROBE EXISTS AT ALL. The figures the Overview, Marketing and report
 * cards leave blocked — sessions, conversion, add to cart, reached checkout —
 * are all on the admin's Analytics → Reports page, but that page is served by
 * Shopify's internal API. Apps get `shopifyqlQuery`, and the public docs
 * enumerate no dataset list: they promise "schemas covering sales, orders,
 * customers, marketing, inventory, payments, and more". Which of those this
 * store will actually answer is a question about this store, not about the
 * documentation, so it is measured before anything is built on it.
 *
 * THE ERROR MESSAGES ARE THE POINT. ShopifyQL names what it could not parse,
 * and often what it would have accepted, so a rejected query is as informative
 * as an accepted one. `classify` sorts the outcomes into the three answers that
 * change what we do next: the permission is missing, the store does not know
 * that dataset or metric, or it works.
 *
 * Pure and isomorphic: the queries and the reading of a result live here so a
 * test can hold them; the script does the I/O.
 */

/**
 * The candidate queries, one per figure the dashboard currently blocks, plus a
 * sanity query that must work if the scope is granted at all.
 *
 * Deliberately small and dated `-7d`: this is a question about which columns
 * exist, not a data pull.
 */
export const PROBES = Object.freeze([
  {
    id: 'sales-sanity',
    asks: 'Does ShopifyQL answer this store at all?',
    query: 'FROM sales SHOW total_sales SINCE -7d'
  },
  {
    id: 'sessions',
    asks: 'Sessions, the figure Overview blocks first',
    query: 'FROM sessions SHOW sessions SINCE -7d'
  },
  {
    id: 'sessions-human-vs-bot',
    asks: 'The split every sessions query is filtered on — the admin reports HUMAN sessions, and bots are ~25% of this store\'s traffic',
    query: "FROM sessions SHOW sessions, conversion_rate GROUP BY human_or_bot_session SINCE -30d"
  },
  {
    id: 'sessions-metrics',
    asks: 'Conversion rate and the rest of the sessions dataset (Overview KPIs)',
    query: "FROM sessions SHOW sessions, conversion_rate, pageviews, bounce_rate WHERE human_or_bot_session = 'human' SINCE -7d"
  },
  {
    id: 'sessions-history',
    asks: 'How far back sessions go — the month picker and the report need two years',
    query: 'FROM sessions SHOW sessions TIMESERIES month SINCE -24m'
  },
  {
    id: 'sessions-by-referrer',
    asks: 'Sessions by traffic source (Marketing: acquisition channels)',
    query: 'FROM sessions SHOW sessions GROUP BY referrer_source, referrer_name, utm_source, utm_medium, utm_campaign SINCE -7d'
  },
  {
    id: 'sales-by-channel',
    asks: 'Revenue and orders per referring channel — the other half of that card',
    query: 'FROM sales SHOW total_sales, orders GROUP BY referring_channel SINCE -7d'
  },
  {
    id: 'funnel',
    asks: 'The funnel: cart additions, reached checkout, completed checkout — all real columns, once the right names are used',
    query:
      "FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout WHERE human_or_bot_session = 'human' SINCE -7d"
  },
  {
    id: 'product-views',
    asks: 'Product views. EXPECTED TO FAIL — the one funnel step with no metric on this store (measured 2026-09-23). Kept so the day Shopify adds one, a re-run says so',
    query: 'FROM sessions SHOW product_views SINCE -7d'
  },
  {
    id: 'products-dataset',
    asks: 'Per-product sessions. EXPECTED TO FAIL — products is not a dataset; sales, sessions, customers, inventory, payments and discounts are',
    query: 'FROM products SHOW view_sessions, cart_sessions SINCE -7d'
  }
]);

/**
 * What one outcome means for what we do next.
 *
 *   'ok'          the store answered; the columns are in the result
 *   'permission'  the scope or the protected-customer-data level is missing
 *   'rejected'    ShopifyQL parsed the request and refused it: no such dataset,
 *                 metric or dimension on this store
 *   'unavailable' the field itself is not in this API version
 *   'error'       anything else — a network fault, a throttle, an unknown shape
 *
 * Matching is on the message because Shopify reports all of these as a 200 with
 * prose; there is no code to switch on. `parseErrors` is a plain String on
 * `ShopifyqlQueryResponse` (2026-07), and was a list of objects in earlier
 * versions, so both shapes are read.
 */
export function classify(outcome = {}) {
  const { columns, parseErrors, error } = outcome;
  const refusal = describeParseErrors(parseErrors);
  if (refusal) return { status: 'rejected', detail: refusal };
  if (error) {
    const message = String(error);
    if (/access scope|read_reports|protected customer data|not approved|merchant approval|unauthorized|access denied/i.test(message)) {
      return { status: 'permission', detail: message };
    }
    if (/doesn't exist on type|Cannot query field|isn't a defined input type|Selections can't be made on scalars/i.test(message)) {
      return { status: 'unavailable', detail: message };
    }
    return { status: 'error', detail: message };
  }
  if (Array.isArray(columns)) {
    return { status: 'ok', detail: columns.length ? columns.map((c) => c.name).join(', ') : 'answered with no columns' };
  }
  // A refused query returns a null table with its reasons; only an
  // unrecognised shape reaches here with neither a table nor a reason.
  return { status: 'error', detail: 'Neither a table nor a reason came back — unrecognised response shape.' };
}

/**
 * `parseErrors` as text, whatever shape this API version reports it in.
 *
 * On 2026-07 it is a LIST OF STRINGS ("Column Not Found: Column 'visits' not
 * found"), which is also how the dataset and column catalogue is discovered —
 * ShopifyQL publishes no list, so what it refuses BY NAME is the documentation.
 * Older versions returned objects with `code` and `message`; both are read.
 */
function describeParseErrors(parseErrors) {
  if (!parseErrors) return null;
  if (typeof parseErrors === 'string') return parseErrors.trim() || null;
  if (Array.isArray(parseErrors)) {
    const lines = parseErrors
      .filter(Boolean)
      .map((entry) => (typeof entry === 'string' ? entry : `${entry.code ? `${entry.code}: ` : ''}${entry.message ?? ''}`).trim())
      .filter(Boolean);
    return lines.length ? lines.join(' · ') : null;
  }
  return null;
}

/**
 * The selection to send with `shopifyqlQuery`, built from the schema the store
 * actually serves rather than from a shape written down here.
 *
 * WRITTEN DOWN IS WHAT FAILED. The first version of this file selected
 * `parseErrors { code message }` and `tableData { ... rowData }` from the
 * published docs; on 2026-07 `parseErrors` is a String and the rows are called
 * `rows`, so every probe came back "Selections can't be made on scalars" and
 * measured nothing about the datasets. So: scalars and enums are selected bare,
 * object fields are walked to `depth`, fields needing arguments are skipped,
 * and a cycle is not followed.
 *
 * @param {string} rootType
 * @param {Record<string, { name: string, kind: string, typeName: string | null, hasRequiredArgs?: boolean }[]>} types
 * @param {number} depth
 */
export function buildSelection(rootType, types = {}, depth = 3, seen = []) {
  const fields = types[rootType] ?? [];
  // The type being expanded counts as visited, so a field pointing back at its
  // own type is a cycle and is skipped rather than followed to the depth limit.
  const path = [...seen, rootType];
  const parts = [];
  for (const field of fields) {
    if (field.hasRequiredArgs) continue;
    if (field.kind === 'SCALAR' || field.kind === 'ENUM') {
      parts.push(field.name);
      continue;
    }
    if (depth <= 1 || !field.typeName || path.includes(field.typeName) || !types[field.typeName]) continue;
    const nested = buildSelection(field.typeName, types, depth - 1, path);
    if (nested) parts.push(`${field.name} { ${nested} }`);
  }
  return parts.join(' ');
}

/** One line per probe, for the summary the operator reads. */
export function formatResult(probe, verdict) {
  const mark = { ok: 'OK      ', permission: 'NO SCOPE', rejected: 'REFUSED ', unavailable: 'MISSING ', error: 'ERROR   ' }[verdict.status];
  return `${mark} ${probe.id}\n         ${probe.query}\n         ${verdict.detail}`;
}

/**
 * What the run means as a whole — the sentence that decides the next step.
 * The sanity query is load-bearing: everything refusing while it also refuses
 * is a permission answer, not a "this store has no analytics" answer.
 */
export function conclude(results = []) {
  if (results.length === 0) return 'Nothing ran.';
  if (results.every((r) => r.status === 'unavailable')) {
    return 'Every query was rejected by GraphQL itself: shopifyqlQuery is absent from this API version, or the selection does not match the schema printed above. Nothing about the datasets is settled.';
  }
  if (results.some((r) => r.status === 'permission')) {
    return 'The scope or the protected-customer-data level is missing. Add read_reports, deploy, re-authorize, and run this again — nothing about the datasets is settled yet.';
  }
  const ok = results.filter((r) => r.status === 'ok');
  if (ok.length === 0) return 'Every query was refused. The figures on the Analytics page are not reachable through ShopifyQL on this store; fall back to the CSV export or a web pixel.';
  const refused = results.filter((r) => r.status !== 'ok');
  return [
    `${ok.length} of ${results.length} queries answered: ${ok.map((r) => r.id).join(', ')}.`,
    refused.length ? `Refused: ${refused.map((r) => r.id).join(', ')}.` : '',
    'Build the sync against what answered, and only that.'
  ]
    .filter(Boolean)
    .join(' ');
}
