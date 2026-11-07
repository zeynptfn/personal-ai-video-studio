import { isUuid, validateTimeline, validateCloudAsset } from '../../personal/cloud/timeline.mjs';
import { RENDER_BLOCK } from './config.mjs';
export class CloudError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export async function cloudAction(data, store) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CloudError('Geçersiz bulut isteği.');
  if (data.action === 'render') throw new CloudError(RENDER_BLOCK, 409);
  if (!store) throw new CloudError('Özel ücretsiz bulut depolaması henüz yapılandırılmadı. Yerel taslağınız korunur.', 503);
  if (data.action === 'save') {
    if (!isUuid(data.id) || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new CloudError('Proje veya sürüm geçersiz.');
    const manifest = validateTimeline(data.manifest);
    return { project: await store.rpc('save', { id: data.id, revision: data.revision, manifest }) };
  }
  if (data.action === 'upload') {
    if (!isUuid(data.projectId)) throw new CloudError('Proje geçersiz.');
    const metadata = validateCloudAsset(data.asset);
    const asset = await store.rpc('reserve', { projectId: data.projectId, ...metadata });
    return { asset, ticket: await store.uploadTicket(asset) };
  }
  if (['complete','read'].includes(data.action)) {
    if (!isUuid(data.id)) throw new CloudError('Dosya geçersiz.');
    if (data.action === 'complete') {
      const asset = await store.rpc('asset', { id: data.id });
      await store.verifyUpload(asset);
      return { asset: await store.rpc('complete', { id: data.id }) };
    }
    const asset = await store.rpc('read', { id: data.id });
    return { ticket: await store.readTicket(asset) };
  }
  throw new CloudError('İşlem desteklenmiyor.');
}
