import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkAudienceEntries,validAudienceDate,fillManualAudience,manualAudienceReport} from './social-audience-manual.mjs';
test('Audience entries validate unique categories, partial percentages and real observation dates',()=>{
 assert.deepEqual(checkAudienceEntries('gender',[{key:'female',value:'60,5%'},{key:'male',value:20}]),{ok:true,entries:[{key:'female',value:60.5},{key:'male',value:20}]});
 for(const entries of [[],[{key:'female',value:101}],[{key:'female',value:60},{key:'male',value:60}],[{key:'female',value:''}],[{key:'female',value:true}],[{key:'invalid',value:1}],[{key:'female',value:1},{key:'female',value:2}]])assert.equal(checkAudienceEntries('gender',entries).ok,false);
 assert.equal(checkAudienceEntries('city',[{key:'London',value:0}]).ok,true);
 assert.equal(checkAudienceEntries('country',[{key:'FR',value:50},{key:'fr',value:20}]).ok,false);
 assert.equal(checkAudienceEntries('unknown',[{key:'a',value:1}]).ok,false);
 assert.equal(validAudienceDate('2026-02-30','2026-10-11'),false);assert.equal(validAudienceDate('2026-10-12','2026-10-11'),false);assert.equal(validAudienceDate('2026-10-01','2026-10-11'),true);
});
test('Audience fills only missing dimensions without scaling partial shares or mixing platforms',()=>{
 const rows=[{dimension:'gender',captured_on:'2026-10-01',entries:[{key:'female',value:60}]},{dimension:'city',captured_on:'2026-10-12',entries:[{key:'London',value:30}]}];
 const result=fillManualAudience(null,rows,'2026-10-11');assert.equal(result.gender[0].share,60);assert.deepEqual(result.city,[]);assert.equal(result.dimensionMeta.gender.source,'manual');
 const native={gender:[{key:'male',value:0,share:0}],age:[],country:[],city:[],capturedOn:'2026-09-01'};
 assert.equal(fillManualAudience(native,rows,'2026-10-11').gender[0].key,'male');
 const report=manualAudienceReport([],[rows[0]],'2026-10-11').at(-1);assert.equal(report.gender[0].value,60);assert.deepEqual(report.manualDimensions,['gender']);assert.equal(report.dimensionDates.gender,'2026-10-01');
 const combined=manualAudienceReport([{asOf:'2026-10-02',countries:[{label:'France',value:100}],gender:[],age:[],cities:[]}],[rows[0]],'2026-10-11');assert.equal(combined.length,1);assert.equal(combined[0].gender[0].value,60);assert.equal(combined[0].dimensionDates.gender,'2026-10-01');assert.equal(combined[0].countries[0].value,100);
});
