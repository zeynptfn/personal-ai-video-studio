import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTimeline, validateTimeline, validateCloudAsset, moveClip } from '../lib/personal/cloud/timeline.mjs';
import { cloudConfig } from '../lib/server/cloud/config.mjs';
import { cloudAction } from '../lib/server/cloud/service.mjs';
import { createCloudStore } from '../lib/server/cloud/supabase.mjs';
import { planCloudRender } from '../worker/render-contract.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const clip = n => ({ id:id(n),assetId:id(n+10),sceneId:id(70),trimStart:0,trimEnd:2,fit:'pad',volume:1,mute:false });
const timeline = () => ({ ...newTimeline(), characterId:id(80),clips:[clip(1),clip(2)],audio:{assetId:id(20),offset:1,trimStart:0.5,volume:0.7} });
const config = { ref:'a'.repeat(20),owner:id(90),url:`https://${'a'.repeat(20)}.supabase.co`,s3:`https://${'a'.repeat(20)}.storage.supabase.co/storage/v1/s3`,region:'eu-central-1',serviceKey:'synthetic-service-only',accessKeyId:'synthetic-access-only',secretAccessKey:'synthetic-secret-only' };
const asset = { id:id(11),project_id:id(91),owner_id:config.owner,path:`${config.owner}/${id(91)}/${id(11)}`,size:1024,mime:'video/mp4',kind:'video' };

