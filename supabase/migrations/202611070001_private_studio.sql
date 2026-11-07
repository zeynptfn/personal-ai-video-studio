-- Apply manually only to a dedicated, reviewed Supabase FREE organization.
-- This migration creates metadata and a PRIVATE bucket, not compute or rendering.
-- No public/anon/authenticated policies: only the existing studio server may call RPC.
begin;
create table public.studio_cloud_control (
  singleton boolean primary key default true check (singleton),
  owner_id uuid not null,
  storage_review_expires_at timestamptz,
  -- Not a billing lock. Owner must review Free/no-upgrade status before setting.
  created_at timestamptz not null default now()
);
create table public.studio_projects (
  id uuid primary key,
  owner_id uuid not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 32768),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.studio_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.studio_projects(id),
  owner_id uuid not null,
  local_id uuid not null,
  kind text not null check (kind in ('video','audio','image','manifest')),
  mime text not null,
  size bigint not null check (size > 0 and size <= 20971520),
  path text not null unique,
  state text not null default 'uploading' check (state in ('uploading','ready','failed')),
  upload_expires_at timestamptz not null default now() + interval '5 minutes',
  created_at timestamptz not null default now()
);
create table public.studio_render_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.studio_projects(id),
  owner_id uuid not null,
  status text not null default 'draft' check (status in ('draft','uploading','queued','rendering','completed','failed','cancelled')),
  output_asset_id uuid references public.studio_assets(id),
  error_code text,
  updated_at timestamptz not null default now(),
  check (status <> 'completed' or output_asset_id is not null)
);
create unique index studio_single_active_render on public.studio_render_jobs(owner_id) where status in ('queued','rendering');
create table public.studio_egress_reservations (
  owner_id uuid not null,
  month date not null,
  bytes bigint not null default 0,
  primary key(owner_id,month)
);
alter table public.studio_cloud_control enable row level security;
alter table public.studio_projects enable row level security;
alter table public.studio_assets enable row level security;
alter table public.studio_render_jobs enable row level security;
alter table public.studio_egress_reservations enable row level security;
revoke all on public.studio_cloud_control, public.studio_projects, public.studio_assets, public.studio_render_jobs, public.studio_egress_reservations from public, anon, authenticated;
-- No client table access, including with a Supabase publishable key.

