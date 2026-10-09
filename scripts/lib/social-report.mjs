import template from './social-report-template.mjs';
import { bandOf, median } from './social-bands.mjs';
import { reportPeriodTotals } from './social-report-availability.mjs';
import { postActivity } from './social-figures.mjs';

const sections = [ ['cover', 'Cover'], ['overview', 'Executive overview'], ['performance', 'Platform performance'], ['audience', 'Audience insights'], ['content', 'Content performance'], ['strategy', 'Concluding summary'], ['method', 'Definitions & colour coding'] ];
export function socialReportState(data, { name, locale = 'en-GB', months = 1, endMonth, platforms }) {
  const includedPlatforms = platforms ?? data.platforms.map(p => p.id);
  if (![1, 6, 12].includes(months) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(endMonth) || !includedPlatforms.length || includedPlatforms.some(id => !data.platforms.some(p => p.id === id))) throw new Error('Invalid report context.');
  return { schemaVersion: 1, selectedCompany: data.companyId,
    settings: { months, endMonth, platform: 'all', includedPlatforms, erBasis: 'views', rank: 'views', postCount: 10 },
    companies: [{ id: data.companyId, brand: { name, coverHeadingPosition: 'right', tagline: 'Social media performance', author: 'Marketing team', ink: '#45281f', accent: '#6b8177', paper: '#faf8f0', tint: '#e7eadd', headingFont: 'Georgia', bodyFont: 'Arial', locale, currency: data.currency, logo: null, customHeading: null, customBody: null },
      data, drafts: {}, images: {}, sections: sections.map(([id, label]) => ({ id, label, visible: true })) }] };
}

