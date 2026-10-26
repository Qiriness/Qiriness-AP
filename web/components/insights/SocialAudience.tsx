"use client";
import {useRef,useState} from 'react';
import {useT,useFormat} from '@/lib/i18n/client';
import type {AudienceDimension,OrganicKind,SocialAudience as AudienceData} from '@/lib/social-types';
import {checkAudienceEntries} from '../../../scripts/lib/social-audience-manual.mjs';
import {BarList,Card,Grid,Caption} from './InsightsKit';
import styles from './SocialAudience.module.css';
import { useInsightsFrame } from "./InsightsFrame";
const DIMS:AudienceDimension[]=['gender','age','country','city'];
export function SocialAudience({audience,kind}:{audience:AudienceData|null;kind:OrganicKind}) {
  const tr=useT();
  return <>
    <h2>{tr('insights.social.audience.title')}</h2>
    <Grid min={14} pin="social-audience" label={tr('insights.social.audience.title')}>
      {DIMS.map(dimension=><AudienceGraph key={`${audience?.companyId}|${kind}|${dimension}`} dimension={dimension} audience={audience} kind={kind}/>)}
    </Grid>
    <Caption>{tr('insights.social.audience.manual.caption')}</Caption>
  </>;
}
function AudienceGraph({dimension,audience,kind}:{dimension:AudienceDimension;audience:AudienceData|null;kind:OrganicKind}) {
  const tr=useT(),{percentOf,integer}=useFormat();
  const { api } = useInsightsFrame();
  // Acknowledged writes render immediately; a slow dashboard read cannot restore old entries.
  const [saved,setSaved]=useState<{data:AudienceData[AudienceDimension];capturedOn:string}|null>(null);
  const native=audience?.dimensionMeta?.[dimension]?.source==='platform';
  const data=!native&&saved?saved.data:audience?.[dimension]??[];
  const meta=!native&&saved?(saved.data.length?{source:'manual',capturedOn:saved.capturedOn}:undefined):audience?.dimensionMeta?.[dimension];
  const manual=meta?.source==='manual',editable=!data.length||manual;
  const title=tr(`insights.social.audience.${dimension}`),today=audience?.today??new Date().toISOString().slice(0,10);
  const [editing,setEditing]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState<string|null>(null);
  const nextRow=useRef(0),busy=useRef(false);
  const [date,setDate]=useState(today),[rows,setRows]=useState<{id:number;key:string;value:string}[]>([]);
  function open() {setRows(data.length?data.map(b=>({id:nextRow.current++,key:b.key,value:String(b.share)})):[{id:nextRow.current++,key:dimension==='gender'?'female':dimension==='age'?'18-24':'',value:''}]);setDate(meta?.capturedOn??today);setError(null);setEditing(true);}
  function change(id:number,field:'key'|'value',value:string) {setRows(current=>current.map(row=>row.id===id?{...row,[field]:value}:row));}
  function addRow() {
    const id=nextRow.current++;
    setRows(current=>[...current,{id,key:dimension==='gender'?['female','male','unknown'].find(g=>!current.some(r=>r.key===g))??'':'',value:''}]);
  }
  async function save(clear=false) {
    if(busy.current)return;
    const checked=clear?{ok:true as const,entries:null}:checkAudienceEntries(dimension,rows);
    if(!checked.ok){setError(tr('insights.social.audience.manual.invalid'));return;}
    busy.current=true;setSaving(true);setError(null);
    try {
      const response=await fetch(api('/api/insights/social/manual-audience'),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,dimension,capturedOn:date,entries:checked.entries})});
      if(!response.ok)throw new Error();
      setSaved({data:(checked.entries??[]).map(entry=>({...entry,share:entry.value})),capturedOn:date});
      setEditing(false);
    }catch{setError(tr('insights.social.audience.manual.failed'));}finally{busy.current=false;setSaving(false);}
  }
  return <Card title={title} aside={meta?<span className={styles.source}>{manual?tr('insights.social.posts.manual.label'):null}{manual?' · ':''}{meta.capturedOn}</span>:undefined}>
    {editing?<form aria-label={tr('insights.social.audience.manual.form',{graph:title})} className={styles.form} onSubmit={e=>{e.preventDefault();void save();}} onKeyDown={e=>{if(e.key==='Escape'&&!saving){e.preventDefault();setEditing(false);setError(null);}}}>
      <p className={styles.help}>{tr('insights.social.audience.manual.help')}</p>
      <label>{tr('insights.social.audience.manual.date')}<input type="date" min="2000-01-01" max={today} required value={date} disabled={saving} onChange={e=>setDate(e.target.value)}/></label>
      {rows.map((row,i)=><div key={row.id} className={styles.row}>
        {dimension==='gender'?<select aria-label={tr('insights.social.audience.manual.category',{row:i+1})} value={row.key} disabled={saving} onChange={e=>change(row.id,'key',e.target.value)}>{['female','male','unknown'].map(g=><option key={g} value={g}>{tr(`insights.social.audience.gender.${g}`)}</option>)}</select>:
          <input aria-label={tr('insights.social.audience.manual.category',{row:i+1})} placeholder={tr('insights.social.audience.manual.category',{row:i+1})} maxLength={80} required value={row.key} disabled={saving} onChange={e=>change(row.id,'key',e.target.value)}/>}
        <input type="text" inputMode="decimal" aria-label={tr('insights.social.audience.manual.percent',{row:i+1})} placeholder="%" required value={row.value} disabled={saving} onChange={e=>change(row.id,'value',e.target.value)}/>
        <button type="button" aria-label={tr('insights.social.audience.manual.remove',{row:i+1})} disabled={saving||rows.length===1} onClick={()=>setRows(current=>current.filter(r=>r.id!==row.id))}>×</button>
      </div>)}
      <button type="button" disabled={saving||rows.length>=(dimension==='gender'?3:50)} onClick={addRow}>{tr('insights.social.audience.manual.addRow')}</button>
      <div className={styles.actions}>
        <button type="submit" disabled={saving}>{tr('insights.social.audience.manual.save')}</button>
        <button type="button" disabled={saving} onClick={()=>{setEditing(false);setError(null);}}>{tr('insights.social.audience.manual.cancel')}</button>
        {manual&&<button type="button" disabled={saving} onClick={()=>void save(true)}>{tr('insights.social.audience.manual.clear')}</button>}
      </div>
    </form>:<>
      {data.length?<BarList ariaLabel={title} data={data.slice(0,dimension==='gender'?3:dimension==='age'?8:5).map(b=>({key:b.key,label:dimension==='gender'?tr(`insights.social.audience.gender.${b.key}`):b.key,value:b.share,display:percentOf(b.share,1),title:manual?tr('insights.social.posts.manual.label'):integer(b.value)}))}/>:<p>{tr('insights.social.audience.dimNone')}</p>}
      {editable&&<button className={styles.edit} type="button" onClick={open} aria-label={tr(manual?'insights.social.audience.manual.editLabel':'insights.social.audience.manual.addLabel',{graph:title})}>{tr(manual?'insights.social.audience.manual.edit':'insights.social.posts.manual.add')}</button>}
    </>}
    {error&&<p role="alert">{error}</p>}
  </Card>;
}