test('timeline preserves character/scene references, order, trims, mute and voice timing',()=>{
  const input=timeline();input.clips[1].mute=true;
  assert.deepEqual(validateTimeline(input,{forRender:true}),input);
  const moved=moveClip(input.clips,1,-1);assert.equal(moved[0].id,id(2));assert.equal(input.clips[0].id,id(1));
  assert.deepEqual(moveClip(input.clips,0,-1),input.clips);
});
test('timeline rejects arbitrary commands, URLs, unknown fields and invalid references',()=>{
  for(const patch of [{ffmpegArgs:['-i','https://invalid']},{output:'https://invalid'},{characterId:'../other'}]) assert.throws(()=>validateTimeline({...timeline(),...patch}));
  for(const patch of [{assetId:'https://invalid'},{trimStart:NaN},{trimEnd:0},{trimEnd:601},{volume:3},{mute:'false'},{fit:'custom'},{url:'https://invalid'}]) {
    const input=timeline();input.clips[0]={...input.clips[0],...patch};assert.throws(()=>validateTimeline(input));
  }
});
test('timeline enforces finite duration, clip count, duplicate identity and minimum render inputs',()=>{
  assert.throws(()=>validateTimeline({...timeline(),clips:[clip(1)]},{forRender:true}));
  assert.throws(()=>validateTimeline({...timeline(),clips:[clip(1),clip(1)]}));
  assert.throws(()=>validateTimeline({...timeline(),clips:Array.from({length:9},(_,i)=>clip(i+1))}));
  assert.throws(()=>validateTimeline({...timeline(),clips:[{...clip(1),trimEnd:121}]}));
  assert.throws(()=>validateTimeline({...timeline(),audio:{assetId:id(20),offset:-1,trimStart:0,volume:1}}));
  assert.deepEqual(validateTimeline(newTimeline()),newTimeline());
});
test('cloud media limits are lower than Free storage maximum; MIME/path cannot be client controlled',()=>{
  assert.deepEqual(validateCloudAsset({localId:id(1),kind:'video',mime:'video/mp4',size:20*1024*1024}),{localId:id(1),kind:'video',mime:'video/mp4',size:20*1024*1024});
  for(const patch of [{size:20*1024*1024+1},{size:0},{size:Infinity},{kind:'output'},{mime:'text/html'},{path:'other/private'}]) assert.throws(()=>validateCloudAsset({localId:id(1),kind:'video',mime:'video/mp4',size:100,...patch}));
  assert.throws(()=>validateCloudAsset({localId:id(1),kind:'image',mime:'image/png',size:11*1024*1024}));
});
test('cloud config defaults off and cannot redirect credentials to arbitrary hosts',()=>{
  assert.equal(cloudConfig({}),null);
  const env={STUDIO_CLOUD_STORAGE_ENABLED:'true',SUPABASE_PROJECT_REF:config.ref,STUDIO_CLOUD_OWNER_ID:config.owner,SUPABASE_STORAGE_REGION:config.region,SUPABASE_SERVICE_ROLE_KEY:config.serviceKey,SUPABASE_S3_ACCESS_KEY_ID:config.accessKeyId,SUPABASE_S3_SECRET_ACCESS_KEY:config.secretAccessKey};
  assert.equal(cloudConfig(env).s3,config.s3);
  for(const ref of ['https://example.com','localhost','../secret','a'.repeat(20)+'.evil']) assert.equal(cloudConfig({...env,SUPABASE_PROJECT_REF:ref}),null);
  assert.equal(cloudConfig({...env,SUPABASE_SERVICE_ROLE_KEY:''}),null);
});
test('render submission fails closed even with configured store and enable flags',async()=>{
  let calls=0;const store={rpc:()=>{calls++;}};
  await assert.rejects(()=>cloudAction({action:'render',enable:true,free:true,manifest:timeline()},store),error=>error.status===409);
  assert.equal(calls,0);
  await assert.rejects(()=>cloudAction({action:'render'},null),error=>error.status===409);
  await assert.rejects(()=>cloudAction({action:'save'},null),error=>error.status===503);
});
test('coordination saves only validated metadata and reserves a file before signing',async()=>{
  const calls=[];const store={rpc:async(action,payload)=>{calls.push({action,payload});return action==='save'?{id:payload.id}:asset;},uploadTicket:async value=>{calls.push({action:'sign',value});return {method:'PUT'};}};
  await cloudAction({action:'save',id:id(91),revision:0,manifest:timeline(),owner:'ignored'},store);
  assert.equal(calls[0].action,'save');assert.equal(calls[0].payload.owner,undefined);
  await cloudAction({action:'upload',projectId:id(91),asset:{localId:id(1),kind:'video',mime:'video/mp4',size:1024}},store);
  assert.equal(calls[1].action,'reserve');assert.equal(calls[2].action,'sign');
});
test('failed HEAD verification never marks upload complete',async()=>{
  const calls=[];const store={rpc:async action=>{calls.push(action);return asset;},verifyUpload:async()=>{throw new Error('invalid upload');}};
  await assert.rejects(()=>cloudAction({action:'complete',id:asset.id},store));assert.deepEqual(calls,['asset']);
});
test('private read checks ownership/budget in durable RPC before signing',async()=>{
  let signed=false;const store={rpc:async()=>{throw new Error('not owned / budget');},readTicket:async()=>{signed=true;}};
  await assert.rejects(()=>cloudAction({action:'read',id:asset.id},store));assert.equal(signed,false);
});
test('S3 tickets have fixed origin, exact object, method scope, size/type signing and short expiry',async()=>{
  const store=createCloudStore(config,{fetchImpl:()=>assert.fail('Signing must not make network requests')});
  const put=await store.uploadTicket(asset), get=await store.readTicket(asset);
  const url=new URL(put.url), read=new URL(get.url);
  assert.equal(url.origin,new URL(config.s3).origin);assert.equal(url.pathname,`/storage/v1/s3/studio-private/${asset.path}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'),'300');assert.equal(read.searchParams.get('X-Amz-Expires'),'120');
  assert.ok(url.searchParams.get('X-Amz-SignedHeaders').includes('content-length'));assert.ok(url.searchParams.get('X-Amz-SignedHeaders').includes('content-type'));
  assert.notEqual(url.searchParams.get('X-Amz-Signature'),read.searchParams.get('X-Amz-Signature'));
  assert.ok(!JSON.stringify(put).includes(config.secretAccessKey));assert.ok(!JSON.stringify(put).includes(config.serviceKey));
  await assert.rejects(()=>store.uploadTicket({...asset,owner_id:id(99)}));
});
test('signed HEAD uses no redirect and rejects wrong MIME or size without reading media',async()=>{
  for (const headers of [{'Content-Length':'1025','Content-Type':'video/mp4'},{'Content-Length':'1024','Content-Type':'text/html'}]) {
    const store=createCloudStore(config,{fetchImpl:async(_url,options)=>{assert.equal(options.method,'HEAD');assert.equal(options.redirect,'error');return new Response(null,{headers});}});
    await assert.rejects(()=>store.verifyUpload(asset));
  }
});
test('Supabase RPC uses only fixed server endpoint and redacts upstream bodies',async()=>{
  let called=0;
  const store=createCloudStore(config,{fetchImpl:async(url,options)=>{
    called++;assert.equal(url,`${config.url}/rest/v1/rpc/studio_coordinate`);assert.equal(options.headers.Authorization,`Bearer ${config.serviceKey}`);assert.equal(JSON.parse(options.body).owner,config.owner);assert.equal(options.redirect,'error');
    return new Response('sensitive upstream failure',{status:403});
  }});
  await assert.rejects(()=>store.rpc('list'),error=>!error.message.includes('sensitive'));assert.equal(called,1);
});
function probed() { return [
  ...[1,2].map(n=>({id:id(n+30),localId:id(n+10),ownerId:config.owner,projectId:id(91),kind:'video',state:'ready',size:1024,duration:4,width:640,height:360,fps:30,hasAudio:n===1})),
  {id:id(33),localId:id(20),ownerId:config.owner,projectId:id(91),kind:'audio',state:'ready',size:512,duration:8},
]; }
test('cloud worker contract plans normalize, pad/crop, concatenate, voice sync and H264/AAC without executing',()=>{
  const input=timeline();input.clips[1].fit='crop';input.clips[0].mute=true;input.output='720p';
  const plan=planCloudRender(input,probed(),{ownerId:config.owner,projectId:id(91)});
  assert.equal(plan.executable,false);assert.equal(plan.clips[1].audio.synthesizeSilence,true);assert.equal(plan.clips[0].audio.mute,true);
  assert.equal(plan.voice.offset,1);assert.equal(plan.voice.trimStart,0.5);assert.equal(plan.clips[1].video.fit,'crop');
  assert.deepEqual(plan.concatOrder,[id(31),id(32)]);assert.equal(plan.output.width,720);assert.equal(plan.output.height,1280);assert.equal(plan.output.audioCodec,'aac');assert.equal(plan.output.duration,4);
});
test('cloud worker contract refuses cross-owner, missing, unprobed and oversized inputs or out-of-range trims',()=>{
  for(const patch of [{ownerId:id(99)},{state:'uploading'},{size:21*1024*1024},{width:9000},{fps:120},{duration:1}]) {
    const files=probed();files[0]={...files[0],...patch};assert.throws(()=>planCloudRender(timeline(),files,{ownerId:config.owner,projectId:id(91)}));
  }
  assert.throws(()=>planCloudRender(timeline(),[],{ownerId:config.owner,projectId:id(91)}));
});
