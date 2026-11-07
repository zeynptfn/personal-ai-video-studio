import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { planCloudRender } from '../render-contract.mjs';
import { checkOutput } from '../output.mjs';

export function command(binary,args,{signal,timeout=60000,onProgress}={}) {
  if(!['ffmpeg','ffprobe'].includes(binary)) throw new Error('BINARY_NOT_ALLOWED');
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{shell:false,env:process.platform==='win32'?{PATH:process.env.PATH||process.env.Path||'',SystemRoot:process.env.SystemRoot||process.env.SYSTEMROOT||'C:\\Windows',LANG:'C'}:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','pipe']});
    let stdout='',progressBuffer='',settled=false;
    const stop=()=>child.kill('SIGKILL');
    const timer=setTimeout(stop,timeout);signal?.addEventListener('abort',stop,{once:true});
    if(signal?.aborted)stop();
    child.stdout.on('data',chunk=>{
      if(onProgress) {progressBuffer+=chunk.toString();const lines=progressBuffer.split('\n');progressBuffer=lines.pop();for(const line of lines){const match=/^out_time_us=(\d+)$/.exec(line);if(match)onProgress(Number(match[1])/1e6);}}
      else {stdout+=chunk.toString();if(stdout.length>1024*1024)stop();}
    });
    // Never store/echo FFmpeg stderr: media metadata can contain arbitrary text.
    child.stderr.resume();
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);if(error)reject(error);else resolve(stdout);};
    child.once('error',()=>finish(new Error('MEDIA_PROCESS_START_FAILED')));
    child.once('close',code=>finish(code===0&&!signal?.aborted?null:new Error(signal?.aborted?'MEDIA_PROCESS_ABORTED':'MEDIA_PROCESS_FAILED')));
  });
}
export async function probe(file,{signal}={}) {
  const size=(await stat(file)).size;
  if(size<1||size>20*1024*1024)throw new Error('MEDIA_SIZE_LIMIT');
  const raw=await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,mp4,m4a,3gp,3g2,mj2,mp3,wav',
    '-show_entries','format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,channels,sample_rate','-of','json',file],{signal,timeout:15000});
  const parsed=JSON.parse(raw),video=parsed.streams?.find(stream=>stream.codec_type==='video'),audio=parsed.streams?.find(stream=>stream.codec_type==='audio');
  const parts=video?.avg_frame_rate?.split('/').map(Number);
  if(!parsed.format?.format_name||!Number.isFinite(Number(parsed.format.duration))||Number(parsed.format.duration)<=0||Number(parsed.format.duration)>600||(!video&&!audio)||parsed.streams.length>4)throw new Error('MEDIA_PROBE_INVALID');
  if(audio&&(!Number.isFinite(Number(audio.sample_rate))||Number(audio.sample_rate)>96000||audio.channels<1||audio.channels>8))throw new Error('AUDIO_LIMIT');
  return {size,duration:Number(parsed.format.duration),width:video?.width,height:video?.height,fps:parts?parts[0]/parts[1]:undefined,hasAudio:!!audio,videoCodec:video?.codec_name,audioCodec:audio?.codec_name};
}
export function encodingArgs(plan,files,output) {
  const args=['-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex_threads','1'];
  plan.clips.forEach(clip=>args.push('-threads','1','-protocol_whitelist','file,pipe','-format_whitelist','mov,mp4,m4a,3gp,3g2,mj2','-enable_drefs','0','-use_absolute_path','0','-i',files.get(clip.assetId)));
  if(plan.voice)args.push('-threads','1','-protocol_whitelist','file,pipe','-format_whitelist','mov,mp4,m4a,3gp,3g2,mj2,mp3,wav','-i',files.get(plan.voice.assetId));
  const filters=[];
  plan.clips.forEach((clip,i)=>{
    const [start,end]=clip.trim,duration=end-start,{width,height,fit}=clip.video;
    const scale=fit==='pad'?`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`:`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    filters.push(`[${i}:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,${scale},setsar=1,fps=24,format=yuv420p[v${i}]`);
    const source=clip.audio.synthesizeSilence?`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}`:`[${i}:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`;
    filters.push(`${source},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.audio.mute?0:clip.audio.volume},apad=whole_dur=${duration},asetpts=PTS-STARTPTS[a${i}]`);
  });
  filters.push(`${plan.clips.map((_,i)=>`[v${i}][a${i}]`).join('')}concat=n=${plan.clips.length}:v=1:a=1[vout][base]`);
  if(plan.voice){const voice=plan.voice;filters.push(`[${plan.clips.length}:a:0]atrim=start=${voice.trimStart},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${voice.volume},adelay=${Math.round(voice.offset*1000)}:all=1,apad=whole_dur=${plan.output.duration}[voice]`);filters.push('[base][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:latency=1[aout]');}
  args.push('-filter_complex',filters.join(';'),'-map','[vout]','-map',plan.voice?'[aout]':'[base]',
    '-map_metadata','-1','-map_chapters','-1','-c:v','libx264','-preset','veryfast','-crf','23','-maxrate',plan.output.width===720?'900k':'450k','-bufsize','1800k','-threads','2',
    '-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-ar','48000','-ac','2','-t',String(plan.output.duration),'-fs',String(plan.output.maxBytes),'-movflags','+faststart','-progress','pipe:1','-nostats',output);
  return args;
}
export async function encodeTimeline(manifest,assets,files,output,{ownerId,projectId,signal,onProgress}={}) {
  const metadata=[];
  for(const asset of assets)metadata.push({id:asset.id,localId:asset.local_id,ownerId:asset.owner_id,projectId:asset.project_id,state:asset.state,kind:asset.kind,...await probe(files.get(asset.id),{signal})});
  const plan=planCloudRender(manifest,metadata,{ownerId,projectId});
  // This executable lives only in the standalone worker/test process, never in a Next.js handler.
  await command('ffmpeg',encodingArgs(plan,files,output),{signal,timeout:540000,onProgress:seconds=>onProgress?.(Math.min(0.99,seconds/plan.output.duration))});
  return checkOutput(await probe(output,{signal}),manifest);
}
