"use client";
import { useRef, useState } from 'react';
import { checkManualMetric } from '../../../scripts/lib/social-post-manual.mjs';
import { useT } from '@/lib/i18n/client';
import type { ManualPostMetric } from '@/lib/social-types';
import styles from './SocialView.module.css';

export function ManualMetricCell({ metric, value, display, editable, manual, className, bandLabel, onSave }: {
  metric: ManualPostMetric; value: number | null; display: string; editable: boolean; manual: boolean;
  className?: string; bandLabel?: string; onSave: (value: number | null) => Promise<boolean>;
}) {
  const tr = useT();
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [saving, setSaving] = useState(false), [invalid, setInvalid] = useState(false);
  const busy = useRef(false), cancelled = useRef(false);
  const label = tr(`insights.social.posts.col.${metric}`);
  async function commit() {
    if (busy.current || cancelled.current) return;
    const checked = checkManualMetric(metric, draft);
    if (!checked.ok) { setInvalid(true); return; }
    if (checked.value === value) { setEditing(false); return; }
    busy.current = true; setSaving(true);
    const ok = await onSave(checked.value);
    busy.current = false; setSaving(false);
    if (ok) setEditing(false);
  }
  return <td className={className} title={bandLabel}>
    {editing ? <>
      <input className={styles.manualInput} type="text" inputMode={metric === 'engagementRate' || metric === 'nonFollowersPct' ? 'decimal' : 'numeric'}
        autoFocus disabled={saving} value={draft} aria-label={label} aria-invalid={invalid}
        onChange={e => {setDraft(e.target.value);setInvalid(false);}} onBlur={commit}
        onKeyDown={e => {if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){cancelled.current=true;setEditing(false);}}} />
      {invalid && <span role="alert" className={styles.manualLabel}>{tr('insights.social.posts.manual.invalid')}</span>}
    </> : editable ? <button type="button" className={styles.manualCell}
      aria-label={tr(value === null ? 'insights.social.posts.manual.addLabel' : 'insights.social.posts.manual.editLabel', {metric:label})}
      title={tr('insights.social.posts.manual.help')} onClick={() => {cancelled.current=false;setInvalid(false);setDraft(value === null ? '' : String(value));setEditing(true);}}>
      {value === null ? <span className={styles.manualEmpty}>{tr('insights.social.posts.manual.add')}</span> : display}
    </button> : display}
    {manual && <small className={styles.manualLabel}>{tr('insights.social.posts.manual.label')}</small>}
  </td>;
}
