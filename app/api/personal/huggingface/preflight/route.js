import { cookies } from 'next/headers';
import { accessConfigured, verifySession, SESSION_COOKIE } from '@/lib/personal/access.mjs';
import { inspectHfFreeQuota } from '@/lib/server/hfQuotaSafety.mjs';

export const runtime = 'nodejs';
export const maxDuration = 10;
const headers = { 'Cache-Control': 'private, no-store' };

async function authorized() {
  if (!accessConfigured()) return false;
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value, process.env.STUDIO_SESSION_SECRET);
}

export async function GET() {
  if (!await authorized()) return Response.json({ error: 'Özel stüdyo oturumu gerekli.' }, { status: 401, headers });
  const result = await inspectHfFreeQuota({ token: process.env.HF_TOKEN });
  return Response.json(result, { headers });
}

// Deliberately no authenticated upload/submission path. Even sufficient free
// quota cannot authorize a job until provider-side no-credit enforcement exists.
export async function POST() {
  if (!await authorized()) return Response.json({ error: 'Özel stüdyo oturumu gerekli.' }, { status: 401, headers });
  return Response.json({
    allowed: false, authenticatedGenerationEnabled: false,
    reason: 'ATOMIC_FREE_ONLY_ENFORCEMENT_UNVERIFIED',
    error: 'Sıfır ücret garantisi doğrulanmadığı için kimlikli üretim kapalı. Resmi Space ve manuel MP4 aktarımını kullanın.',
  }, { status: 409, headers });
}
