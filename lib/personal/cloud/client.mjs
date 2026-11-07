// Browser coordination and ordinary uploads only. No service keys or processing.
export async function cloudRequest(data) {
  const response = await fetch('/api/personal/cloud', {
    method: data ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Bulut bağlantısı kurulamadı.');
  return result;
}
export async function uploadPrivateFile(projectId, localId, blob, kind) {
  const { validateCloudAsset } = await import('./timeline.mjs');
  const metadata = validateCloudAsset({ localId, size: blob.size, mime: blob.type, kind });
  const { asset, ticket } = await cloudRequest({ action: 'upload', projectId, asset: metadata });
  const url = new URL(ticket.url);
  if (url.protocol !== 'https:' || !/^[a-z0-9]{20}\.storage\.supabase\.co$/.test(url.hostname) || ticket.method !== 'PUT') throw new Error('Güvenli yükleme adresi doğrulanamadı.');
  const response = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: blob, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(240000) });
  if (!response.ok) throw new Error('Özel depolamaya yükleme başarısız. Dosya otomatik tekrar gönderilmez.');
  await cloudRequest({ action: 'complete', id: asset.id });
  return asset.id;
}
