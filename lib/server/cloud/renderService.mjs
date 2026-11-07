import { isUuid,validateTimeline } from '../../personal/cloud/timeline.mjs';
import { CloudError } from './service.mjs';
import { RENDER_DISABLED } from './renderConfig.mjs';
export async function renderAction(data,store,config,provider) {
  if(!store) throw new CloudError(RENDER_DISABLED,409);
  if(data.action==='cancel-render') {
    if(!isUuid(data.jobId)) throw new CloudError('İş kimliği geçersiz.');
    const result=await store.renderRpc('cancel',{jobId:data.jobId});
    if(config&&result.execution) { try {await provider.cancel(result.execution);} catch { /* Persisted cancellation remains; heartbeat fails closed. */ } }
    return {cancelRequested:true,message:'İptal istendi. Worker durması doğrulanana kadar işlem sürebilir.'};
  }
  if(!config) throw new CloudError(RENDER_DISABLED,409);
  if(!isUuid(data.projectId)||!Number.isSafeInteger(data.revision)||data.revision<1) throw new CloudError('Önce bulut proje sürümünü kaydedin.');
  const state=await store.rpc('list');
  const project=state.projects.find(item=>item.id===data.projectId);
  if(!project||project.revision!==data.revision) throw new CloudError('Bulut projesi veya sürümü doğrulanamadı.',409);
  validateTimeline(project.manifest,{forRender:true});
  const dispatch=await store.renderRpc('enqueue',{projectId:data.projectId,revision:data.revision});
  try { await provider.start(dispatch.jobId,dispatch.dispatchId); }
  catch {
    try {await store.renderRpc('dispatch-failed',{jobId:dispatch.jobId});} catch { /* DB queue expires on the next status request. Never resubmit. */ }
    throw new CloudError('Cloud Run başlatma sonucu belirsiz. Otomatik tekrar yapılmadı; iş durumunu yenileyin.',502);
  }
  return {jobId:dispatch.jobId,message:'Cloud Run başlatma isteğini kabul etti. Gerçek iş durumu kalıcı kayıttan izlenir.'};
}
