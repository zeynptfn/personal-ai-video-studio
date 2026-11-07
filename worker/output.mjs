import { validateTimeline } from '../lib/personal/cloud/timeline.mjs';
export function checkOutput(report,input) {
  const timeline=validateTimeline(input,{forRender:true});
  const duration=timeline.clips.reduce((sum,clip)=>sum+clip.trimEnd-clip.trimStart,0);
  const [width,height]=timeline.output==='720p'?[720,1280]:[360,640];
  if(!report||report.videoCodec!=='h264'||report.audioCodec!=='aac'||report.width!==width||report.height!==height
    ||!Number.isFinite(report.duration)||Math.abs(report.duration-duration)>0.15
    ||!Number.isSafeInteger(report.size)||report.size<1||report.size>20*1024*1024) throw new Error('OUTPUT_VERIFICATION_FAILED');
  return {videoCodec:'h264',audioCodec:'aac',width,height,duration:report.duration,size:report.size};
}
