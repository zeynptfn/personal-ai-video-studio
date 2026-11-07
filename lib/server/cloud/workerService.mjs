import { randomUUID } from 'node:crypto';
import { isUuid } from '../../personal/cloud/timeline.mjs';
import { checkOutput } from '../../../worker/output.mjs';
export async function workerAction(data,nonce,store,{enabled=false}={}) {
  const allowed=['claim','heartbeat','inputs','input','output','complete','failed','cancelled'];
  if(!data||!allowed.includes(data.action)||!isUuid(data.jobId)||!isUuid(nonce)) throw new Error('INVALID_WORKER_EVENT');
  if(data.action!=='claim'&&!isUuid(data.lease)) throw new Error('INVALID_LEASE');
  if(!enabled&&!['heartbeat','failed','cancelled'].includes(data.action)) throw new Error('RENDER_DISABLED');
  const payload={jobId:data.jobId,nonce,lease:data.lease};
  if(data.action==='claim') {
    if(!isUuid(data.dispatchId)||!/^studio-[a-z0-9-]{1,100}$/.test(data.execution||'')) throw new Error('INVALID_EXECUTION');
    return store.renderRpc('claim',{...payload,dispatchId:data.dispatchId,execution:data.execution});
  }
  if(data.action==='inputs') return store.renderRpc('inputs',payload);
  if(data.action==='input') {
    if(!isUuid(data.assetId)) throw new Error('INVALID_ASSET');
    const asset=await store.renderRpc('input',{...payload,assetId:data.assetId});
    return {ticket:await store.readTicket(asset)};
  }
  if(data.action==='heartbeat') {
    if(typeof data.progress!=='number'||!Number.isFinite(data.progress)||data.progress<0||data.progress>1||!['downloading','encoding','uploading','verifying'].includes(data.phase)) throw new Error('INVALID_PROGRESS');
    Object.assign(payload,{progress:data.progress,phase:data.phase});
  }
  if(data.action==='output') {
    if(!Number.isSafeInteger(data.size)||data.size<1||data.size>20*1024*1024) throw new Error('OUTPUT_LIMIT');
    const asset=await store.renderRpc('output',{...payload,size:data.size});
    return {ticket:await store.uploadTicket(asset)};
  }
  if(data.action==='complete') {
    const result=await store.renderRpc('output-info',payload);
    const report=checkOutput(data.report,result.manifest);
    if(report.size!==result.asset.size) throw new Error('OUTPUT_SIZE_MISMATCH');
    await store.verifyUpload(result.asset);
    return store.renderRpc('complete',{...payload,nonce:randomUUID()});
  }
  const result=await store.renderRpc(data.action,payload);
  return data.action==='heartbeat'?{...result,cancel:result.cancel||!enabled}:result;
}
