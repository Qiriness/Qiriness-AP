import template from './social-report-template.mjs';
import { bandOf, median } from './social-bands.mjs';

const sections = [ ['cover', 'Cover'], ['overview', 'Executive overview'], ['performance', 'Platform performance'], ['audience', 'Audience insights'], ['content', 'Content performance'], ['strategy', 'Concluding summary'], ['method', 'Definitions & colour coding'] ];
export function socialReportState(data, { name, locale = 'en-GB', months = 1, endMonth, platforms }) {
  const includedPlatforms = platforms ?? data.platforms.map(p => p.id);
  if (![1, 6, 12].includes(months) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(endMonth) || !includedPlatforms.length || includedPlatforms.some(id => !data.platforms.some(p => p.id === id))) throw new Error('Invalid report context.');
  return { schemaVersion: 1, selectedCompany: data.companyId,
    settings: { months, endMonth, platform: 'all', includedPlatforms, erBasis: 'views', rank: 'views', postCount: 10 },
    companies: [{ id: data.companyId, brand: { name, coverHeadingPosition: 'right', tagline: 'Social media performance', author: 'Marketing team', ink: '#45281f', accent: '#6b8177', paper: '#faf8f0', tint: '#e7eadd', headingFont: 'Georgia', bodyFont: 'Arial', locale, currency: data.currency, logo: null, customHeading: null, customBody: null },
      data, drafts: {}, images: {}, sections: sections.map(([id, label]) => ({ id, label, visible: true })) }] };
}

/** Bind revision 6 without changing its styles, chapters, editing or pagination. */
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
