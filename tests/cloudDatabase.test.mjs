// Real Postgres SQL execution in PGlite, not a mocked durability adapter.
// No rendering, external services, provisioning or real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const owner='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const project='20000000-0000-4000-8000-000000000003',local='20000000-0000-4000-8000-000000000004';
const migration=await readFile(new URL('../supabase/migrations/202611070001_private_studio.sql',import.meta.url),'utf8');
async function setup() {
  const db=new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await db.exec(migration);
  return db;
}
async function approve(db) { await db.query('insert into studio_cloud_control(singleton,owner_id,storage_review_expires_at) values(true,$1,now()+interval \'1 hour\')',[owner]); }
async function rpc(db,action,payload={},who=owner) { return (await db.query('select studio_coordinate($1,$2,$3::jsonb) as result',[action,who,JSON.stringify(payload)])).rows[0].result; }
async function save(db) { return rpc(db,'save',{id:project,revision:0,manifest:{schemaVersion:1,title:'SQL test',characterId:'',clips:[],audio:null,output:'preview'}}); }
const file={projectId:project,localId:local,kind:'video',mime:'video/mp4',size:1024};

test('SQL migration defaults private and denies all actions before explicit unexpired review',async()=>{
  const db=await setup();try {
    assert.equal((await db.query('select public from storage.buckets')).rows[0].public,false);
    await assert.rejects(()=>rpc(db,'list'),/cloud_review_required/);
    await approve(db);assert.deepEqual(await rpc(db,'list'),{projects:[],assets:[],jobs:[]});
    await db.exec("update studio_cloud_control set storage_review_expires_at=now()-interval '1 second'");
    await assert.rejects(()=>rpc(db,'list'),/cloud_review_required/);
    await db.exec("update studio_cloud_control set storage_review_expires_at=now()+interval '2 days'");
    await assert.rejects(()=>rpc(db,'list'),/cloud_review_required/);
    await db.exec("update studio_cloud_control set storage_review_expires_at=now()+interval '1 hour'; update storage.buckets set public=true");
    await assert.rejects(()=>rpc(db,'list'),/private_bucket_required/);
  } finally { await db.close(); }
});
test('durable project and upload states survive independent RPCs; stale revisions cannot overwrite work',async()=>{
  const db=await setup();try {
    await approve(db);const first=await save(db);assert.equal(first.revision,1);
    await assert.rejects(()=>save(db),/ownership_or_revision_conflict/);
    const second=await rpc(db,'save',{id:project,revision:1,manifest:{title:'Changed'}});assert.equal(second.revision,2);
    const asset=await rpc(db,'reserve',file);assert.equal(asset.path,`${owner}/${project}/${asset.id}`);
    assert.equal((await rpc(db,'list')).jobs[0].status,'uploading');
    await rpc(db,'complete',{id:asset.id});const state=await rpc(db,'list');assert.equal(state.assets[0].state,'ready');assert.equal(state.jobs[0].status,'draft');
    assert.equal(state.projects[0].manifest.title,'Changed');
  } finally { await db.close(); }
});
test('RLS and RPC privileges deny browser roles; configured server owner is mandatory',async()=>{
  const db=await setup();try {
    await approve(db);await save(db);const asset=await rpc(db,'reserve',file);
    await assert.rejects(()=>rpc(db,'asset',{id:asset.id},other),/cloud_review_required/);
    await db.exec('set role anon');
    await assert.rejects(()=>db.query('select * from studio_assets'),/permission denied/);
    await assert.rejects(()=>rpc(db,'list'),/permission denied/);
    await db.exec('reset role; set role authenticated');await assert.rejects(()=>rpc(db,'list'),/permission denied/);
    await db.exec('reset role; set role service_role');assert.equal((await rpc(db,'list')).projects.length,1);
  } finally { await db.close(); }
});
test('storage reservations include unfinished uploads and fail atomically at 400 MiB',async()=>{
  const db=await setup();try {
    await approve(db);await save(db);
    for(let i=0;i<20;i++) await rpc(db,'reserve',{...file,size:20*1024*1024});
    await assert.rejects(()=>rpc(db,'reserve',{...file,size:1}),/storage_limit/);
    assert.equal((await rpc(db,'list')).assets.length,20);
  } finally { await db.close(); }
});
test('read requires completed upload and reserves a conservative persistent monthly issuance budget',async()=>{
  const db=await setup();try {
    await approve(db);await save(db);const asset=await rpc(db,'reserve',{...file,size:20*1024*1024});
    await assert.rejects(()=>rpc(db,'read',{id:asset.id}),/asset_not_ready/);
    await rpc(db,'complete',{id:asset.id});for(let i=0;i<17;i++) await rpc(db,'read',{id:asset.id});
    await assert.rejects(()=>rpc(db,'read',{id:asset.id}),/egress_limit/);
  } finally { await db.close(); }
});
test('no RPC action can queue/render/complete a job; DB disallows a completed job without an output',async()=>{
  const db=await setup();try {
    await approve(db);await save(db);
    for(const action of ['enqueue','render','worker-complete','cancel']) await assert.rejects(()=>rpc(db,action),/unsupported_action/);
    assert.equal((await rpc(db,'list')).jobs[0].status,'draft');
    await assert.rejects(()=>db.exec("update studio_render_jobs set status='completed'"),/check constraint/);
  } finally { await db.close(); }
});


test('expired unconfirmed uploads become durable failures; only an explicit save permits retry',async()=>{
  const db=await setup();try {
    await approve(db);const saved=await save(db);const expired=await rpc(db,'reserve',file);
    await db.exec("update studio_assets set upload_expires_at=now()-interval '1 second'");
    const state=await rpc(db,'list');assert.equal(state.jobs[0].status,'failed');assert.equal(state.assets[0].state,'failed');
    await assert.rejects(()=>rpc(db,'complete',{id:expired.id}),/upload_confirmation_expired/);
    await assert.rejects(()=>rpc(db,'reserve',file),/project_locked/);
    await rpc(db,'save',{id:project,revision:saved.revision,manifest:saved.manifest});
    const retry=await rpc(db,'reserve',file);await rpc(db,'complete',{id:retry.id});
    assert.equal((await rpc(db,'list')).jobs[0].status,'draft');
    assert.equal((await rpc(db,'list')).assets.length,2); // Failed reservation is never silently freed.
  } finally { await db.close(); }
});
