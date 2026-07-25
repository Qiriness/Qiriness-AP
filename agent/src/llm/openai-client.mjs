// Thin, dependency-free wrapper over the OpenAI Chat Completions endpoint,
// matching scripts/lib/embeddings/openai-embeddings-client.mjs (raw fetch,
// injectable fetch/sleep, retry on 429/5xx). Shared by the spam classifier now
// and the categoriser / drafting stages later.

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_RETRIES = 3;

export function createOpenAIClient({ apiKey, fetchImpl = fetch, sleepImpl = defaultSleep } = {}) {
  if (!apiKey) {
    throw new Error('OpenAI API key is missing. Set OPENAI_API_KEY.');
  }

  // Runs a chat completion constrained to a JSON schema (Structured Outputs) and
  // returns the parsed object. Deterministic (temperature 0) for classification.
  async function completeJson({ model, system, user, schema, schemaName = 'result', maxTokens = 400 }) {
    const body = {
      model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, schema, strict: true }
      }
    };

    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response;
      try {
        response = await fetchImpl(OPENAI_CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch (error) {
        if (attempt <= MAX_RETRIES) {
          await sleepImpl(backoffMs(attempt));
          continue;
        }
        throw new Error(`OpenAI request failed: ${error.message}`);
      }

      if (response.ok) {
        const payload = await response.json();
        const content = payload.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('OpenAI response had no content.');
        }
        return JSON.parse(content);
      }

      if ((response.status === 429 || response.status >= 500) && attempt <= MAX_RETRIES) {
        await sleepImpl(backoffMs(attempt));
        continue;
      }

      const detail = await response.text().catch(() => `HTTP ${response.status}`);
      throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
    }
  }

  return { completeJson };
}

function backoffMs(attempt) {
  return 250 * 2 ** (attempt - 1);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
