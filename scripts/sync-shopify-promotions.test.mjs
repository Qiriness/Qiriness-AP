import assert from 'node:assert/strict';
import test from 'node:test';

import { expandDiscountItemPages } from './sync-shopify-promotions.mjs';

const product = (n) => ({ id: `gid://shopify/Product/${n}`, title: `Produit ${n}` });

function bxgyNode({ buys, gets }) {
  return {
    id: 'gid://shopify/DiscountAutomaticNode/1',
    discount: {
      __typename: 'DiscountAutomaticBxgy',
      title: 'Masque offert dès 65€',
      customerBuys: { items: { __typename: 'DiscountProducts', products: buys } },
      customerGets: { items: { __typename: 'DiscountProducts', products: gets } }
    }
  };
}

test('a product list Shopify says continues is fetched to the end', async () => {
  const calls = [];
  const pages = {
    'c-20': { nodes: [product(21), product(22)], pageInfo: { hasNextPage: true, endCursor: 'c-22' } },
    'c-22': { nodes: [product(23)], pageInfo: { hasNextPage: false, endCursor: null } }
  };
  const node = bxgyNode({
    buys: { nodes: Array.from({ length: 20 }, (_, i) => product(i + 1)), pageInfo: { hasNextPage: true, endCursor: 'c-20' } },
    gets: { nodes: [product(99)], pageInfo: { hasNextPage: false, endCursor: null } }
  });

  const [expanded] = await expandDiscountItemPages([node], async (id, leg, cursor) => {
    calls.push([id, leg, cursor]);
    return pages[cursor];
  });

  const buys = expanded.discount.customerBuys.items.products;
  assert.equal(buys.nodes.length, 23);
  assert.equal(buys.pageInfo.hasNextPage, false);
  assert.deepEqual(calls.map(([, leg, cursor]) => [leg, cursor]), [['customerBuys', 'c-20'], ['customerBuys', 'c-22']]);
  // The complete leg is untouched, and the input is not mutated.
  assert.equal(expanded.discount.customerGets.items.products.nodes.length, 1);
  assert.equal(node.discount.customerBuys.items.products.nodes.length, 20);
});

test('collections page the same way', async () => {
  const node = {
    id: 'gid://shopify/DiscountAutomaticNode/2',
    discount: {
      __typename: 'DiscountAutomaticBasic',
      customerGets: {
        items: {
          __typename: 'DiscountCollections',
          collections: { nodes: [{ id: 'c1', title: 'Masques' }], pageInfo: { hasNextPage: true, endCursor: 'x' } }
        }
      }
    }
  };
  const [expanded] = await expandDiscountItemPages([node], async () => ({
    nodes: [{ id: 'c2', title: 'Soins' }],
    pageInfo: { hasNextPage: false, endCursor: null }
  }));
  assert.deepEqual(expanded.discount.customerGets.items.collections.nodes.map((c) => c.id), ['c1', 'c2']);
});

test('a discount with nothing more to fetch costs no request', async () => {
  const node = {
    id: 'gid://shopify/DiscountAutomaticNode/3',
    discount: {
      __typename: 'DiscountAutomaticFreeShipping',
      title: 'Frais de port offerts'
    }
  };
  const [expanded] = await expandDiscountItemPages([node], async () => {
    throw new Error('should not fetch');
  });
  assert.equal(expanded, node);
});
