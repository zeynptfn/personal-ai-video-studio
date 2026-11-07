import { isUuid } from '../../personal/cloud/timeline.mjs';
export const RENDER_BLOCK = 'Ücretsiz ve ücretlendirmeye kapalı bir bulut worker henüz doğrulanmadı. Render gönderilmedi.';
export function cloudConfig(env = process.env) {
  // No arbitrary endpoints, localhost, AWS, URLs from clients, or automatic provisioning.
  if (env.STUDIO_CLOUD_STORAGE_ENABLED !== 'true') return null;
  if (!/^[a-z0-9]{20}$/.test(env.SUPABASE_PROJECT_REF || '') || !isUuid(env.STUDIO_CLOUD_OWNER_ID)
    || !/^[a-z0-9-]{3,32}$/.test(env.SUPABASE_STORAGE_REGION || '')
    || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_S3_ACCESS_KEY_ID || !env.SUPABASE_S3_SECRET_ACCESS_KEY) return null;
  return {
    ref: env.SUPABASE_PROJECT_REF, owner: env.STUDIO_CLOUD_OWNER_ID,
    url: `https://${env.SUPABASE_PROJECT_REF}.supabase.co`,
    s3: `https://${env.SUPABASE_PROJECT_REF}.storage.supabase.co/storage/v1/s3`,
    region: env.SUPABASE_STORAGE_REGION, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    accessKeyId: env.SUPABASE_S3_ACCESS_KEY_ID, secretAccessKey: env.SUPABASE_S3_SECRET_ACCESS_KEY,
  };
}
