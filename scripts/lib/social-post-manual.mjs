import { postEngagementRate } from './social-figures.mjs';
/** Manual post annotations use table units: counts or percentage points. */
export const MANUAL_POST_METRICS = ['views','reach','engagementRate','likes','comments','shares','follows','engagement','nonFollowersPct'];
/** @returns {{ok:true,value:number|null}|{ok:false,error:string}} */
export function checkManualMetric(metric, input) {
  if (!MANUAL_POST_METRICS.includes(metric)) return { ok: false, error: 'Unknown post metric' };
  if (input === null || input === '') return { ok: true, value: null };
  if (!['number','string'].includes(typeof input)) return { ok: false, error: 'Enter a number' };
  const text = String(input).trim();
  if (!text) return { ok: true, value: null };
  const percent = metric === 'engagementRate' || metric === 'nonFollowersPct';
  const value = Number(percent ? text.replace(',', '.').replace(/%$/, '') : text);
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (!percent && !Number.isSafeInteger(value)))
    return { ok: false, error: percent ? 'Enter a non-negative percentage' : 'Enter a non-negative whole number' };
  if (metric === 'nonFollowersPct' && value > 100) return { ok: false, error: 'Enter a percentage between 0 and 100' };
  return { ok: true, value: percent ? Math.round(value * 100) / 100 : value };
}
/** Native or calculated values (including zero) always take precedence. */
export function applyManualPost(post, entries = [], basis = post.engagementBasis) {
  const result = { ...post, manualMetrics: [...(post.manualMetrics ?? [])] };
  for (const entry of entries) {
    if (!MANUAL_POST_METRICS.includes(entry.metric) || result[entry.metric] != null || (entry.metric === 'engagementRate' && entry.basis !== basis)) continue;
    result[entry.metric] = Number(entry.value);
    result.manualMetrics.push(entry.metric);
  }
  return result;
}

/** Keep acknowledged edits visible while dashboard refreshes are still in flight. */
export function applySavedPostMetrics(post, entries = []) {
  const result = { ...post, manualMetrics: [...(post.manualMetrics ?? [])], bands: {...post.bands} };
  let rateInputsChanged = false;
  let explicitRate;
  for (const entry of entries) {
    const metric = entry.metric;
    if (!MANUAL_POST_METRICS.includes(metric) ||
        (metric === 'engagementRate' && entry.basis !== post.engagementBasis) ||
        (post[metric] !== null && !post.manualMetrics?.includes(metric))) continue;
    if (metric === 'engagementRate') { explicitRate = entry.value; continue; }
    if (result[metric] !== entry.value) {
      delete result.bands[metric];
      if (metric === 'engagement' || metric === post.engagementBasis) rateInputsChanged = true;
    }
    result[metric] = entry.value;
    result.manualMetrics = result.manualMetrics.filter(m => m !== metric);
    if (entry.value !== null) result.manualMetrics.push(metric);
  }
  if (rateInputsChanged) {
    // The browser has no account follower denominator; the refreshed server read supplies it.
    result.engagementRate = postEngagementRate(result, post.engagementBasis, null);
    result.manualMetrics = result.manualMetrics.filter(m => m !== 'engagementRate');
    result.rateFromManual = result.engagementRate !== null &&
      ['engagement',post.engagementBasis].some(metric => result.manualMetrics.includes(metric));
    delete result.bands.engagementRate;
  }
  if (explicitRate !== undefined && (result.engagementRate === null || result.manualMetrics.includes('engagementRate'))) {
    result.engagementRate = explicitRate;
    result.manualMetrics = result.manualMetrics.filter(m => m !== 'engagementRate');
    if (explicitRate !== null) result.manualMetrics.push('engagementRate');
  }
  return result;
}
