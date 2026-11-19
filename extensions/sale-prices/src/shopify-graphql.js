/**
 * The admin page's GraphQL caller, in the shape the shared sale-prices modules
 * expect: graphql(query, variables) -> data, throwing on errors.
 *
 * It goes through Shopify's direct API access (`shopify.query`): Shopify
 * authenticates it as the staff member using the page, with the app's scopes,
 * so there is no token or backend here. A staff member without permission to
 * edit products gets Shopify's refusal, shown as the error.
 *
 * Throttling is retried with a growing pause, like the CLI's client does.
 */
const ATTEMPTS = 5;
const BASE_WAIT_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isThrottled = (errors) =>
  errors.some((error) => error?.extensions?.code === 'THROTTLED' || /throttled/i.test(error?.message || ''));

export async function graphql(query, variables = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let result;
    try {
      result = await shopify.query(query, { variables });
    } catch (error) {
      if (attempt >= ATTEMPTS) throw new Error(`Shopify request failed: ${error.message}`);
      await sleep(BASE_WAIT_MS * 2 ** (attempt - 1));
      continue;
    }

    const errors = result?.errors || [];
    if (errors.length > 0) {
      if (isThrottled(errors) && attempt < ATTEMPTS) {
        await sleep(BASE_WAIT_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(errors.map((error) => error.message).join('; '));
    }
    return result.data;
  }
}
