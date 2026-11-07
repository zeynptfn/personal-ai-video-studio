-- Manual follow-up migration; does not enable Cloud Run or authorize spending.
begin;
alter table public.studio_render_jobs add column progress double precision not null default 0 check(progress>=0 and progress<=1);
alter table public.studio_render_jobs add column phase text;
alter table public.studio_render_jobs add column execution_name text;
create table public.studio_render_settings (
  singleton boolean primary key default true check(singleton),
  cost_approval_expires_at timestamptz -- Operator acknowledgement, NOT a Google spending lock.
);
create table public.studio_render_attempts (
  job_id uuid primary key references public.studio_render_jobs(id),
  dispatch_id uuid not null default gen_random_uuid(),
  snapshot jsonb not null,
  inputs jsonb not null,
  lease_token uuid,
  lease_expires_at timestamptz,
  deadline timestamptz,
  execution text,
  cancel_requested boolean not null default false,
  finished boolean not null default false,
  output_id uuid not null references public.studio_assets(id),
  output_size bigint,
  created_at timestamptz not null default now(),
  -- Even ambiguous starts/cancellation cannot permit overlapping expensive work.
  block_until timestamptz not null default now()+interval '15 minutes'
);
create table public.studio_worker_nonces(nonce uuid primary key,created_at timestamptz not null default now());
alter table public.studio_render_settings enable row level security;
alter table public.studio_render_attempts enable row level security;
alter table public.studio_worker_nonces enable row level security;
revoke all on public.studio_render_settings,public.studio_render_attempts,public.studio_worker_nonces from public,anon,authenticated;
-- Secrets and immutable snapshots live here, NEVER in studio_render_jobs (which is listed to the browser).

