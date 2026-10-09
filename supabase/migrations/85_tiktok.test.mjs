import assert from 'node:assert/strict';
import test from 'node:test';
import { SOCIAL_PROVIDERS, SOCIAL_KINDS, ORGANIC_KINDS } from '../../scripts/lib/social-model.mjs';
import { SOCIAL_RPC } from '../../scripts/lib/tables.mjs';
import { read, checkClause, literalsIn, codeOnly } from './_shared.test.mjs';
const SQL = read('85_tiktok');
const CODE = codeOnly(SQL);
test('85 widens existing provider, organic kind and band constraints without deleting data', () => {
  for (const name of ['social_connections_provider_check', 'social_accounts_provider_check']) assert.deepEqual(literalsIn(checkClause(SQL, name)), [...SOCIAL_PROVIDERS].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'social_accounts_kind_check')), [...SOCIAL_KINDS].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'social_metric_bands_kind_check')), [...ORGANIC_KINDS].sort());
  assert.doesNotMatch(CODE, /delete from|drop table|truncate/i);
  assert.match(CODE, /a\.kind in \('instagram', 'facebook', 'tiktok'\)/);
});
test('refresh stays service-role only, locks the connection and preserves connection attribution', () => {
  assert.ok(CODE.includes(`function public.${SOCIAL_RPC.REFRESH_TOKEN}(`));
  assert.match(CODE, /security definer set search_path = ''/);
  assert.match(CODE, /where c\.shop_id = p_shop and c\.provider = p_provider for update/);
  assert.match(CODE, /vault\.update_secret/);
  assert.match(CODE, /from public, anon, authenticated/);
  assert.match(CODE, /to service_role/);
  assert.doesNotMatch(CODE, /connected_at\s*=|connected_by\s*=/);
});
