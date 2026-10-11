export const AUDIENCE_DIMENSIONS = ['gender','age','country','city'];
/** @returns {{ok:true,entries:{key:string,value:number}[]}|{ok:false,error:string}} */
export function checkAudienceEntries(dimension, entries) {
  if (!AUDIENCE_DIMENSIONS.includes(dimension) || !Array.isArray(entries) || !entries.length || entries.length > 50)
    return {ok:false,error:'Enter between 1 and 50 audience categories'};
  const cleaned = [], keys = new Set();
  let total = 0;
  for (const entry of entries) {
    const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
    const input = entry?.value;
    const value = typeof input === 'number' ? input : typeof input === 'string' && input.trim() ? Number(input.trim().replace(',', '.').replace(/%$/, '')) : NaN;
    if (!key || key.length > 80 || /[\u0000-\u001f]/.test(key) || keys.has(key.toLowerCase()) ||
        (dimension === 'gender' && !['female','male','unknown'].includes(key)) || !Number.isFinite(value) || value < 0 || value > 100)
      return {ok:false,error:'Use unique categories and percentages between 0 and 100'};
    const points = Math.round(value * 100);
    total += points;keys.add(key.toLowerCase());cleaned.push({key,value:points/100});
  }
  if (total > 10000) return {ok:false,error:'Audience percentages must total no more than 100'};
  return {ok:true,entries:cleaned};
}
export function validAudienceDate(date, asOf) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '2000-01-01' && date <= asOf &&
    Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date;
}
/** Missing dimensions only; entered percentages are never renormalized. */
export function fillManualAudience(native, rows, asOf) {
  const result = {...(native ?? {capturedOn:null,gender:[],age:[],country:[],city:[]}), today:asOf, dimensionMeta:{...(native?.dimensionMeta ?? {})}};
  for (const dimension of AUDIENCE_DIMENSIONS) {
    if (result[dimension].length) continue;
    const row = rows.find(r=>r.dimension===dimension && r.captured_on<=asOf);
    if (!row) continue;
    result[dimension] = row.entries.map(e=>({key:e.key,value:e.value,share:e.value})).sort((a,b)=>b.share-a.share);
    result.dimensionMeta[dimension] = {source:'manual',capturedOn:row.captured_on};
  }
  const dates = Object.values(result.dimensionMeta).map(meta=>meta.capturedOn).filter(Boolean);
  result.capturedOn = [...dates, result.capturedOn].filter(Boolean).sort().at(-1) ?? null;
  return result;
}
/** Attach manual gaps to the latest report snapshot, retaining per-graph dates. */
export function manualAudienceReport(snapshots, rows, asOf) {
  const latest = [...snapshots].filter(s=>s.asOf<=asOf).sort((a,b)=>b.asOf.localeCompare(a.asOf))[0];
  const names = {gender:'gender',age:'age',country:'countries',city:'cities'};
  const native = {capturedOn:latest?.asOf??null,dimensionMeta:{},gender:[],age:[],country:[],city:[]};
  for (const dim of AUDIENCE_DIMENSIONS) {
    native[dim]=(latest?.[names[dim]]??[]).map(b=>({key:b.label,value:b.value,share:b.value}));
    if(native[dim].length)native.dimensionMeta[dim]={source:'platform',capturedOn:latest.asOf};
  }
  const merged=fillManualAudience(native,rows,asOf);
  const manualDimensions=AUDIENCE_DIMENSIONS.filter(dim=>merged.dimensionMeta[dim]?.source==='manual');
  if(!manualDimensions.length)return snapshots;
  const snapshot={asOf:merged.capturedOn,basis:'followers',manualDimensions,dimensionDates:Object.fromEntries(Object.entries(merged.dimensionMeta).map(([dim,meta])=>[dim,meta.capturedOn]))};
  for(const dim of AUDIENCE_DIMENSIONS)snapshot[names[dim]]=merged[dim].map(b=>({label:dim==='gender'?({female:'Female',male:'Male',unknown:'Unknown'}[b.key]??b.key):b.key,value:b.share}));
  return [...snapshots.filter(s=>s.asOf!==snapshot.asOf),snapshot];
}