create function public.studio_coordinate(action text, owner uuid, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  control public.studio_cloud_control;
  project public.studio_projects;
  asset public.studio_assets;
  v_project_id uuid;
  v_asset_id uuid;
  total bigint;
  used bigint;
  month_start date := date_trunc('month',now())::date;
begin
  -- A transaction-scoped lock serializes reservation/save races across Vercel instances.
  perform pg_advisory_xact_lock(734921);
  select * into control from public.studio_cloud_control where singleton;
  if control.owner_id is distinct from owner or control.storage_review_expires_at is null or control.storage_review_expires_at <= now()
    or control.storage_review_expires_at > now()+interval '24 hours' then
    raise exception 'cloud_review_required';
  end if;
  if not exists(select 1 from storage.buckets b where b.id='studio-private' and b.public=false and b.file_size_limit <= 20971520) then
    raise exception 'private_bucket_required';
  end if;
  if action = 'list' then
    -- Browser closure must not leave an invented active upload indefinitely.
    with expired as (
      update public.studio_assets a set state='failed'
      where a.owner_id=owner and a.state='uploading' and a.upload_expires_at <= now()
      returning a.project_id
    )
    update public.studio_render_jobs j set status='failed',error_code='UPLOAD_CONFIRMATION_EXPIRED',updated_at=now()
    where j.owner_id=owner and j.status='uploading' and j.project_id in (select e.project_id from expired e);
    return jsonb_build_object(
      'projects',coalesce((select jsonb_agg(to_jsonb(p) order by p.updated_at desc) from public.studio_projects p where p.owner_id=owner),'[]'::jsonb),
      'assets',coalesce((select jsonb_agg(to_jsonb(a)) from public.studio_assets a where a.owner_id=owner),'[]'::jsonb),
      'jobs',coalesce((select jsonb_agg(to_jsonb(j)) from public.studio_render_jobs j where j.owner_id=owner),'[]'::jsonb));
  end if;
  if action = 'save' then
    v_project_id := (payload->>'id')::uuid;
    select * into project from public.studio_projects p where p.id=v_project_id;
    if found then
      if project.owner_id <> owner or project.revision <> (payload->>'revision')::integer then raise exception 'ownership_or_revision_conflict'; end if;
      if exists(select 1 from public.studio_render_jobs j where j.project_id=v_project_id and j.status not in ('draft','uploading') and not (j.status='failed' and j.error_code='UPLOAD_CONFIRMATION_EXPIRED')) then raise exception 'project_locked'; end if;
      update public.studio_render_jobs j set status='draft',error_code=null,updated_at=now() where j.project_id=v_project_id and j.status='failed' and j.error_code='UPLOAD_CONFIRMATION_EXPIRED';
      update public.studio_projects p set manifest=payload->'manifest', revision=p.revision+1, updated_at=now() where p.id=v_project_id returning * into project;
    else
      if (payload->>'revision')::integer <> 0 or (select count(*) from public.studio_projects p where p.owner_id=owner) >= 20 then raise exception 'project_limit'; end if;
      insert into public.studio_projects(id,owner_id,manifest) values(v_project_id,owner,payload->'manifest') returning * into project;
      insert into public.studio_render_jobs(project_id,owner_id) values(v_project_id,owner);
    end if;
    return to_jsonb(project);
  end if;
  if action = 'reserve' then
    v_project_id := (payload->>'projectId')::uuid;
    select * into project from public.studio_projects p where p.id=v_project_id and p.owner_id=owner;
    if not found then raise exception 'not_found'; end if;
    if not exists(select 1 from public.studio_render_jobs j where j.project_id=v_project_id and j.status in ('draft','uploading')) then raise exception 'project_locked'; end if;
    select coalesce(sum(a.size),0) into total from public.studio_assets a; -- Dedicated project: global cap, reservations included.
    if total+(payload->>'size')::bigint > 419430400 or (select count(*) from public.studio_assets) >= 100
      or (select count(*) from public.studio_assets a where a.created_at > now()-interval '1 day') >= 30 then raise exception 'storage_limit'; end if;
    v_asset_id := gen_random_uuid();
    insert into public.studio_assets(id,project_id,owner_id,local_id,kind,mime,size,path)
    values(v_asset_id,v_project_id,owner,(payload->>'localId')::uuid,payload->>'kind',payload->>'mime',(payload->>'size')::bigint,owner::text||'/'||v_project_id::text||'/'||v_asset_id::text) returning * into asset;
    update public.studio_render_jobs j set status='uploading',updated_at=now() where j.project_id=v_project_id;
    return to_jsonb(asset);
  end if;
  if action in ('asset','complete','read') then
    select * into asset from public.studio_assets a where a.id=(payload->>'id')::uuid and a.owner_id=owner;
    if not found then raise exception 'not_found'; end if;
    if action = 'complete' then
      if asset.state='failed' then raise exception 'upload_confirmation_expired'; end if;
      -- Only the server calls after a signed HEAD checks stored MIME and size.
      update public.studio_assets a set state='ready' where a.id=asset.id returning * into asset;
      if not exists(select 1 from public.studio_assets a where a.project_id=asset.project_id and a.state='uploading') then
        update public.studio_render_jobs j set status='draft',updated_at=now() where j.project_id=asset.project_id and j.status='uploading';
      end if;
    elsif action = 'read' then
      if asset.state <> 'ready' then raise exception 'asset_not_ready'; end if;
      insert into public.studio_egress_reservations(owner_id,month) values(owner,month_start) on conflict do nothing;
      select e.bytes into used from public.studio_egress_reservations e where e.owner_id=owner and e.month=month_start;
      -- Conservative issuance budget; replay/ranges are not a provider-enforced egress cap.
      if used+asset.size*3 > 1073741824 then raise exception 'egress_limit'; end if;
      update public.studio_egress_reservations e set bytes=e.bytes+asset.size*3 where e.owner_id=owner and e.month=month_start;
    end if;
    return to_jsonb(asset);
  end if;
  raise exception 'unsupported_action'; -- No enqueue/worker transition exists in this release.
end $$;
revoke all on function public.studio_coordinate(text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.studio_coordinate(text,uuid,jsonb) to service_role;

-- Abort rather than silently changing an existing public bucket or its contents.
do $$ begin
  if exists(select 1 from storage.buckets where id='studio-private') then raise exception 'bucket_already_exists_review_manually'; end if;
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values (
  'studio-private','studio-private',false,20971520,
  array['video/mp4','audio/mpeg','audio/wav','audio/x-wav','audio/mp4','audio/x-m4a','image/png','image/jpeg','image/webp','application/json']
);
-- Intentionally no owner/control row: default is fail-closed until manual Free-plan review.
commit;
