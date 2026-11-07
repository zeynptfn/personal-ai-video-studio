export const RENDER_DISABLED = 'Cloud Run render kapalı. Kullanıcı maliyet onayı, özel worker ve sunucu kurulumu gerekli; ücretsiz çalışma garantisi verilmez.';
export function renderConfig(env = process.env, now = Date.now()) {
  const expires = Date.parse(env.STUDIO_RENDER_COST_APPROVAL_EXPIRES_AT || '');
  if (env.STUDIO_CLOUD_RENDER_ENABLED !== 'true' || !Number.isFinite(expires) || expires <= now || expires > now+24*60*60*1000
    || (env.STUDIO_RENDER_WORKER_SECRET || '').length < 32) return null;
  const project = env.GCP_RENDER_PROJECT_ID, region = env.GCP_RENDER_REGION, job = env.GCP_RENDER_JOB;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project || '') || !/^[a-z]+-[a-z]+\d$/.test(region || '') || !/^studio-[a-z0-9-]{1,50}[a-z0-9]$/.test(job || '')) return null;
  if (!/^\d{6,20}$/.test(env.GCP_RENDER_PROJECT_NUMBER || '') || !/^[a-z][a-z0-9-]{2,30}$/.test(env.GCP_RENDER_WIF_POOL || '') || !/^[a-z][a-z0-9-]{2,30}$/.test(env.GCP_RENDER_WIF_PROVIDER || '')
    || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.GCP_RENDER_INVOKER_NAME || '')) return null;
  return { project, region, job, resource:`projects/${project}/locations/${region}/jobs/${job}`,
    audience:`//iam.googleapis.com/projects/${env.GCP_RENDER_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${env.GCP_RENDER_WIF_POOL}/providers/${env.GCP_RENDER_WIF_PROVIDER}`,
    serviceAccount:`${env.GCP_RENDER_INVOKER_NAME}@${project}.iam.gserviceaccount.com` };
}
