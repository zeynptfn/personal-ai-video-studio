// Development reference test ONLY. This is not a Google Cloud acceptance result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command,encodeTimeline,probe } from '../runtime/ffmpeg.mjs';
const id=n=>`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export async function referenceRender(directory) {
  const first=join(directory,'red.mp4'),second=join(directory,'blue.mp4'),voice=join(directory,'voice.wav'),output=join(directory,'output.mp4');
  await command('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=red:s=160x90:r=15','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',first]);
  await command('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=blue:s=90x160:r=24','-t','1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',second]);
  await command('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','1','-c:a','pcm_s16le',voice]);
  const manifest={schemaVersion:1,title:'Reference test',characterId:id(80),clips:[
    {id:id(1),assetId:id(11),sceneId:id(70),trimStart:0.1,trimEnd:0.9,fit:'crop',volume:1,mute:true},
    {id:id(2),assetId:id(12),sceneId:id(71),trimStart:0.1,trimEnd:0.9,fit:'pad',volume:1,mute:true},
  ],audio:{assetId:id(13),offset:0.4,trimStart:0.1,volume:0.8},output:'preview'};
  const assets=[{id:id(21),local_id:id(11),kind:'video'},{id:id(22),local_id:id(12),kind:'video'},{id:id(23),local_id:id(13),kind:'audio'}].map(asset=>({...asset,owner_id:id(90),project_id:id(91),state:'ready'}));
  const files=new Map([[id(21),second],[id(22),first],[id(23),voice]]); // Reorder blue before red, unlike creation order.
  const progress=[];
  const report=await encodeTimeline(manifest,assets,files,output,{ownerId:id(90),projectId:id(91),onProgress:value=>progress.push(value)});
  return {output,manifest,report,progress,assets,files};
}
test('real FFmpeg reference: reorder/trim/normalize two MP4s and delayed voice to playable H264/AAC 9:16',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'studio-reference-'));
  try {
    const {output,report,progress}=await referenceRender(directory);
    assert.equal(report.width,360);assert.equal(report.height,640);assert.equal(report.videoCodec,'h264');assert.equal(report.audioCodec,'aac');assert.ok(Math.abs(report.duration-1.6)<0.15);
    assert.ok(progress.length>0);assert.ok((await readFile(output)).subarray(4,8).toString()==='ftyp');assert.ok((await stat(output)).size>1000);
    // Decode fixed points in the reference output to verify actual clip ordering.
    for(const [time,color] of [[0.2,'blue'],[1.1,'red']]) {
      const frame=join(directory,`${color}.rgb`);
      await command('ffmpeg',['-v','error','-y','-ss',String(time),'-i',output,'-frames:v','1','-vf','crop=2:2:180:320','-f','rawvideo','-pix_fmt','rgb24',frame]);
      const bytes=await readFile(frame);assert.ok(color==='blue'?bytes[2]>bytes[0]+100:bytes[0]>bytes[2]+100);
    }
    // The muted sources must stay silent until the voice offset, then contain audio.
    const pcm=join(directory,'output.pcm');await command('ffmpeg',['-v','error','-y','-i',output,'-vn','-f','f32le','-ac','1','-ar','8000',pcm]);
    const bytes=await readFile(pcm);const rms=(start,end)=>{let sum=0,count=0;for(let i=Math.floor(start*8000);i<Math.floor(end*8000)&&i*4+4<=bytes.length;i++){const x=bytes.readFloatLE(i*4);sum+=x*x;count++;}return Math.sqrt(sum/count);};
    assert.ok(rms(0.05,0.25)<0.002,`early RMS=${rms(0.05,0.25)}, late RMS=${rms(0.55,0.75)}`);assert.ok(rms(0.55,0.75)>0.01);
    assert.equal((await probe(output)).hasAudio,true);
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('aborted native command exits without a success result',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>command('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=64x64','-f','null','-'],{signal:controller.signal}));
});

test('full worker lifecycle uses authenticated coordination and scoped private transfer; real MP4 output is verified before completion',async()=>{
  const {runWorker}=await import('../runtime/main.mjs');
  const {verifyWorker}=await import('../../lib/server/cloud/workerAuth.mjs');
  const directory=await mkdtemp(join(tmpdir(),'studio-lifecycle-'));
  try {
    const fixture=await referenceRender(directory),secret='synthetic-lifecycle-secret-only-not-real';
    const assets=await Promise.all(fixture.assets.map(async asset=>({...asset,size:(await stat(fixture.files.get(asset.id))).size,mime:asset.kind==='audio'?'audio/wav':'video/mp4'})));
    const media=new Map(await Promise.all(assets.map(async asset=>[asset.id,await readFile(fixture.files.get(asset.id))])));
    const calls=[],nonces=new Set();let uploaded,report;
    const origin='https://mock-studio.vercel.app',storage=`https://${'a'.repeat(20)}.storage.supabase.co`;
    const result=await runWorker({STUDIO_WORKER_EXECUTION_ENABLED:'true',CLOUD_RUN_JOB:'studio-ffmpeg',CLOUD_RUN_EXECUTION:'studio-ffmpeg-test',CLOUD_RUN_TASK_INDEX:'0',CLOUD_RUN_TASK_COUNT:'1',CLOUD_RUN_TASK_ATTEMPT:'0',STUDIO_COORDINATOR_ORIGIN:origin,STUDIO_RENDER_WORKER_SECRET:secret,STUDIO_RENDER_JOB_ID:id(1),STUDIO_RENDER_DISPATCH_ID:id(2),STUDIO_STORAGE_PROJECT_REF:'a'.repeat(20)},{fetchImpl:async(url,options={})=>{
      if(url.startsWith(origin)){
        assert.ok(verifyWorker(options.body,new Headers(options.headers),secret));const nonce=options.headers['X-Studio-Nonce'];assert.ok(!nonces.has(nonce));nonces.add(nonce);
        const data=JSON.parse(options.body);calls.push(data.action);
        if(data.action==='claim')return Response.json({lease:id(3),jobId:id(1),ownerId:id(90),projectId:id(91),manifest:fixture.manifest});
        assert.equal(data.lease,id(3));
        if(data.action==='inputs')return Response.json({assets});
        if(data.action==='input')return Response.json({ticket:{url:`${storage}/${data.assetId}`}});
        if(data.action==='heartbeat')return Response.json({cancel:false});
        if(data.action==='output')return Response.json({ticket:{url:`${storage}/output`,headers:{'Content-Type':'video/mp4'}}});
        if(data.action==='complete'){assert.ok(uploaded?.length>1000);report=data.report;return Response.json({outputId:id(4)});}
        throw new Error('Unexpected coordinator event');
      }
      assert.ok(url.startsWith(storage));
      if(options.method==='PUT'){const chunks=[];for await(const chunk of options.body)chunks.push(chunk);uploaded=Buffer.concat(chunks);return new Response(null,{status:200});}
      const bytes=media.get(url.split('/').pop());assert.ok(bytes);return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
    }});
    assert.equal(result.completed,true);assert.equal(calls.filter(value=>value==='complete').length,1);assert.ok(!calls.includes('failed'));
    assert.equal(report.videoCodec,'h264');assert.equal(report.audioCodec,'aac');assert.equal(report.width,360);assert.equal(report.height,640);assert.equal(uploaded.subarray(4,8).toString(),'ftyp');
  } finally {await rm(directory,{recursive:true,force:true});}
});
