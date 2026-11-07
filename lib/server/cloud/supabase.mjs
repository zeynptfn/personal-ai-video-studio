import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const PRIVATE_BUCKET = 'studio-private';
export function createCloudStore(config, { fetchImpl = fetch } = {}) {
  const client = new S3Client({ endpoint: config.s3, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  async function rpc(action, payload = {}, procedure = 'studio_coordinate') {
    const response = await fetchImpl(`${config.url}/rest/v1/rpc/${procedure}`, {
      method: 'POST', headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, owner: config.owner, payload }), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      // Never propagate raw DB bodies, URLs or credential-bearing upstream errors.
      throw new Error('Bulut işlemi reddedildi. Özel kurulum, ücretsiz plan onayı, kota veya proje sürümü kontrol edilmeli.');
    }
    return response.json();
  }
  function objectPath(asset) {
    const expected = `${config.owner}/${asset.project_id}/${asset.id}`;
    if (asset.owner_id !== config.owner || asset.path !== expected) throw new Error('Dosya sahipliği doğrulanamadı.');
    return expected;
  }
  async function uploadTicket(asset) {
    const command = new PutObjectCommand({ Bucket: PRIVATE_BUCKET, Key: objectPath(asset), ContentType: asset.mime, ContentLength: asset.size, CacheControl: 'private, no-store' });
    const expiresIn = asset.upload_expires_at ? Math.min(300,Math.floor((Date.parse(asset.upload_expires_at)-Date.now())/1000)) : 300;
    if (!Number.isFinite(expiresIn) || expiresIn < 1) throw new Error('UPLOAD_EXPIRED');
    const url = await getSignedUrl(client, command, { expiresIn, signableHeaders: new Set(['content-type','content-length','cache-control']) });
    return { url, method: 'PUT', headers: { 'Content-Type': asset.mime, 'Cache-Control': 'private, no-store' }, expiresIn };
  }
  async function verifyUpload(asset) {
    const url = await getSignedUrl(client, new HeadObjectCommand({ Bucket: PRIVATE_BUCKET, Key: objectPath(asset) }), { expiresIn: 30 });
    const response = await fetchImpl(url, { method: 'HEAD', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (!response.ok || Number(response.headers.get('content-length')) !== asset.size || response.headers.get('content-type')?.split(';')[0] !== asset.mime) throw new Error('Yüklenen dosyanın boyutu veya türü doğrulanamadı.');
  }
  async function readTicket(asset) {
    return { url: await getSignedUrl(client, new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: objectPath(asset), ResponseContentDisposition: `attachment; filename="studio-${asset.id}.${asset.kind === 'video' ? 'mp4' : 'bin'}"` }), { expiresIn: 120 }), expiresIn: 120 };
  }
  return { rpc, renderRpc: (action,payload={}) => rpc(action,payload,'studio_render_coordinate'), uploadTicket, verifyUpload, readTicket };
}
