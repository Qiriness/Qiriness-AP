import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createShopifyClient, shopifyGraphql } from './lib/shopify-admin-client.mjs';
import { PROBES, buildSelection, classify, conclude, formatResult } from './lib/analytics-probe.mjs';

// Which figures on the admin's Analytics → Reports page can this store answer
// through the API?
//
//   npm run probe:analytics
//   npm run probe:analytics -- --query "FROM sessions SHOW sessions SINCE -7d"
//
// WHY THIS RUNS BEFORE ANYTHING IS BUILT. Sessions, conversion, add to cart and
// reached checkout are blocked on the Overview, Marketing and report cards. They
// are all on the Analytics page, but that page is Shopify's own UI over an
// internal API; apps get `shopifyqlQuery`, and the public docs enumerate no
// dataset list. Whether `FROM sessions` exists is therefore a question for the
// store, not for the documentation — and the answer decides between three quite
// different projects (a sync, a CSV import, or a web pixel of our own).
//
// IT NEEDS `read_reports`, WHICH THE APP ONLY NOW REQUESTS. Until the scopes in
// shopify.app.toml are deployed and the app re-authorized, every query here
// comes back as a permission error and settles nothing about the datasets. The
// script says so rather than reporting "no analytics".
//
// ZERO COST AND READ-ONLY: a schema introspection plus one 7-day query per
// candidate. No model call, no write, nothing stored.

const adHoc = valueOf('--query');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadConfig(loadEnv());
  const shopify = await createShopifyClient(config);
  console.log(`Shop ${config.shopDomain} · Admin API ${config.shopifyApiVersion}\n`);

  const schema = await introspect(shopify);
  if (!schema.present) {
    console.log('shopifyqlQuery is not a field on this API version. Nothing else can be measured here.');
    return;
  }
  console.log(`shopifyqlQuery returns ${schema.rootType}`);
  for (const [type, fields] of Object.entries(schema.types)) {
    console.log(`  ${type}: ${fields.map((f) => `${f.name}${f.typeName ? `: ${f.typeName}` : ''}`).join(', ')}`);
  }

  const selection = buildSelection(schema.rootType, schema.types);
  console.log(`
selection: ${selection || '(nothing selectable — falling back to __typename)'}
`);

  const probes = adHoc ? [{ id: 'ad-hoc', asks: 'The query passed on the command line', query: adHoc }] : PROBES;
  const results = [];

  for (const probe of probes) {
    const outcome = await run(shopify, selection || '__typename', probe.query);
    const verdict = classify(outcome);
    results.push({ id: probe.id, status: verdict.status });
    console.log(`${formatResult(probe, verdict)}
`);
    // The first rows are worth seeing once: a column name says what a metric is
    // called, a value says what it means.
    if (verdict.status === 'ok' && outcome.rows?.length) {
      console.log(`         first row: ${JSON.stringify(outcome.rows[0])}
`);
    }
  }

  console.log('---');
  console.log(conclude(results));
}

/**
 * The shape of `shopifyqlQuery`'s response type, and of every object type under
 * it, so the selection is built from this API version rather than from a shape
 * written down last year. Three levels is enough for the table and its columns.
 */
async function introspect(shopify, depth = 3) {
  const rootField = `#graphql
    query ShopifyqlShape {
      __schema { queryType { fields { name type { name kind ofType { name kind } } } } } }
  `;
  const data = await shopifyGraphql(shopify, rootField);
  const field = data?.__schema?.queryType?.fields?.find((f) => f.name === 'shopifyqlQuery');
  if (!field) return { present: false, types: {} };

  const rootType = unwrapName(field.type);
  if (!rootType) return { present: true, rootType: '(unnamed)', types: {} };

  const types = {};
  const queue = [[rootType, depth]];
  while (queue.length) {
    const [name, left] = queue.shift();
    if (types[name] || left <= 0) continue;
    const fields = await fieldsOf(shopify, name);
    if (!fields) continue;
    types[name] = fields;
    for (const child of fields) {
      if (child.typeName && !types[child.typeName]) queue.push([child.typeName, left - 1]);
    }
  }
  return { present: true, rootType, types };
}

/** One type's fields, with each field's leaf type and whether it demands arguments. */
async function fieldsOf(shopify, name) {
  const query = `#graphql
    query TypeShape($name: String!) {
      __type(name: $name) {
        kind
        fields {
          name
          args { name type { kind name ofType { kind name } } }
          type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
        }
      }
    }
  `;
  const data = await shopifyGraphql(shopify, query, { name });
  const type = data?.__type;
  if (!type?.fields) return null;
  return type.fields.map((field) => {
    const leaf = unwrap(field.type);
    return {
      name: field.name,
      kind: leaf?.kind ?? 'SCALAR',
      typeName: leaf?.kind === 'OBJECT' || leaf?.kind === 'INTERFACE' ? leaf.name : null,
      hasRequiredArgs: (field.args ?? []).some((arg) => unwrapKind(arg.type) === 'NON_NULL')
    };
  });
}

const unwrap = (type) => (type?.ofType ? unwrap(type.ofType) : type);
const unwrapName = (type) => unwrap(type)?.name ?? null;
const unwrapKind = (type) => type?.kind ?? null;

/** One ShopifyQL query. Errors are an outcome here, not a failure. */
async function run(shopify, selection, shopifyql) {
  const query = `#graphql
    query Probe($shopifyql: String!) {
      shopifyqlQuery(query: $shopifyql) { ${selection} }
    }
  `;
  try {
    const data = await shopifyGraphql(shopify, query, { shopifyql });
    const response = data?.shopifyqlQuery ?? {};
    const rows = response.tableData?.rows ?? response.tableData?.rowData ?? [];
    return {
      columns: response.tableData?.columns ?? null,
      rows: Array.isArray(rows) ? rows : [rows],
      parseErrors: response.parseErrors ?? null
    };
  } catch (error) {
    return { error: error.message };
  }
}

function valueOf(flag) {
  const prefixed = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (prefixed) return prefixed.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : undefined;
}
