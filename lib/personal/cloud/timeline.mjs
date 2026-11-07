// Shared metadata validation only. No media decoding, encoding or processing.
export const CLOUD_LIMITS = Object.freeze({ objectBytes: 20 * 1024 * 1024, imageBytes: 10 * 1024 * 1024, manifestBytes: 128 * 1024, clips: 8, duration: 120 });
export const RENDER_STATES = Object.freeze(['draft', 'uploading', 'queued', 'rendering', 'completed', 'failed', 'cancelled']);
export const RENDER_LABELS = { draft: 'Taslak', uploading: 'Yükleniyor', queued: 'Sırada', rendering: 'Bulutta işleniyor', completed: 'Tamamlandı', failed: 'Başarısız', cancelled: 'İptal edildi' };
export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = () => { throw new Error('Zaman çizelgesi veya dosya bilgisi geçersiz.'); };
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
}
function number(value, min, max) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(); return value; }
function reference(value, optional = false) { if (optional && value === '') return ''; if (!isUuid(value)) fail(); return value; }
export function validateTimeline(input, { forRender = false } = {}) {
  keys(input, ['schemaVersion','title','characterId','clips','audio','output']);
  if (input.schemaVersion !== 1 || typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > 100) fail();
  if (!Array.isArray(input.clips) || input.clips.length > CLOUD_LIMITS.clips || (forRender && input.clips.length < 2)) fail();
  const seen = new Set();
  const clips = input.clips.map(clip => {
    keys(clip, ['id','assetId','sceneId','trimStart','trimEnd','fit','volume','mute']);
    if (seen.has(clip.id) || !['pad','crop'].includes(clip.fit) || typeof clip.mute !== 'boolean') fail();
    seen.add(clip.id);
    const trimStart = number(clip.trimStart, 0, 600), trimEnd = number(clip.trimEnd, 0, 600);
    if (trimEnd <= trimStart) fail();
    return { id: reference(clip.id), assetId: reference(clip.assetId), sceneId: reference(clip.sceneId, true), trimStart, trimEnd, fit: clip.fit, volume: number(clip.volume,0,2), mute: clip.mute };
  });
  if (clips.reduce((sum,clip) => sum+clip.trimEnd-clip.trimStart,0) > CLOUD_LIMITS.duration) fail();
  let audio = null;
  if (input.audio !== null) {
    keys(input.audio, ['assetId','offset','trimStart','volume']);
    audio = { assetId: reference(input.audio.assetId), offset: number(input.audio.offset,0,120), trimStart: number(input.audio.trimStart,0,600), volume: number(input.audio.volume,0,2) };
  }
  if (!['preview','720p'].includes(input.output)) fail();
  return { schemaVersion: 1, title: input.title.trim(), characterId: reference(input.characterId,true), clips, audio, output: input.output };
}
export function validateCloudAsset(input) {
  keys(input, ['localId','kind','mime','size']);
  const types = { video: ['video/mp4'], audio: ['audio/mpeg','audio/wav','audio/x-wav','audio/mp4','audio/x-m4a'], image: ['image/png','image/jpeg','image/webp'], manifest: ['application/json'] };
  if (!types[input.kind]?.includes(input.mime) || !Number.isSafeInteger(input.size) || input.size <= 0) fail();
  const max = input.kind === 'image' ? CLOUD_LIMITS.imageBytes : input.kind === 'manifest' ? CLOUD_LIMITS.manifestBytes : CLOUD_LIMITS.objectBytes;
  if (input.size > max) throw new Error(`Bulut dosya sınırı: ${max/1024/1024} MB. Dosya küçültme yalnızca bulutta yapılabilir.`);
  return { localId: reference(input.localId), kind: input.kind, mime: input.mime, size: input.size };
}
export function newTimeline() { return { schemaVersion: 1, title: 'Yeni Short', characterId: '', clips: [], audio: null, output: 'preview' }; }
export function moveClip(clips, index, direction) {
  const next = [...clips], target = index+direction;
  if (index < 0 || index >= clips.length || target < 0 || target >= clips.length) return next;
  [next[index], next[target]] = [next[target], next[index]]; return next;
}
