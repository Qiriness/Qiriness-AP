import assert from 'node:assert/strict';
import test from 'node:test';

import { alertState, newlyAlerting, sameState, stockAlertFileName, stockAlertMail } from './stock-alert.mjs';

const item = (productId, status, extra = {}) => ({ productId, title: `Produit ${productId}`, stock: 10, unitsOut: 5, coverDays: 9, status, ...extra });

test('state: the out-of-stock and critical ids, sorted', () => {
  assert.deepEqual(alertState([item('b', 'critical'), item('c', 'out'), item('a', 'critical')]), { out: ['c'], critical: ['a', 'b'] });
});

test('newly alerting: entered the set, or went from critical to out; staying put is not news', () => {
  const previous = { out: ['x'], critical: ['y', 'z'] };
  assert.deepEqual(newlyAlerting(previous, { out: ['x'], critical: ['y', 'z'] }), []);
  assert.deepEqual(newlyAlerting(previous, { out: ['x', 'y'], critical: ['z', 'n'] }), ['y', 'n']);
  // Out of stock to critical (restocked a little) is not news; leaving is not news.
  assert.deepEqual(newlyAlerting(previous, { out: [], critical: ['x'] }), []);
  // Back in after leaving: the previous state no longer holds it, so it is new.
  assert.deepEqual(newlyAlerting({ out: [], critical: [] }, { out: [], critical: ['y'] }), ['y']);
});

test('same state ignores order', () => {
  assert.equal(sameState({ out: ['a', 'b'], critical: [] }, { out: ['b', 'a'], critical: [] }), true);
  assert.equal(sameState({ out: ['a'], critical: [] }, { out: [], critical: ['a'] }), false);
});

test('the mail names the new products, counts the file, and gives the definition', () => {
  const items = [item('1', 'out', { title: 'Sérum Éclat', stock: 0 }), item('2', 'critical', { title: 'Crème Nuit', stock: 12, coverDays: 6.4 }), item('3', 'critical')];
  const one = stockAlertMail({ brand: 'Barbara Gould', items, newIds: ['1'] });
  assert.equal(one.subject, 'Alerte stock Barbara Gould : 1 produit en rupture ou critique');
  assert.match(one.text, /Un produit vient de passer en rupture ou en stock critique :\n- Sérum Éclat : en rupture\n/);
  assert.match(one.text, /Le fichier joint liste les 3 produits actuellement en rupture ou critiques\./);
  assert.match(one.text, /moins de 14 jours de couverture au rythme des 30 derniers jours, ou moins de 40 unités/);
  const two = stockAlertMail({ brand: 'Qiriness', items, newIds: ['1', '2'] });
  assert.equal(two.subject, 'Alerte stock Qiriness : 2 produits en rupture ou critiques');
  assert.match(two.text, /- Crème Nuit : critique, 12 unités, 6 jours de couverture/);
  assert.equal(stockAlertFileName('Barbara Gould', new Date('2026-10-28T07:30:00Z')), 'barbara-gould-alerte-stock-2026-10-28.xlsx');
});
