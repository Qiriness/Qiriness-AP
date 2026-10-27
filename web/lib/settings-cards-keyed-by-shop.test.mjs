import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Settings → Integrations and the Social Connections dialog show one shop's
// connections in client components that copy their first values into state.
// The router keeps those components when only `?shop=` changes, so each must be
// keyed by its shop or a switch shows — and a Save writes — the previous shop's
// values. This happened twice on 2026-10-27, the second time because the key sat
// on a server component that did not pass it down. A wrong card fails nothing
// else, which is why this is a test.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('every per-shop card on Settings → Integrations is keyed by the shop', () => {
  const view = read('../components/settings/SettingsView.tsx');
  for (const card of ['KlaviyoKeyCard', 'MailSettingsCard', 'SocialProviderCards']) {
    const uses = view.match(new RegExp(`<${card}\\b[^>]*>`, 'g')) ?? [];
    assert.ok(uses.length > 0, `${card} is not rendered`);
    for (const use of uses) assert.match(use, /\skey=\{[^\n]*?shop\.slug/, `${card} without a shop key: ${use}`);
  }
});

test('the Social Connections dialog keys its cards by the shop', () => {
  const dialog = read('../components/insights/SocialConnectionsDialog.tsx');
  assert.match(dialog, /<SocialProviderCards key=\{shop\}/);
});
