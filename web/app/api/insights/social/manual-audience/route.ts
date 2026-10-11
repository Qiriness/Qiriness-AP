import {NextResponse} from 'next/server';
import {checkAudienceEntries,validAudienceDate,AUDIENCE_DIMENSIONS} from '../../../../../../scripts/lib/social-audience-manual.mjs';
import {audienceWriteContext,saveManualAudience} from '@/lib/server/social-audience-manual-service';
import type {OrganicKind,AudienceDimension} from '@/lib/social-types';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store'};
export async function PUT(request:Request) {
  try {
    const {shopId,asOf}=await audienceWriteContext();
    const body=await request.json().catch(()=>({}));
    if(!['instagram','facebook','tiktok'].includes(body.kind)||!AUDIENCE_DIMENSIONS.includes(body.dimension))return NextResponse.json({error:'Choose an organic platform and audience graph'},{status:400,headers});
    const checked=body.entries===null?{ok:true as const,entries:null}:checkAudienceEntries(body.dimension,body.entries);
    if(!checked.ok)return NextResponse.json({error:checked.error},{status:400,headers});
    if(checked.entries!==null&&!validAudienceDate(body.capturedOn,asOf))return NextResponse.json({error:'Choose a valid date on or before today'},{status:400,headers});
    if(!await saveManualAudience(shopId,body.kind as OrganicKind,body.dimension as AudienceDimension,body.capturedOn??asOf,checked.entries))return NextResponse.json({error:'No connected account for this platform'},{status:404,headers});
    return NextResponse.json({ok:true},{headers});
  } catch(error) {return NextResponse.json({error:'Could not save this audience data'},{status:500,headers});}
}
