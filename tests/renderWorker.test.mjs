import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {signWorker,verifyWorker} from '../lib/server/cloud/workerAuth.mjs';
import {renderConfig} from '../lib/server/cloud/renderConfig.mjs';
import {cloudRunClient,verifyJobDefinition} from '../lib/server/cloud/cloudRun.mjs';
import {renderAction} from '../lib/server/cloud/renderService.mjs';
import {workerAction} from '../lib/server/cloud/workerService.mjs';
import {runAcceptance} from '../scripts/cloud-render-acceptance.mjs';
import {runWorker} from '../worker/runtime/main.mjs';
const id=n=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const secret='synthetic-worker-secret-not-a-real-credential';
const env={STUDIO_CLOUD_RENDER_ENABLED:'true',STUDIO_RENDER_COST_APPROVAL_EXPIRES_AT:new Date(Date.now()+3600000).toISOString(),STUDIO_RENDER_WORKER_SECRET:secret,GCP_RENDER_PROJECT_ID:'studio-test',GCP_RENDER_PROJECT_NUMBER:'123456789012',GCP_RENDER_REGION:'us-central1',GCP_RENDER_JOB:'studio-ffmpeg',GCP_RENDER_WIF_POOL:'studio-pool',GCP_RENDER_WIF_PROVIDER:'studio-provider',GCP_RENDER_INVOKER_NAME:'studio-invoker'};
const definition=()=>({template:{taskCount:1,parallelism:1,template:{maxRetries:0,timeout:'660s',containers:[{name:'worker',image:'test/image@sha256:'+'a'.repeat(64),resources:{limits:{cpu:'1',memory:'2Gi'}},volumeMounts:[{name:'scratch',mountPath:'/tmp'}],env:[{name:'STUDIO_WORKER_EXECUTION_ENABLED',value:'true'}]}],volumes:[{name:'scratch',emptyDir:{medium:'MEMORY',sizeLimit:'256Mi'}}]}}});
const manifest={schemaVersion:1,title:'Worker',characterId:'',clips:[1,2].map(n=>({id:id(n),assetId:id(n+10),sceneId:'',trimStart:0,trimEnd:1,fit:'pad',volume:1,mute:false})),audio:null,output:'preview'};
test('cost gate defaults off, expires and rejects arbitrary endpoints/invalid identity config',()=>{
  assert.equal(renderConfig({}),null);assert.ok(renderConfig(env));
  for(const patch of [{STUDIO_CLOUD_RENDER_ENABLED:'false'},{STUDIO_RENDER_COST_APPROVAL_EXPIRES_AT:'bad'},{STUDIO_RENDER_COST_APPROVAL_EXPIRES_AT:new Date(Date.now()-1).toISOString()},{STUDIO_RENDER_COST_APPROVAL_EXPIRES_AT:new Date(Date.now()+25*3600000).toISOString()},{GCP_RENDER_PROJECT_ID:'https://evil.invalid'},{GCP_RENDER_JOB:'unrelated-job'},{STUDIO_RENDER_WORKER_SECRET:''}])assert.equal(renderConfig({...env,...patch}),null);
});
test('worker HMAC rejects tampering, wrong secret and stale signatures',()=>{
  const body=JSON.stringify({action:'claim'}),headers=new Headers(signWorker(body,secret));
  assert.ok(verifyWorker(body,headers,secret));assert.equal(verifyWorker(body+' ',headers,secret),false);assert.equal(verifyWorker(body,headers,secret+'wrong'),false);
  assert.equal(verifyWorker(body,new Headers(signWorker(body,secret,{now:Date.now()-60000})),secret),false);assert.equal(verifyWorker(body,new Headers(),secret),false);
});
test('Cloud Run limits reject retries, sidecars, excessive CPU, unpinned image or missing scratch cap',()=>{
  verifyJobDefinition(definition());
  for(const change of [d=>d.template.template.maxRetries=1,d=>d.template.parallelism=2,d=>d.template.template.containers[0].resources.limits.cpu='2',d=>d.template.template.containers[0].image='image:latest',d=>d.template.template.volumes=[],d=>d.template.template.containers[0].volumeMounts=[],d=>d.template.template.containers.push({})]){const d=definition();change(d);assert.throws(()=>verifyJobDefinition(d));}
});
test('WIF uses short-lived server tokens and fixed URLs, then dispatches exactly one bounded execution',async()=>{
  const calls=[];const client=cloudRunClient(renderConfig(env),{oidcToken:async()=>'synthetic-oidc',fetchImpl:async(url,options)=>{
    calls.push({url,options});assert.equal(options.redirect,'error');
    if(url.includes('sts.googleapis.com')){assert.equal(new URLSearchParams(options.body).get('subject_token'),'synthetic-oidc');return Response.json({access_token:'synthetic-exchange'});}
    if(url.includes('iamcredentials'))return Response.json({accessToken:'synthetic-access'});
    if(options.method==='GET')return Response.json(definition());
    const body=JSON.parse(options.body);assert.equal(body.overrides.taskCount,1);assert.equal(body.overrides.timeout,'660s');assert.equal(body.overrides.containerOverrides[0].env.length,2);return Response.json({name:'operation'});
  }});
  await client.start(id(1),id(2));assert.equal(calls.length,4);assert.ok(calls[3].url.endsWith('/studio-ffmpeg:run'));await assert.rejects(()=>client.cancel('unrelated-job-execution'));
});
test('disabled render never calls provider; uncertain dispatch is recorded once and never retried',async()=>{
  let started=0;const calls=[];const store={rpc:async()=>({projects:[{id:id(91),revision:1,manifest}]}),renderRpc:async(action)=>{calls.push(action);return {jobId:id(1),dispatchId:id(2)};}};
  await assert.rejects(()=>renderAction({action:'render'},store,null,{start:()=>{started++;}}),error=>error.status===409);assert.equal(started,0);
  await assert.rejects(()=>renderAction({action:'render',projectId:id(91),revision:1},store,{}, {start:async()=>{started++;throw new Error('sensitive URL');}}),error=>error.status===502&&!error.message.includes('sensitive'));
  assert.equal(started,1);assert.deepEqual(calls,['enqueue','dispatch-failed']);
});
test('cancellation persists before provider contact and never claims remote termination',async()=>{
  const calls=[];const result=await renderAction({action:'cancel-render',jobId:id(1)},{renderRpc:async()=>{calls.push('persist');return {execution:'studio-ffmpeg-a'};}},{},{cancel:async()=>{calls.push('cancel');throw new Error('timeout');}});
  assert.deepEqual(calls,['persist','cancel']);assert.equal(result.cancelRequested,true);assert.ok(result.message.includes('doğrulanana'));
});
test('output must pass report and server HEAD verification before durable completion',async()=>{
  const calls=[];const store={renderRpc:async action=>{calls.push(action);return {asset:{size:1000},manifest};},verifyUpload:async()=>{throw new Error('HEAD mismatch');}};
  await assert.rejects(()=>workerAction({action:'complete',jobId:id(1),lease:id(2),report:{videoCodec:'h264',audioCodec:'aac',width:360,height:640,duration:2,size:1000}},randomUUID(),store,{enabled:true}));assert.deepEqual(calls,['output-info']);
});
test('disabling execution requests worker stop and rejects fresh claims or output writes',async()=>{
  const result=await workerAction({action:'heartbeat',jobId:id(1),lease:id(2),progress:0.2,phase:'encoding'},randomUUID(),{renderRpc:async()=>({cancel:false})},{enabled:false});assert.equal(result.cancel,true);
  await assert.rejects(()=>workerAction({action:'claim',jobId:id(1)},randomUUID(),{},{enabled:false}),/DISABLED/);
});
test('production worker refuses local/unapproved startup before any network request',async()=>{
  await assert.rejects(()=>runWorker({}, {fetchImpl:()=>assert.fail('Unexpected network')}),/CLOUD_EXECUTION_NOT_APPROVED/);
});

test('cloud acceptance entry point rejects missing approval before configuration, files or network work',async()=>{
  await assert.rejects(()=>runAcceptance({}, {fetchImpl:()=>assert.fail('Unexpected network request')}),/Explicit approval required/);
});
