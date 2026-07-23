// Thin wrapper over the OpenAI embeddings endpoint. Kept dependency-free (raw
// fetch) to match the rest of scripts/lib, and with an injectable fetch so unit
// tests never touch the network.

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

// OpenAI accepts up to 2048 inputs per request; stay well under to keep payloads
// modest. At this project's volume a single batch usually suffices anyway.
const MAX_INPUTS_PER_REQUEST = 256;
const MAX_RETRIES = 3;

/**
 * @param {object} options
 * @param {string} options.apiKey            OpenAI API key (required).
 * @param {string} [options.model]           defaults to text-embedding-3-small.
 * @param {number} [options.dimensions]      defaults to 1536.
 * @param {typeof fetch} [options.fetchImpl] injectable for tests.
 * @param {(ms:number)=>Promise<void>} [options.sleepImpl] injectable for tests.
 */
export function createEmbeddingsClient({
  apiKey,
  model = 'text-embedding-3-small',
  dimensions = 1536,
  fetchImpl = fetch,
  sleepImpl = defaultSleep
} = {}) {
  if (!apiKey) {
    throw new Error(
      'OpenAI API key is missing. Set OPENAI_API_KEY before embedding knowledge chunks.'
    );
  }

  /**
   * Embeds a list of input strings, preserving order. Returns one vector
   * (number[]) per input.
   * @param {string[]} inputs
   * @returns {Promise<number[][]>}
   */
  async function embed(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return [];
    }

    const vectors = [];
    for (let start = 0; start < inputs.length; start += MAX_INPUTS_PER_REQUEST) {
      const batch = inputs.slice(start, start + MAX_INPUTS_PER_REQUEST);
      const batchVectors = await embedBatch(batch);
      vectors.push(...batchVectors);
    }
    return vectors;
  }

  async function embedBatch(batch) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response;
      try {
        response = await fetchImpl(OPENAI_EMBEDDINGS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ model, dimensions, input: batch })
        });
      } catch (error) {
        if (attempt <= MAX_RETRIES) {
          await sleepImpl(backoffMs(attempt));
          continue;
        }
        throw new Error(`OpenAI embeddings request failed: ${error.message}`);
      }

      if (response.ok) {
        const payload = await response.json();
        return payload.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding);
      }

      // Retry on rate limiting and transient server errors only.
      if ((response.status === 429 || response.status >= 500) && attempt <= MAX_RETRIES) {
        await sleepImpl(backoffMs(attempt));
        continue;
      }

      const detail = await response.text().catch(() => `HTTP ${response.status}`);
      throw new Error(`OpenAI embeddings request failed (${response.status}): ${detail}`);
    }
  }

  return { embed, model, dimensions };
}

function backoffMs(attempt) {
  return 250 * 2 ** (attempt - 1);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
