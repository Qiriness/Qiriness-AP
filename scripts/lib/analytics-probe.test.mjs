import assert from 'node:assert/strict';
import test from 'node:test';

import { PROBES, buildSelection, classify, conclude, formatResult } from './analytics-probe.mjs';

test('the probes that are expected to fail say so, so a re-run stays readable', () => {
  const expectedToFail = PROBES.filter((p) => /EXPECTED TO FAIL/.test(p.asks)).map((p) => p.id);
  // `product_views` is the only funnel step this store keeps no metric for. The
  // cart and checkout steps were once listed here too, wrongly: a multi-column
  // refusal named one bad name and was read as naming them all.
  assert.deepEqual(expectedToFail, ['product-views', 'products-dataset']);
});

test('every probe asks one dated question, and the sanity query leads', () => {
  assert.equal(PROBES[0].id, 'sales-sanity');
  for (const probe of PROBES) {
    assert.match(probe.query, /^FROM \w+ SHOW /, probe.id);
    assert.match(probe.query, /SINCE -\d+[dm]$/, `${probe.id} must stay a question, not a data pull`);
    assert.ok(probe.asks.length > 10, probe.id);
  }
  assert.equal(new Set(PROBES.map((p) => p.id)).size, PROBES.length);
});

test('the three answers that change what we do next are told apart', () => {
  assert.equal(classify({ error: 'Shopify GraphQL error: Access denied for shopifyqlQuery field. Required access: read_reports access scope.' }).status, 'permission');
  assert.equal(classify({ error: 'protected customer data: app is not approved for Level 2' }).status, 'permission');
  assert.equal(classify({ parseErrors: [{ code: 'UNKNOWN_TABLE', message: "Unknown table 'sessions'" }] }).status, 'rejected');
  // 2026-07 reports refusals as plain strings, and names what it refused.
  const strings = classify({ parseErrors: ['Schema Error: Invalid dataset in FROM clause - visits', "Column Not Found: Column 'visits' not found"] });
  assert.equal(strings.status, 'rejected');
  assert.match(strings.detail, /Invalid dataset in FROM clause - visits · Column Not Found/);
  assert.equal(classify({ parseErrors: [], columns: [{ name: 'sessions' }] }).status, 'ok');
  assert.equal(classify({ error: "Shopify GraphQL error: Field 'shopifyqlQuery' doesn't exist on type 'QueryRoot'" }).status, 'unavailable');
  assert.equal(classify({ error: 'Shopify request failed with HTTP 502.' }).status, 'error');
  assert.equal(classify({ columns: [{ name: 'sessions' }, { name: 'day' }] }).status, 'ok');
  assert.equal(classify({ columns: [{ name: 'sessions' }] }).detail, 'sessions');
  // A refusal wins over a 200: ShopifyQL reports a bad query inside a success.
  assert.equal(classify({ columns: [], parseErrors: [{ message: 'no such metric' }] }).status, 'rejected');
  assert.equal(classify({}).status, 'error');
});

test('the selection is built from the schema, not from a remembered shape', () => {
  // The 2026-07 shape, as introspection reports it: parseErrors is a scalar and
  // the rows are called `rows` — the shape the published example got wrong.
  const types = {
    ShopifyqlQueryResponse: [
      { name: 'parseErrors', kind: 'SCALAR', typeName: null },
      { name: 'tableData', kind: 'OBJECT', typeName: 'ShopifyqlTableData' }
    ],
    ShopifyqlTableData: [
      { name: 'columns', kind: 'OBJECT', typeName: 'ShopifyqlTableDataColumn' },
      { name: 'rows', kind: 'SCALAR', typeName: null }
    ],
    ShopifyqlTableDataColumn: [
      { name: 'name', kind: 'SCALAR', typeName: null },
      { name: 'dataType', kind: 'ENUM', typeName: null }
    ]
  };
  assert.equal(
    buildSelection('ShopifyqlQueryResponse', types),
    'parseErrors tableData { columns { name dataType } rows }'
  );

  // A field needing arguments cannot be selected blind, and a cycle is not followed.
  const awkward = {
    Root: [
      { name: 'ok', kind: 'SCALAR', typeName: null },
      { name: 'paged', kind: 'OBJECT', typeName: 'Page', hasRequiredArgs: true },
      { name: 'self', kind: 'OBJECT', typeName: 'Root' }
    ],
    Page: [{ name: 'cursor', kind: 'SCALAR', typeName: null }]
  };
  assert.equal(buildSelection('Root', awkward), 'ok');

  // Depth is a floor, not a guess: one level stops before the nested object.
  assert.equal(buildSelection('ShopifyqlQueryResponse', types, 1), 'parseErrors');
  // An unrecognised shape yields nothing rather than throwing; the caller falls
  // back to __typename.
  assert.equal(buildSelection('Nothing', types), '');
  assert.equal(buildSelection(), '');
});

test('a run concludes with the next step, and a permission answer settles nothing else', () => {
  assert.match(conclude([{ id: 'a', status: 'permission' }, { id: 'b', status: 'rejected' }]), /Add read_reports/);
  assert.match(conclude([{ id: 'a', status: 'unavailable' }]), /absent from this API version, or the selection does not match/);
  assert.match(conclude([{ id: 'a', status: 'rejected' }, { id: 'b', status: 'rejected' }]), /CSV export or a web pixel/);
  const mixed = conclude([{ id: 'sessions', status: 'ok' }, { id: 'product-views', status: 'rejected' }]);
  assert.match(mixed, /1 of 2 queries answered: sessions/);
  assert.match(mixed, /Refused: product-views/);
  assert.equal(conclude([]), 'Nothing ran.');
});

test('each line names the query it is reporting on', () => {
  const line = formatResult(PROBES[1], { status: 'rejected', detail: "Unknown table 'sessions'" });
  assert.match(line, /REFUSED\s+sessions/);
  assert.match(line, /FROM sessions SHOW sessions SINCE -7d/);
  assert.match(line, /Unknown table 'sessions'/);
});
