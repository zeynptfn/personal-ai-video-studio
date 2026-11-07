import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const id=n=>`50000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const migrations=await Promise.all(['202611070001_private_studio.sql','202611070002_render_worker.sql'].map(name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8')));
async function setup({approved=true}={}) {
  const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  for(const sql of migrations)await db.exec(sql);
  await db.query("insert into studio_cloud_control values(true,$1,now()+interval '1 hour',now())",[id(90)]);
  if(approved)await db.exec("insert into studio_render_settings values(true,now()+interval '1 hour')");
  const rpc=async(action,payload={})=>(await db.query('select studio_coordinate($1,$2,$3::jsonb) result',[action,id(90),JSON.stringify(payload)])).rows[0].result;
  const render=async(action,payload={})=>(await db.query('select studio_render_coordinate($1,$2,$3::jsonb) result',[action,id(90),JSON.stringify(payload)])).rows[0].result;
  async function project(n=91) {
    const manifest={schemaVersion:1,title:'Render SQL',characterId:id(80),clips:[1,2].map(i=>({id:id(i),assetId:id(i+10),sceneId:id(70),trimStart:0,trimEnd:1,fit:'pad',volume:1,mute:false})),audio:{assetId:id(13),offset:0,trimStart:0,volume:1},output:'preview'};
    await rpc('save',{id:id(n),revision:0,manifest});const sources=[];
    for(const [local,kind,mime] of [[11,'video','video/mp4'],[12,'video','video/mp4'],[13,'audio','audio/wav']]){const a=await rpc('reserve',{projectId:id(n),localId:id(local),kind,mime,size:1024});await rpc('complete',{id:a.id});sources.push(a);}
    await db.exec("update studio_assets set upload_expires_at=now()-interval '1 minute' where state='ready'");
    return {manifest,sources};
  }
  async function queued(){await project();return render('enqueue',{projectId:id(91),revision:1});}
  async function claimed(){const q=await queued();const c=await render('claim',{jobId:q.jobId,dispatchId:q.dispatchId,execution:'studio-ffmpeg-test',nonce:randomUUID()});return {q,c};}
  return {db,rpc,render,project,queued,claimed};
}
test('render settings default closed; missing approval and active upload capabilities block enqueue',async()=>{
  const s=await setup({approved:false});try {
    await s.project();assert.equal((await s.render('status')).approvalReady,false);
    await assert.rejects(()=>s.render('enqueue',{projectId:id(91),revision:1}),/cost_approval_required/);
    await s.db.exec("insert into studio_render_settings values(true,now()+interval '1 hour');update studio_assets set upload_expires_at=now()+interval '1 minute'");
    await assert.rejects(()=>s.render('enqueue',{projectId:id(91),revision:1}),/upload_capability_active/);
    await s.db.exec("update studio_cloud_control set storage_review_expires_at=now()-interval '1 second'");
    assert.equal((await s.render('status')).approvalReady,false);
  }finally{await s.db.close();}
});
test('snapshot, single claim, replay prevention, fenced lease, ownership and output publication are durable',async()=>{
  const s=await setup();try {
    const {q,c}=await s.claimed();const nonce=randomUUID();
    await assert.rejects(()=>s.render('claim',{jobId:q.jobId,dispatchId:q.dispatchId,execution:'studio-ffmpeg-test',nonce:randomUUID()}),/claim_rejected/);
    await assert.rejects(()=>s.rpc('save',{id:id(91),revision:1,manifest:{title:'overwrite'}}),/project_locked/);
    await s.render('heartbeat',{jobId:q.jobId,lease:c.lease,nonce,progress:0.4,phase:'encoding'});
    await assert.rejects(()=>s.render('heartbeat',{jobId:q.jobId,lease:c.lease,nonce,progress:0.5,phase:'encoding'}),/duplicate key/);
    await assert.rejects(()=>s.render('inputs',{jobId:q.jobId,lease:randomUUID(),nonce:randomUUID()}),/lease_rejected/);
    const inputs=await s.render('inputs',{jobId:q.jobId,lease:c.lease,nonce:randomUUID()});assert.equal(inputs.assets.length,3);
    await assert.rejects(()=>s.render('input',{jobId:q.jobId,lease:c.lease,assetId:id(99),nonce:randomUUID()}),/input_not_owned/);
    await assert.rejects(()=>s.render('complete',{jobId:q.jobId,lease:c.lease,nonce:randomUUID()}),/output_missing/);
    const output=await s.render('output',{jobId:q.jobId,lease:c.lease,nonce:randomUUID(),size:5000});assert.equal(output.size,5000);
    await s.render('complete',{jobId:q.jobId,lease:c.lease,nonce:randomUUID()});
    const state=await s.rpc('list');assert.equal(state.jobs[0].status,'completed');assert.equal(state.jobs[0].progress,1);
    assert.equal(state.jobs[0].output_asset_id,output.id);assert.equal(state.assets.find(a=>a.id===output.id).state,'ready');
    assert.ok(!JSON.stringify(state).includes(c.lease));assert.ok(!JSON.stringify(state).includes(q.dispatchId));
  }finally{await s.db.close();}
});
test('cancellation requires worker stop acknowledgement and prevents late success or overlapping launches',async()=>{
  const s=await setup();try {
    const {q,c}=await s.claimed();await s.render('cancel',{jobId:q.jobId});
    assert.equal((await s.rpc('list')).jobs[0].status,'rendering');
    assert.equal((await s.render('heartbeat',{jobId:q.jobId,lease:c.lease,nonce:randomUUID(),progress:0,phase:'downloading'})).cancel,true);
    await assert.rejects(()=>s.render('complete',{jobId:q.jobId,lease:c.lease,nonce:randomUUID()}),/cancel_or_approval/);
    await s.project(92);await assert.rejects(()=>s.render('enqueue',{projectId:id(92),revision:1}),/execution_barrier/);
    await s.render('cancelled',{jobId:q.jobId,lease:c.lease,nonce:randomUUID()});
    assert.equal((await s.rpc('list')).jobs.find(j=>j.id===q.jobId).status,'cancelled');
    await assert.rejects(()=>s.render('complete',{jobId:q.jobId,lease:c.lease,nonce:randomUUID()}),/terminal/);
  }finally{await s.db.close();}
});
test('lost heartbeat fails the durable job; ambiguous dispatch is never retried and keeps the barrier',async()=>{
  const s=await setup();try {
    const {q,c}=await s.claimed();await s.db.exec("update studio_render_attempts set lease_expires_at=now()-interval '1 second'");
    await s.render('status');assert.equal((await s.rpc('list')).jobs[0].error_code,'WORKER_LEASE_EXPIRED');
    await assert.rejects(()=>s.render('complete',{jobId:q.jobId,lease:c.lease,nonce:randomUUID()}),/terminal/);
    await s.project(92);await assert.rejects(()=>s.render('enqueue',{projectId:id(92),revision:1}),/execution_barrier/);
  }finally{await s.db.close();}
});
test('queued cancellation and failed dispatch keep the cost barrier; browser roles cannot reach worker RPC',async()=>{
  const s=await setup();try {
    const q=await s.queued();await s.render('dispatch-failed',{jobId:q.jobId});
    assert.equal((await s.rpc('list')).jobs[0].error_code,'DISPATCH_UNCERTAIN_NO_RETRY');
    await s.project(92);await assert.rejects(()=>s.render('enqueue',{projectId:id(92),revision:1}),/execution_barrier/);
    await s.db.exec('set role anon');await assert.rejects(()=>s.render('status'),/permission denied/);
    await assert.rejects(()=>s.db.query('select * from studio_render_attempts'),/permission denied/);
  }finally{await s.db.close();}
});
