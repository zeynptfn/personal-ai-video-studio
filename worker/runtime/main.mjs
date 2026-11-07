import { randomUUID } from 'node:crypto';
import { mkdtemp,open,rm,stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isUuid } from '../../lib/personal/cloud/timeline.mjs';
import { signWorker } from '../../lib/server/cloud/workerAuth.mjs';
import { encodeTimeline } from './ffmpeg.mjs';

export async function runWorker(env=process.env,{fetchImpl=fetch}={}) {
  // Presence of a local FFmpeg install never activates this production entry point.
  if(env.STUDIO_WORKER_EXECUTION_ENABLED!=='true'||!/^studio-[a-z0-9-]+$/.test(env.CLOUD_RUN_JOB||'')
    ||!new RegExp(`^${env.CLOUD_RUN_JOB}-[a-z0-9-]+$`).test(env.CLOUD_RUN_EXECUTION||'')
    ||env.CLOUD_RUN_TASK_INDEX!=='0'||env.CLOUD_RUN_TASK_COUNT!=='1'||env.CLOUD_RUN_TASK_ATTEMPT!=='0')throw new Error('CLOUD_EXECUTION_NOT_APPROVED');
  const origin=new URL(env.STUDIO_COORDINATOR_ORIGIN||'');
  if(origin.protocol!=='https:'||!origin.hostname.endsWith('.vercel.app')||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||origin.port)throw new Error('COORDINATOR_INVALID');
  if((env.STUDIO_RENDER_WORKER_SECRET||'').length<32||!isUuid(env.STUDIO_RENDER_JOB_ID)||!isUuid(env.STUDIO_RENDER_DISPATCH_ID)||!/^[a-z0-9]{20}$/.test(env.STUDIO_STORAGE_PROJECT_REF||''))throw new Error('WORKER_CONFIG_INVALID');
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),600000);
  const interrupt=()=>controller.abort();process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
  let directory,lease,heartbeat,heartbeatTask=Promise.resolve(),progress=0,phase='downloading',job;
  async function event(action,extra={},terminal=false) {
    const body=JSON.stringify({action,jobId:env.STUDIO_RENDER_JOB_ID,lease,...extra});
    const response=await fetchImpl(`${origin.origin}/api/personal/cloud/worker`,{method:'POST',headers:{'Content-Type':'application/json',...signWorker(body,env.STUDIO_RENDER_WORKER_SECRET,{nonce:randomUUID()})},body,cache:'no-store',redirect:'error',signal:terminal?AbortSignal.timeout(6000):AbortSignal.any([controller.signal,AbortSignal.timeout(6000)])});
    if(!response.ok)throw new Error('COORDINATOR_REJECTED');return response.json();
  }
  function storageUrl(value) {
    const url=new URL(value);
    if(url.protocol!=='https:'||url.hostname!==`${env.STUDIO_STORAGE_PROJECT_REF}.storage.supabase.co`||url.username||url.password||url.port)throw new Error('STORAGE_ORIGIN_INVALID');
    return url.href;
  }
  async function beat() {
    const result=await event('heartbeat',{progress,phase});if(result.cancel)controller.abort();
  }
  try {
    job=await event('claim',{dispatchId:env.STUDIO_RENDER_DISPATCH_ID,execution:env.CLOUD_RUN_EXECUTION});lease=job.lease;
    if(!isUuid(lease))throw new Error('LEASE_INVALID');
    heartbeat=setInterval(()=>{heartbeatTask=heartbeatTask.then(beat).catch(()=>controller.abort());},10000);
    directory=await mkdtemp(join(tmpdir(),'studio-render-'));
    const {assets}=await event('inputs');
    if(!Array.isArray(assets)||assets.length<2||assets.length>9)throw new Error('INPUT_LIMIT');
    const files=new Map();let total=0;
    for(const asset of assets) {
      if(!isUuid(asset.id)||asset.owner_id!==job.ownerId||asset.project_id!==job.projectId||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>20*1024*1024)throw new Error('INPUT_OWNERSHIP_OR_LIMIT');
      const {ticket}=await event('input',{assetId:asset.id});
      const response=await fetchImpl(storageUrl(ticket.url),{redirect:'error',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
      if(!response.ok||!response.body||Number(response.headers.get('content-length'))!==asset.size)throw new Error('INPUT_DOWNLOAD_FAILED');
      const path=join(directory,`input-${files.size}.media`),handle=await open(path,'wx',0o600);let bytes=0;
      try {for await(const chunk of response.body){bytes+=chunk.length;total+=chunk.length;if(bytes>asset.size||total>180*1024*1024){await response.body.cancel().catch(()=>{});throw new Error('INPUT_SIZE_LIMIT');}await handle.writeFile(chunk);}}
      finally {await handle.close();}
      if(bytes!==asset.size)throw new Error('INPUT_TRUNCATED');files.set(asset.id,path);
    }
    phase='encoding';await beat();
    const output=join(directory,'output.mp4');
    const report=await encodeTimeline(job.manifest,assets,files,output,{ownerId:job.ownerId,projectId:job.projectId,signal:controller.signal,onProgress:value=>{progress=value;}});
    phase='uploading';await beat();
    if((await stat(output)).size!==report.size)throw new Error('OUTPUT_CHANGED');
    const {ticket}=await event('output',{size:report.size});
    const uploaded=await fetchImpl(storageUrl(ticket.url),{method:'PUT',headers:{...ticket.headers,'Content-Length':String(report.size)},body:createReadStream(output),duplex:'half',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
    if(!uploaded.ok)throw new Error('OUTPUT_UPLOAD_FAILED');
    phase='verifying';await beat();await heartbeatTask;clearInterval(heartbeat);
    await event('complete',{report});
    return {jobId:env.STUDIO_RENDER_JOB_ID,completed:true};
  } catch(error) {
    controller.abort();
    if(lease){try{await event('failed',{},true);}catch{/* Lease/deadline reconciliation handles unacknowledged failure. */}}
    throw new Error(error.message==='CLOUD_EXECUTION_NOT_APPROVED'?error.message:'RENDER_WORKER_FAILED');
  } finally {
    clearInterval(heartbeat);clearTimeout(deadline);process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt);
    if(directory)await rm(directory,{recursive:true,force:true});
  }
}
if(import.meta.url===new URL(process.argv[1]||'',`file://${process.cwd()}/`).href) {
  runWorker().then(()=>{process.stdout.write('RENDER_COMPLETED\n');}).catch(()=>{process.stderr.write('RENDER_WORKER_FAILED\n');process.exitCode=1;});
}
