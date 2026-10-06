import { policyTopics, countryForTurn, countriesIn, countryAnswer } from './knowledge-topics.mjs';
import { getPolicy, searchFaqs } from './knowledge-tools.mjs';

/** Deterministic opening retrieval. Product guidance is deliberately absent. */
export function retrieveKnowledge({ message, knowledge, resolution = null, context = {}, history = [], currency = 'EUR', now = Date.now() }) {
  let topics = policyTopics(message);
  // An elliptical follow-up may reuse the last retrieval topic, never a new subject.
  const countryFollowup = Boolean(countryAnswer(message) || countriesIn(message).length && /^(et\s+)?(en|pour|vers)\s+/i.test(message.trim()));
  if (!topics.length && (countryFollowup || /^(et\s+)?(les?\s+)?(delais?|combien)\s*\??$/i.test(message.trim()))) {
    const previous = [...history].reverse().find((m) => m.role === 'assistant');
    const previousTopics = previous?.context?.trace?.knowledge?.topics ?? [];
    topics = countryFollowup ? previousTopics.includes('delivery') ? ['delivery'] : [] : previousTopics;
  }
  const destination = countryForTurn(message, context, history);
  const product = Boolean(resolution?.products?.length || resolution?.clarification);
  const results = [];
  if (topics.length) {
    for (const topic of topics) results.push({ tool: 'get_policy', result: getPolicy(knowledge, { topic, country: destination.country }, { query: message, currency, now }) });
  } else if (!product && knowledge) {
    const result = searchFaqs(knowledge, { query: message }, { locale: context.locale, now });
    if (result.status !== 'not_found') {
      results.push({ tool: 'search_faqs', result });
      for (const match of result.matches ?? []) for (const ref of match.policy_reference ?? []) {
        topics.push(ref.topic);
        results.push({ tool: 'get_policy', result: getPolicy(knowledge, { ...ref, country: destination.country }, { currency, now }) });
      }
    }
  }
  const route = topics.length ? product ? 'product_and_policy' : 'general_policy' : product ? 'product_data' : results.length ? 'general_faq' : 'unclassified';
  return { route, topics: [...new Set(topics)], country: destination.country, country_explicit: destination.explicit, country_ambiguous: destination.ambiguous, results };
}
