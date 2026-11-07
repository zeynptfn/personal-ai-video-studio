// Pure metadata plan, without processes or network access.
// The separate runtime enforces approved cloud execution before running FFmpeg.
import { validateTimeline, isUuid } from '../lib/personal/cloud/timeline.mjs';
const fail = () => { throw new Error('Cloud FFprobe sonuçları veya dosya sahipliği doğrulanamadı.'); };
export function planCloudRender(input, metadata, { ownerId, projectId } = {}) {
  if (!isUuid(ownerId) || !isUuid(projectId) || !Array.isArray(metadata) || metadata.length > 100) fail();
  const timeline = validateTimeline(input, { forRender: true });
  const totalDuration = timeline.clips.reduce((sum,clip) => sum+clip.trimEnd-clip.trimStart,0);
  function media(localId,kind) {
    const asset = metadata.find(item => item.localId === localId && item.kind === kind);
    if (!asset || !isUuid(asset.id) || asset.ownerId !== ownerId || asset.projectId !== projectId || asset.state !== 'ready'
      || !Number.isFinite(asset.duration) || asset.duration <= 0 || asset.duration > 600
      || !Number.isFinite(asset.size) || asset.size <= 0 || asset.size > 20*1024*1024) fail();
    return asset;
  }
  const [width,height] = timeline.output === '720p' ? [720,1280] : [360,640];
  const clips = timeline.clips.map((clip,index) => {
    const source = media(clip.assetId,'video');
    if (!Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 16 || source.height < 16
      || source.width > 4096 || source.height > 4096 || !Number.isFinite(source.fps) || source.fps <= 0 || source.fps > 60
      || typeof source.hasAudio !== 'boolean' || clip.trimEnd > source.duration+0.001) fail();
    return { assetId: source.id, localFile: `clip-${index}.mp4`, trim: [clip.trimStart,clip.trimEnd], resetTimestamps: true,
      video: { width,height,fps:24,pixelFormat:'yuv420p',fit:clip.fit },
      audio: { synthesizeSilence: !source.hasAudio, mute:clip.mute,volume:clip.volume,sampleRate:48000,channels:2 } };
  });
  let voice = null;
  if (timeline.audio) {
    const source = media(timeline.audio.assetId,'audio');
    if (timeline.audio.trimStart >= source.duration || timeline.audio.offset >= totalDuration) fail();
    voice = { assetId:source.id,localFile:'voice.audio',trimStart:timeline.audio.trimStart,offset:timeline.audio.offset,volume:timeline.audio.volume,
      trimToTimeline:true,padToTimeline:true,sampleRate:48000,channels:2 };
  }
  return { executable:false,reason:'PLAN_ONLY',clips,voice,concatOrder:clips.map(clip=>clip.assetId),
    output:{filename:'output.mp4',width,height,duration:totalDuration,videoCodec:'libx264',audioCodec:'aac',fps:24,faststart:true,maxBytes:20*1024*1024},
    sandbox:{concurrency:1,threads:2,wallSeconds:600,tempBytes:256*1024*1024,protocols:['file','pipe'],networkDuringEncoding:false} };
}
