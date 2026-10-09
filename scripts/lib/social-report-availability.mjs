// Self-contained pure functions also embedded in the offline report editor.
export function reportPeriodTotals(p, range, erBasis) {
  const numeric=v=>typeof v==='number'&&Number.isFinite(v);
  const rows=range.months.map(month=>p.monthly.find(row=>row.month===month));
  const sum=key=>rows.every(row=>numeric(row?.[key]))?rows.reduce((n,row)=>n+row[key],0):null;
  const first=rows[0],last=rows.at(-1),native=p.nativePeriodMetrics.find(row=>row.start===range.start&&row.end===range.end);
  const followers=numeric(last?.followersEnd)?last.followersEnd:null;
  const followersStart=numeric(first?.followersStart)?first.followersStart:null;
  const measuredNet=sum('netFollows');
  const snapshotChange=numeric(followers)&&numeric(followersStart)&&(!last?.followersEndDay||last.followersEndDay>=range.start)?followers-followersStart:null;
  const ratio=(a,b)=>numeric(a)&&numeric(b)&&b>0?a/b:null;
  const out={complete:rows.every(row=>row?.status==='complete'),availableMonths:rows.filter(row=>row?.status==='complete').length,totalMonths:rows.length,
    views:sum('views'),impressions:sum('impressions'),interactions:sum('interactions'),profileVisits:sum('profileVisits'),linkTaps:sum('linkTaps'),
    likes:sum('likes'),comments:sum('comments'),shares:sum('shares'),saves:sum('saves'),posts:sum('postsPublished'),followers,followersStart,
    followersEndDay:last?.followersEndDay??null,followersStartDay:first?.followersStartDay??null,
    netFollows:measuredNet??snapshotChange,netFollowsBasis:numeric(measuredNet)?'Measured follows minus unfollows':'Change between dated follower snapshots',
    reach:numeric(native?.reach)?native.reach:null,accountsEngaged:numeric(native?.accountsEngaged)?native.accountsEngaged:null,
    nonFollowerShare:numeric(native?.nonFollowerShare)?native.nonFollowerShare:null,nonFollowerBasis:native?.nonFollowerBasis??null,
    coverage:Object.fromEntries(['views','engagement','profile_visits','link_taps','posts','follows','unfollows'].map(key=>[key,rows.reduce((a,row)=>({expected:a.expected+(row?.coverage?.[key]?.expected??0),measured:a.measured+(row?.coverage?.[key]?.measured??0)}),{expected:0,measured:0})]))};
  out.engagementRate=ratio(out.interactions,erBasis==='views'?out.views:out.reach);
  out.visitRate=ratio(out.profileVisits,out.views);out.profileLinkRate=ratio(out.linkTaps,out.profileVisits);
  return out;
}

export function reportMissingReasons(p, totals, range) {
  const numeric=v=>typeof v==='number'&&Number.isFinite(v);
  const reasons=[];
  for(const [field,column,label] of [['views','views','Views'],['interactions','engagement','Interactions'],['profileVisits','profile_visits','Profile visits'],['linkTaps','link_taps','Link taps'],['posts','posts','Published posts']]) {
    if(numeric(totals[field]))continue;
    const coverage=totals.coverage?.[column];
    reasons.push([label,coverage?.measured>0?`${coverage.measured} of ${coverage.expected} account-days measured. A full-period total cannot be calculated.`:`No measured daily ${label.toLowerCase()} for this period. The provider did not supply them or they have not been synced.`]);
  }
  if(!numeric(totals.followers))reasons.push(['Followers','No follower snapshot on or before this period end. Historical follower totals cannot be reconstructed from today’s count.']);
  else if(totals.followersEndDay&&totals.followersEndDay!==range.end)reasons.push(['Follower observation',`Latest count on/before period end: ${totals.followersEndDay}. It is not an exact end-date observation.`]);
  if(!numeric(totals.netFollows))reasons.push(['Net follows','Complete daily follows/unfollows or two dated boundary follower snapshots are missing.']);
  if(!numeric(totals.followersStart)||totals.followersStart<=0)reasons.push(['Follower growth rate','A measured starting follower count greater than zero is required for percentage growth. A measured net change alone is insufficient.']);
  if(!numeric(totals.reach))reasons.push(['Unique reach',p.id==='instagram'?(Date.parse(range.end+'T00:00:00Z')-Date.parse(range.start+'T00:00:00Z')>=30*86400000?'This period exceeds the connector’s 30-day native unique-count window. Daily/monthly reach cannot be added for 6- or 12-month totals.':'The exact-period native read did not return a unique reach count. Access, provider retention or unavailable metrics may prevent the read.'):'No exact-period unique reach is supplied by this connector. Daily unique audiences cannot be added.']);
  if(!numeric(totals.accountsEngaged))reasons.push(['Accounts engaged','No native unique accounts-engaged count for the exact report period.']);
  if(!numeric(totals.nonFollowerShare))reasons.push(['Followers / non-followers','The connector does not supply an account-period follower split. Manual post percentages are separate.']);
  if(!numeric(totals.engagementRate))reasons.push(['Engagement rate','Measured interactions and the selected denominator (views or exact-period reach) are required.']);
  if(!numeric(totals.impressions))reasons.push(['Impressions','The stored account data uses views; a separate impression total is not supplied.']);
  return reasons;
}