/** Bind revision 6; scoped presentation overrides preserve its editor and pagination. */
export function renderSocialReport(state) {
  const json = JSON.stringify(state).replace(/</g, String.fromCharCode(92) + 'u003c');
  let html = template.replace('<script id="saved-state" type="application/json">null</script>', () => '<script id="saved-state" type="application/json">' + json + '</script>');
  html = html.replaceAll('social-report-studio-v1', 'social-report-studio-v1-' + state.selectedCompany);
  html = html.replace("p.scope!=='organic'", '![' + "'organic','account'" + '].includes(p.scope)');
  html = html.replace('<span class="table-sub">Organic</span>', "<span class=\"table-sub\">${p.scope==='account'?'Account activity':'Organic'}</span>");
  html = html.replace('Organic views over the six months', 'Views over the six months').replace('brand’s organic presence', 'brand’s social presence');
  html = html.replace("const selectedPlatforms=()=>company().data.platforms.filter(p=>state.settings.platform==='all'||p.id===state.settings.platform);", "const selectedPlatforms=()=>company().data.platforms.filter(p=>(!state.settings.includedPlatforms||state.settings.includedPlatforms.includes(p.id))&&(state.settings.platform==='all'||p.id===state.settings.platform));");
  html = html.replace("state.settings.postCount].join('|')", "state.settings.postCount,(state.settings.includedPlatforms||company().data.platforms.map(p=>p.id)).slice().sort().join(',')].join('|')");
  html = html.replace('<label class="control"><span>Platform</span>', '<div id="included-platforms"></div><label class="control"><span>Platform</span>');
  const controls = "$('#included-platforms').innerHTML='<p class=\"hint\">Platforms included in the report</p>'+c.data.platforms.map(p=>'<label class=\"control\"><span><input type=\"checkbox\" data-include-platform=\"'+esc(p.id)+'\" '+(!s.includedPlatforms||s.includedPlatforms.includes(p.id)?'checked':'')+'> '+esc(p.name)+'</span></label>').join('');";
  html = html.replace('function syncControls(){const c=company(),b=c.brand,s=state.settings;', 'function syncControls(){const c=company(),b=c.brand,s=state.settings;if(s.includedPlatforms){s.includedPlatforms=s.includedPlatforms.filter(id=>c.data.platforms.some(p=>p.id===id));if(!s.includedPlatforms.length)s.includedPlatforms=c.data.platforms.map(p=>p.id)}' + controls);
  const handler = "$('#included-platforms').onchange=e=>{const ids=[...$('#included-platforms').querySelectorAll('input:checked')].map(x=>x.dataset.includePlatform);if(!ids.length){toast('Keep at least one platform.');syncControls();return}state.settings.includedPlatforms=ids;if(state.settings.platform!=='all'&&!ids.includes(state.settings.platform))state.settings.platform='all';update()};";
  html = html.replace('syncControls();window.SocialReport.ready=render();', handler + '\nsyncControls();window.SocialReport.ready=render();');
  // An invalid stored draft must never fall back to the illustrative company's results.
  html = html.replace('catch(e){state=initialState()}', 'catch(e){state=clone(embedded)}');
  const aggregateStart=html.indexOf('function aggregate(p,r){');
  const aggregateEnd=html.indexOf('function aggregatePaid(',aggregateStart);
  html=html.slice(0,aggregateStart)+'const reportPeriodTotals='+reportPeriodTotals.toString()+';\nfunction aggregate(p,r){return reportPeriodTotals(p,r,state.settings.erBasis);}\n'+html.slice(aggregateEnd);
  html=html.replace('s.asOf<=r.current.end',"s.asOf<=(company().data.audienceObservationPolicy==='latest-available'?company().data.asOf:r.current.end)");
  html=html.replace("!['views','reach'].includes(x.nonFollowerBasis)","!['views','reach','manual'].includes(x.nonFollowerBasis)");
  html=html.replace("snapshot.asOf<r.current.start?' (before the reporting period)':''", "snapshot.asOf>r.current.end?' (latest available; after the reporting period)':snapshot.asOf<r.current.start?' (before the reporting period)':''");
  const activityScript = `const dashboardPostActivity=${postActivity.toString()};
function reportPostingActivity(p){
  const posts=rankedPosts(p).filter(x=>x.publishedAtTimestamp&&Number.isFinite(Date.parse(x.publishedAtTimestamp))).map(x=>({id:x.id,accountId:x.accountId,publishedAt:x.publishedAtTimestamp,engagement:x.interactions,mediaType:x.format}));
  const activity=dashboardPostActivity(posts,[],[],company().data.timezone||'UTC');
  const weekdays=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const hour=h=>String(h).padStart(2,'0')+':00';
  const rows=(slots,label)=>slots.length?'<div class="activity-list">'+slots.map(x=>'<div><b>'+esc(label(x.slot))+'</b><span>'+fmt(x.average)+' avg. engagement · '+fmt(x.posts)+' posts</span></div>').join('')+'</div>':'<p class="caption">No measured post engagement for this period.</p>';
  if(company().data.postObservationPolicy!=='latest-available'&&p.activityTimes?.asOf<=range().current.end)return '<h3>Peak audience activity</h3><div class="activity-list">'+p.activityTimes.items.map(x=>'<div><b>'+esc(x.day)+'</b><span>'+esc(x.time)+'</span></div>').join('')+'</div>';
  return '<div class="posting-times"><h3>Best hours to post</h3>'+rows(activity.peakHours,h=>hour(h)+'–'+hour((h+1)%24))+'<h3>Best days to post</h3>'+rows(activity.peakDays,d=>weekdays[d])+'</div>';
}`;
  html=html.replace('function audienceChapter(p)',activityScript+'\nfunction audienceChapter(p)');
  const activityStart=html.indexOf('<h3>Peak audience activity</h3>${times?');
  const activityEnd=html.indexOf('</div></div><p class="note audience-note">',activityStart);
  if(activityStart<0||activityEnd<0)throw new Error('Report activity panel anchor missing.');
  html=html.slice(0,activityStart)+'${reportPostingActivity(p)}'+html.slice(activityEnd);
  html=html.replace('const months=monthList(state.settings.endMonth,6)', 'const months=monthList(state.settings.endMonth,+state.settings.months===12?12:6)');
  html=html.replace('x=i=>L+i*(W-L-R)/5', 'x=i=>L+i*(W-L-R)/(months.length-1)');
  html=html.replace('Organic views over the six months ending', 'Views over the ${months.length} months ending');
  html=html.replace('Organic views · last six months', 'Views · last ${+state.settings.months===12?12:6} months');
  html=html.replace("monthShift(state.settings.endMonth,-5)+'-01'", "monthShift(state.settings.endMonth,-(+state.settings.months===12?11:5))+'-01'");
  html=html.replace('The trend chart always shows the last six calendar months, ending with the report.', 'The trend shows twelve months for annual reports and six months otherwise, ending with the report.');
  html=html.replace('No audience snapshot available as of the reporting period end.', 'No demographic snapshot is stored for this platform. The provider may not support it or access may have been refused.');
  html=html.replace('net follows in the period</div>', '${a.netFollowsBasis===\'Measured follows minus unfollows\'?\'net follows in the period\':\'change between snapshots\'}</div><div class="qualifier">${esc(a.netFollowsBasis)}${a.followersEndDay?\' · follower count observed \'+esc(a.followersEndDay):\'\'}</div>');
  html=html.replace('Followers are the final snapshot; net growth is end minus start.', 'Followers use the latest dated snapshot on/before the period end, independently of activity coverage. Net follows uses complete measured follows minus unfollows; otherwise it uses a labeled change between dated snapshots.');
  html=html.replace('Demographics use a dated snapshot.', 'Connected reports show the latest stored demographic snapshot with its observation date; it may be after a historical reporting period. Imported historical-snapshot data retains its period-end cutoff.');
  html=html.replace('Latest snapshot on/before period end; lifetime-to-snapshot metrics, not account-period totals.', 'Connected post tables use latest stored lifetime figures with observation dates; imported historical-snapshot datasets retain their cutoff. Post lifetime metrics are not account-period totals.');

  // Publication belongs to the period; lifetime counters belong to their observation.
  // Imported historical-snapshot datasets retain revision 6's strict cutoff.
  html = html.replace('x.observedAt<=r.current.end', "(company().data.postObservationPolicy==='latest-available'?x.observedAt<=company().data.asOf:x.observedAt<=r.current.end)");
  const snapshotNote = "function postSnapshotNote(posts){if(company().data.postObservationPolicy!=='latest-available'||!posts.length)return '';const dates=[...new Set(posts.map(x=>x.observedAt))].sort();const observed=dates.length===1?dates[0]:dates[0]+' to '+dates.at(-1);return '<p class=\"caption\">Lifetime figures observed '+esc(observed)+'.</p>';}";
  html = html.replace('function contentChapter(p)', snapshotNote + '\nfunction contentChapter(p)');
  html = html.replace("${posts.length?`<div class=\"table-wrap\"><table class=\"post-table\">", "${postSnapshotNote(posts)}${posts.length?`<div class=\"table-wrap\"><table class=\"post-table\">");
  html = html.replace('<span class="post-tags"><span class="post-tag">${esc(x.format)}</span>', '<span class="post-tags"><span class="post-tag">Published ${esc(x.publishedAt)}</span><span class="post-tag">${esc(x.format)}</span>');
  html=html.replace('<td><span class="rank-num">${i+1}</span><span class="post-name">${esc(x.caption)}</span>', '<td><div class="post-summary"><span class="rank-num">${i+1}</span><span class="post-name" title="${esc(x.caption)}">${esc(x.caption)}</span>');
  html=html.replace('</span></td>${columns.map(key=>colourCell(x,key))', '</span></div></td>${columns.map(key=>colourCell(x,key))');
  html=html.replace('</style>', '\n.post-table{table-layout:fixed;width:100%}.post-table td{white-space:nowrap}.post-summary{display:flex;align-items:center;min-width:0}.post-summary .rank-num{flex:none}.post-table .post-name{display:block;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.post-table .post-tags{flex:none;max-width:48%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.posting-times h3{margin-bottom:8px}.posting-times h3:not(:first-child){margin-top:14px}.posting-times .activity-list>div{padding:5px 0;font-size:9px;gap:8px}\n</style>');

  // Share the dashboard's exact threshold implementation (including the low/high boundary rules).
  const bandScript = 'const dashboardBandOf=' + bandOf.toString() + ';const dashboardMedian=' + median.toString() + ';' +
    "function configuredBand(x,key,p,all){const metric=key==='interactions'?'engagement':key;const rule=p.bandRules?.[metric];const value=key==='engagementRate'&&numeric(x[key])?x[key]*100:x[key];const peers=all.map(v=>key==='engagementRate'&&numeric(v[key])?v[key]*100:v[key]);const band=dashboardBandOf(value,rule,{followers:p.followersByMonth?.[state.settings.endMonth]?.[x.accountId]??null,median:dashboardMedian(peers)});return {low:'weak',medium:'moderate',high:'strong'}[band]||''}";
  html = html.replace('function relativeBand(value,values)', bandScript + '\nfunction relativeBand(value,values)');
  html = html.replace('const band=relativeBand(x[key],peers);', 'const band=p.bandRules?configuredBand(x,key,p,all):relativeBand(x[key],peers);');
  html = html.replace("const score=x=>state.settings.rank==='engagementRate'?ratio(x.interactions,x.reach):x[state.settings.rank];return [...latest.values()].map(x=>({...x,engagementRate:ratio(x.interactions,x.reach)}))", "const postRate=x=>ratio(x.interactions,p.engagementBasis==='followers'?p.followersByMonth?.[state.settings.endMonth]?.[x.accountId]:p.engagementBasis==='views'?x.views:x.reach);const score=x=>state.settings.rank==='engagementRate'?postRate(x):x[state.settings.rank];return [...latest.values()].map(x=>({...x,engagementRate:postRate(x)}))");
  html = html.replace('ER by reach</th>', "ER by ${esc(p.engagementBasis||'reach')}</th>");
  html = html.replace('esc(rankNames[state.settings.rank])', "esc(state.settings.rank==='engagementRate'?'engagement rate by '+(p.engagementBasis||'reach'):rankNames[state.settings.rank])");
  html = html.replace('Post ER = interactions / reach.', 'Post ER uses the platform’s dashboard basis (followers, views or reach).');
  html = html.replace('At or above the 75th percentile.', 'At or above the configured high limit.').replace('Between the 25th and 75th percentiles.', 'At or above the low limit and below the high limit.').replace('At or below the 25th percentile.', 'Below the configured low limit.');
  html = html.replace('Table shades compare each metric with all eligible posts on the same platform in the selected period, including posts outside a top-ten selection. They describe relative results, not industry benchmarks. Non-follower shares are compared only when their basis matches. No shading when fewer than four values are available or both quartiles are equal.', 'Table shades use the platform rules saved in the dashboard at download time. Absolute limits use counts or engagement-rate percentages; follower limits use the post account’s followers at period end; median limits use all eligible posts for that platform, including posts outside the top ten. A disabled rule, missing value or unavailable denominator has no shading. Saves and non-follower share have no configured rule.');
  const ruleRows = "...selectedPlatforms().filter(p=>p.bandRules).map(p=>[p.name+' colour bands',Object.entries(p.bandRules).filter(([,r])=>r.mode!=='off').map(([metric,r])=>metric+': low < '+r.low+'; high ≥ '+r.high+' ('+(r.mode==='absolute'?(metric==='engagementRate'?'percentage points':'count'):r.mode==='followers'?'% of account followers':'% of platform median')+')').join('; ')||'All shading disabled.']),";
  html = html.replace("rows=[['Comparison windows'", "rows=[" + ruleRows + "['Comparison windows'");
  html = html.replace("'<option value=\"all\">All platforms</option>'+c.data.platforms.map", "'<option value=\"all\">All platforms</option>'+c.data.platforms.filter(p=>!s.includedPlatforms||s.includedPlatforms.includes(p.id)).map");
  html = html.replace("if(next.platform!=='all'&&!company().data.platforms.some(p=>p.id===next.platform))throw Error('Unknown platform');", "if(next.platform!=='all'&&(!company().data.platforms.some(p=>p.id===next.platform)||(next.includedPlatforms&&!next.includedPlatforms.includes(next.platform))))throw Error('Platform is not included in the report');");
  return html;
}