create function public.studio_render_coordinate(action text,owner uuid,payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_job public.studio_render_jobs;
  v_attempt public.studio_render_attempts;
  v_project public.studio_projects;
  v_asset public.studio_assets;
  v_approval timestamptz;
  v_inputs jsonb := '[]'::jsonb;
  v_local uuid;
  v_output uuid;
  v_ready boolean;
  v_sum bigint;
begin
  perform pg_advisory_xact_lock(734921);
  if not exists(select 1 from public.studio_cloud_control c where c.singleton and c.owner_id=owner) then raise exception 'owner_required'; end if;
  select s.cost_approval_expires_at into v_approval from public.studio_render_settings s where s.singleton;
  v_ready := coalesce(v_approval>now() and v_approval<=now()+interval '24 hours',false)
    and exists(select 1 from public.studio_cloud_control c where c.owner_id=owner and c.storage_review_expires_at>now() and c.storage_review_expires_at<=now()+interval '24 hours')
    and exists(select 1 from storage.buckets b where b.id='studio-private' and not b.public and b.file_size_limit<=20971520);
  -- Reconciliation runs on status requests; no cron/service with idle charges.
  update public.studio_render_jobs j set status='failed',error_code=case when a.cancel_requested then 'CANCELLATION_UNCONFIRMED' else 'WORKER_LEASE_EXPIRED' end,updated_at=now()
    from public.studio_render_attempts a where a.job_id=j.id and j.owner_id=owner and j.status='rendering'
    and (a.lease_expires_at<=now() or a.deadline<=now());
  update public.studio_render_jobs j set status='failed',error_code='WORKER_START_EXPIRED',updated_at=now()
    from public.studio_render_attempts a where a.job_id=j.id and j.owner_id=owner and j.status='queued' and a.created_at<now()-interval '5 minutes';
  if action='status' then return jsonb_build_object('approvalReady',v_ready); end if;
  if action='enqueue' then
    if not v_ready then raise exception 'cost_approval_required'; end if;
    perform public.studio_coordinate('list',owner,'{}'::jsonb); -- Free-storage review + private bucket check.
    select * into v_project from public.studio_projects p where p.id=(payload->>'projectId')::uuid and p.owner_id=owner;
    if not found or v_project.revision<>(payload->>'revision')::integer then raise exception 'revision_or_owner_conflict'; end if;
    select * into v_job from public.studio_render_jobs j where j.project_id=v_project.id and j.owner_id=owner;
    if not found or v_job.status<>'draft' or exists(select 1 from public.studio_render_attempts a where a.job_id=v_job.id) then raise exception 'draft_required_no_retry'; end if;
    if exists(select 1 from public.studio_render_attempts a where not a.finished and a.block_until>now()) then raise exception 'execution_barrier'; end if;
    if (select count(*) from public.studio_render_attempts a where a.created_at>now()-interval '1 day')>=3
      or (select count(*) from public.studio_render_attempts a where a.created_at>=date_trunc('month',now()))>=20 then raise exception 'render_limit'; end if;
    if jsonb_array_length(v_project.manifest->'clips')<2 then raise exception 'two_clips_required'; end if;
    for v_local in select distinct x.id from (
      select (c->>'assetId')::uuid id from jsonb_array_elements(v_project.manifest->'clips') c
      union select (v_project.manifest->'audio'->>'assetId')::uuid where v_project.manifest->'audio' is not null and v_project.manifest->'audio'<>'null'::jsonb
    ) x loop
      select * into v_asset from public.studio_assets a where a.project_id=v_project.id and a.owner_id=owner and a.local_id=v_local and a.state='ready' and a.kind in ('video','audio') order by a.created_at desc,a.id desc limit 1;
      if not found or v_asset.upload_expires_at+interval '30 seconds'>now() then raise exception 'input_missing_or_upload_capability_active'; end if;
      v_inputs:=v_inputs||jsonb_build_array(to_jsonb(v_asset));
    end loop;
    select coalesce(sum(a.size),0) into v_sum from public.studio_assets a;
    if v_sum+20971520>419430400 or (select count(*) from public.studio_assets)>=100 then raise exception 'storage_limit'; end if;
    v_output:=gen_random_uuid();
    insert into public.studio_assets(id,project_id,owner_id,local_id,kind,mime,size,path,upload_expires_at)
      values(v_output,v_project.id,owner,v_job.id,'video','video/mp4',20971520,owner::text||'/'||v_project.id::text||'/'||v_output::text,now()+interval '20 minutes');
    insert into public.studio_render_attempts(job_id,snapshot,inputs,output_id) values(v_job.id,v_project.manifest,v_inputs,v_output) returning * into v_attempt;
    update public.studio_render_jobs j set status='queued',error_code=null,updated_at=now() where j.id=v_job.id;
    return jsonb_build_object('jobId',v_job.id,'dispatchId',v_attempt.dispatch_id);
  end if;
  select * into v_job from public.studio_render_jobs j where j.id=(payload->>'jobId')::uuid and j.owner_id=owner;
  if not found then raise exception 'job_not_owned'; end if;
  select * into v_attempt from public.studio_render_attempts a where a.job_id=v_job.id;
  if not found then raise exception 'attempt_missing'; end if;
  if action='cancel' then
    if v_job.status in ('queued','rendering') then
      update public.studio_render_attempts a set cancel_requested=true where a.job_id=v_job.id;
      -- Queued work can be cancelled before claim. Keep execution barrier until hard deadline.
      update public.studio_render_jobs j set status=case when j.status='queued' then 'cancelled' else j.status end,error_code='CANCEL_REQUESTED',updated_at=now() where j.id=v_job.id;
    end if;
    return jsonb_build_object('requested',true,'execution',v_attempt.execution);
  end if;
  if action='dispatch-failed' then
    update public.studio_render_jobs j set status='failed',error_code='DISPATCH_UNCERTAIN_NO_RETRY',updated_at=now() where j.id=v_job.id and j.status='queued';
    return '{}'::jsonb;
  end if;
  if action not in ('claim','heartbeat','inputs','input','output','output-info','complete','failed','cancelled') then raise exception 'unsupported_action'; end if;
  -- Authenticated handler injects the HMAC nonce. Replay protection is durable.
  delete from public.studio_worker_nonces n where n.created_at<now()-interval '10 minutes';
  insert into public.studio_worker_nonces(nonce) values((payload->>'nonce')::uuid);
  if action='claim' then
    if not v_ready or v_job.status<>'queued' or v_attempt.dispatch_id<>(payload->>'dispatchId')::uuid or v_attempt.lease_token is not null or v_attempt.cancel_requested then raise exception 'claim_rejected'; end if;
    if length(payload->>'execution')>128 or (payload->>'execution')!~'^[a-z][a-z0-9-]+$' then raise exception 'invalid_execution'; end if;
    update public.studio_render_attempts a set lease_token=gen_random_uuid(),lease_expires_at=now()+interval '45 seconds',deadline=now()+interval '600 seconds',block_until=greatest(a.block_until,now()+interval '12 minutes'),execution=payload->>'execution' where a.job_id=v_job.id returning * into v_attempt;
    update public.studio_render_jobs j set status='rendering',execution_name=payload->>'execution',updated_at=now() where j.id=v_job.id;
    return jsonb_build_object('jobId',v_job.id,'projectId',v_job.project_id,'ownerId',owner,'lease',v_attempt.lease_token,'manifest',v_attempt.snapshot);
  end if;
  if v_attempt.lease_token is null or v_attempt.lease_token is distinct from (payload->>'lease')::uuid then raise exception 'lease_rejected'; end if;
  if action in ('failed','cancelled') then
    if v_job.status='rendering' then
      update public.studio_render_jobs j set status=case when v_attempt.cancel_requested or action='cancelled' then 'cancelled' else 'failed' end,
        error_code=case when v_attempt.cancel_requested or action='cancelled' then 'WORKER_STOPPED' else 'WORKER_FAILED' end,updated_at=now() where j.id=v_job.id;
    end if;
    update public.studio_render_attempts a set finished=true where a.job_id=v_job.id;
    update public.studio_assets a set state='failed' where a.id=v_attempt.output_id and a.state='uploading';
    return '{}'::jsonb;
  end if;
  if v_job.status<>'rendering' or v_attempt.lease_expires_at<=now() or v_attempt.deadline<=now() then raise exception 'lease_expired_or_terminal'; end if;
  if action='heartbeat' then
    update public.studio_render_attempts a set lease_expires_at=least(now()+interval '45 seconds',a.deadline) where a.job_id=v_job.id;
    update public.studio_render_jobs j set progress=greatest(j.progress,least(0.99,greatest(0,coalesce((payload->>'progress')::double precision,0)))),phase=payload->>'phase',updated_at=now() where j.id=v_job.id;
    return jsonb_build_object('cancel',v_attempt.cancel_requested or not v_ready);
  end if;
  if v_attempt.cancel_requested or not v_ready then raise exception 'cancel_or_approval_expired'; end if;
  if not exists(select 1 from storage.buckets b where b.id='studio-private' and not b.public and b.file_size_limit<=20971520) then raise exception 'private_bucket_required'; end if;
  if action='inputs' then return jsonb_build_object('assets',v_attempt.inputs); end if;
  if action='input' then
    select * into v_asset from public.studio_assets a where a.id=(payload->>'assetId')::uuid and a.owner_id=owner
      and a.id in (select (x->>'id')::uuid from jsonb_array_elements(v_attempt.inputs) x);
    if not found then raise exception 'input_not_owned'; end if;
    insert into public.studio_egress_reservations(owner_id,month) values(owner,date_trunc('month',now())::date) on conflict do nothing;
    update public.studio_egress_reservations e set bytes=e.bytes+v_asset.size*3 where e.owner_id=owner and e.month=date_trunc('month',now())::date and e.bytes+v_asset.size*3<=1073741824;
    if not found then raise exception 'egress_limit'; end if;
    return to_jsonb(v_asset);
  end if;
  if action='output' then
    if (payload->>'size')::bigint<=0 or (payload->>'size')::bigint>20971520 or v_attempt.output_size is not null then raise exception 'output_limit'; end if;
    update public.studio_render_attempts a set output_size=(payload->>'size')::bigint where a.job_id=v_job.id;
    select * into v_asset from public.studio_assets a where a.id=v_attempt.output_id and a.owner_id=owner;
    return to_jsonb(v_asset)||jsonb_build_object('size',(payload->>'size')::bigint);
  end if;
  if action='output-info' then
    if v_attempt.output_size is null then raise exception 'output_missing'; end if;
    select * into v_asset from public.studio_assets a where a.id=v_attempt.output_id and a.owner_id=owner;
    return jsonb_build_object('asset',to_jsonb(v_asset)||jsonb_build_object('size',v_attempt.output_size),'manifest',v_attempt.snapshot);
  end if;
  if action='complete' then
    -- Coordinator verifies signed HEAD against this server-reserved size first.
    if v_attempt.output_size is null then raise exception 'output_missing'; end if;
    update public.studio_assets a set size=v_attempt.output_size,state='ready' where a.id=v_attempt.output_id;
    update public.studio_render_jobs j set status='completed',progress=1,phase='completed',output_asset_id=v_attempt.output_id,error_code=null,updated_at=now() where j.id=v_job.id;
    update public.studio_render_attempts a set finished=true where a.job_id=v_job.id;
    return jsonb_build_object('outputId',v_attempt.output_id);
  end if;
  raise exception 'unsupported_action';
end $$;
revoke all on function public.studio_render_coordinate(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.studio_render_coordinate(text,uuid,jsonb) to service_role;
commit;
