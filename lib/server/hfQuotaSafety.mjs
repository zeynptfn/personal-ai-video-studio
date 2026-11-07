// Read-only safety assessment. No Gradio client, upload or generation endpoint.
export const QUOTA_ENDPOINT = 'https://huggingface.co/api/spaces/zero-gpu/quota';

export function assessFreeQuota(data, { now = Date.now(), duration = 2 } = {}) {
  const blocked = reason => ({ allowed: false, reason, authenticatedGenerationEnabled: false });
  // LTX currently requests 60s (75s above 7s) on xlarge, charged at 2x.
  // This is an estimate for preflight only, never permission to submit.
  if (!Number.isFinite(duration) || duration <= 0 || duration > 8.5) return blocked('INVALID_DURATION');
  const requiredGpuSeconds = duration > 7 ? 150 : 120;
  if (!data || !['base','current','overquotaUsed'].every(key => typeof data[key] === 'number' && Number.isFinite(data[key]))
    || data.base <= 0 || data.current > data.base || data.overquotaUsed < 0
    || !Object.hasOwn(data, 'resetsAt')) return blocked('QUOTA_UNVERIFIED');
  const reset = data.resetsAt === null ? null : typeof data.resetsAt === 'string' ? Date.parse(data.resetsAt) : NaN;
  if (reset !== null && (!Number.isFinite(reset) || reset <= now)) return blocked('QUOTA_UNVERIFIED');
  const quota = {
    baseGpuSeconds: data.base, remainingGpuSeconds: data.current,
    overquotaUsedGpuSeconds: data.overquotaUsed,
    resetsAt: reset === null ? null : new Date(reset).toISOString(), requiredGpuSeconds,
  };
  const reason = data.overquotaUsed > 0 ? 'PAID_OVERQUOTA_DETECTED'
    : data.current < requiredGpuSeconds ? 'INSUFFICIENT_FREE_QUOTA'
      : 'ATOMIC_FREE_ONLY_ENFORCEMENT_UNVERIFIED';
  return { ...blocked(reason), quota };
}

export async function inspectHfFreeQuota({ token, fetchImpl = fetch, signal, now } = {}) {
  if (typeof token !== 'string' || !token.trim()) return { allowed: false, reason: 'HF_TOKEN_NOT_CONFIGURED', authenticatedGenerationEnabled: false };
  try {
    const response = await fetchImpl(QUOTA_ENDPOINT, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      redirect: 'error', signal: signal || AbortSignal.timeout(6000),
    });
    if (!response.ok) return {
      allowed: false, authenticatedGenerationEnabled: false,
      reason: [401,403].includes(response.status) ? 'HF_AUTH_OR_BILLING_READ_SCOPE_REQUIRED' : 'QUOTA_UNAVAILABLE',
    };
    return assessFreeQuota(await response.json(), { now });
  } catch {
    // Never echo upstream bodies, error messages, request headers or the token.
    return { allowed: false, reason: 'QUOTA_UNAVAILABLE', authenticatedGenerationEnabled: false };
  }
}
