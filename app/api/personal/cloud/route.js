import { cookies } from 'next/headers';
import { accessConfigured, verifySession, SESSION_COOKIE } from '@/lib/personal/access.mjs';
import { cloudConfig } from '@/lib/server/cloud/config.mjs';
import { createCloudStore } from '@/lib/server/cloud/supabase.mjs';
import { cloudAction, CloudError } from '@/lib/server/cloud/service.mjs';
export const runtime = 'nodejs';
export const maxDuration = 30;
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200) => Response.json(data, { status, headers });
async function authorized() { return accessConfigured() && await verifySession((await cookies()).get(SESSION_COOKIE)?.value, process.env.STUDIO_SESSION_SECRET); }
export async function GET() {
  if (!await authorized()) return json({ error: 'Özel stüdyo oturumu gerekli.' }, 401);
  const config = cloudConfig();
  if (!config) return json({ storageReady: false, renderEnabled: false, projects: [], assets: [], jobs: [], reason: 'CLOUD_STORAGE_NOT_CONFIGURED' });
  try {
    const state = await createCloudStore(config).rpc('list');
    return json({ ...state, storageReady: true, renderEnabled: false, reason: 'FREE_WORKER_NOT_VERIFIED' });
  } catch { return json({ error: 'Bulut depolamasına erişilemiyor. Özel kurulum ve süresi dolan ücretsiz plan onayını kontrol edin.', storageReady: false, renderEnabled: false }, 503); }
}
export async function POST(request) {
  if (!await authorized()) return json({ error: 'Özel stüdyo oturumu gerekli.' }, 401);
  try {
    const origin = new URL(request.headers.get('origin'));
    if (!['http:','https:'].includes(origin.protocol) || origin.host !== request.headers.get('host')) return json({ error: 'İstek kaynağı geçersiz.' }, 403);
  } catch { return json({ error: 'İstek kaynağı geçersiz.' }, 403); }
  try {
    if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) throw new CloudError('Yalnızca JSON proje bilgisi kabul edilir.');
    const reader = request.body.getReader(); let size = 0; const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 32768) { await reader.cancel(); throw new CloudError('Proje bilgisi 32 KB sınırını aşıyor.', 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let data;
    try { data = JSON.parse(await new Blob(chunks).text()); } catch { throw new CloudError('Geçersiz JSON.'); }
    const config = cloudConfig();
    return json(await cloudAction(data, config ? createCloudStore(config) : null));
  } catch (error) {
    if (error instanceof CloudError) return json({ error: error.message, renderEnabled: false }, error.status);
    // Validation/upstream errors never expose server credentials or signed URLs.
    return json({ error: 'Bulut işlemi tamamlanamadı. Dosya sınırı, proje sürümü ve ücretsiz plan onayını kontrol edin.', renderEnabled: false }, 400);
  }
}
