import { cloudConfig } from '@/lib/server/cloud/config.mjs';
import { createCloudStore } from '@/lib/server/cloud/supabase.mjs';
import { renderConfig } from '@/lib/server/cloud/renderConfig.mjs';
import { verifyWorker } from '@/lib/server/cloud/workerAuth.mjs';
import { workerAction } from '@/lib/server/cloud/workerService.mjs';
export const runtime='nodejs';
export const maxDuration=30;
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
export async function POST(request) {
  const secret=process.env.STUDIO_RENDER_WORKER_SECRET;
  if(!secret||secret.length<32) return json({error:'WORKER_AUTH_REQUIRED'},401);
  try {
    if(!request.body||request.headers.get('content-type')!=='application/json') return json({error:'INVALID_REQUEST'},400);
    const reader=request.body.getReader(),chunks=[];let size=0;
    try {
      while(true) { const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){await reader.cancel();return json({error:'REQUEST_LIMIT'},413);}chunks.push(value); }
    } finally {reader.releaseLock();}
    const body=await new Blob(chunks).text();
    if(!verifyWorker(body,request.headers,secret)) return json({error:'WORKER_AUTH_REQUIRED'},401);
    const config=cloudConfig();if(!config) return json({error:'STORAGE_UNAVAILABLE'},503);
    const result=await workerAction(JSON.parse(body),request.headers.get('x-studio-nonce'),createCloudStore(config),{enabled:!!renderConfig()});
    return json(result);
  } catch {return json({error:'WORKER_EVENT_REJECTED'},409);}
}
