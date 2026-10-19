-- Up Migration
-- Milestone 5: the database half of approvals (hash guard, state-transition guard, one open request per
-- version), the notification and alert tables (database schema 8.1, 8.2), and the support the kill switch
-- needs to hold a brand's jobs.

-- 1. A version's state moves only along the allowed transitions (architecture 8.2, spec 10.5). The list is
-- data, so the application can assert that its own copy equals the database's.
create table app.version_state_transition (
  from_state app.version_state not null,
  to_state app.version_state not null,
  primary key (from_state, to_state)
);
insert into app.version_state_transition (from_state, to_state) values
  ('draft', 'in_checks'),
  ('draft', 'superseded'),
  ('in_checks', 'check_failed'),
  ('in_checks', 'awaiting_approval'),
  ('in_checks', 'superseded'),
  ('check_failed', 'superseded'),
  ('awaiting_approval', 'approved'),
  ('awaiting_approval', 'rejected'),
  ('awaiting_approval', 'superseded'),
  ('approved', 'scheduled'),
  ('approved', 'superseded'),
  ('approved', 'invalidated'),
  ('scheduled', 'invalidated'),
  ('scheduled', 'published'),
  ('scheduled', 'publish_unknown'),
  ('publish_unknown', 'published'),
  ('publish_unknown', 'scheduled'),
  ('published', 'withdrawn');
-- Reference data: read by every role that reads states, written by migrations only.
grant select on app.version_state_transition to mkt_app, mkt_readonly, mkt_owner_view, mkt_definer, mkt_queue;

create function app.check_version_state_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'draft' then
      raise exception 'a version starts as draft, not %', new.state using errcode = '23514';
    end if;
    return new;
  end if;
  -- A touch that leaves the state alone (an updated_at refresh) is allowed and changes nothing.
  if new.state = old.state then
    return new;
  end if;
  if not exists (
    select 1 from app.version_state_transition t
     where t.from_state = old.state and t.to_state = new.state
  ) then
    raise exception 'a version cannot move from % to %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;

create trigger version_state_transition
  before insert or update on app.content_version_state
  for each row execute function app.check_version_state_transition();

-- 2. An approval names the real hash and scheme of its version (database schema 11.2).
create function app.check_approval_hash()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare v app.content_version%rowtype;
begin
  select * into v from app.content_version
   where brand_id = new.brand_id and id = new.content_version_id;
  if not found then
    raise exception 'the version does not exist' using errcode = '23514';
  end if;
  if new.hash_scheme <> v.hash_scheme then
    raise exception 'the approval names a different hash scheme than its version' using errcode = '23514';
  end if;
  if new.version_hash <> v.hash then
    raise exception 'the approval names a different hash than its version' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger approval_hash_matches
  before insert on app.approval
  for each row execute function app.check_approval_hash();

-- 3. A version has at most one request: 0003 already makes content_version_id unique, which is stricter than
-- "one open request", so nothing is added here.

-- 4. Phase 1 makes no outside call, so the only action kind is "none" (database schema 6.11).
alter table app.outbox_action add constraint outbox_action_kind_check check (kind in ('none'));

-- 5. The queue's id for a job, set when a release re-enqueues it.
alter table app.job_control add column queue_id uuid;

-- 6. Notifications (database schema 8.1).
create table app.notification (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  user_id uuid not null,
  kind text not null,
  channel text not null,
  subject_kind text,
  subject_id uuid,
  state app.notification_state not null default 'queued',
  attempts smallint not null default 0 check (attempts >= 0),
  provider_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  unique (brand_id, id)
);
create index notification_user_idx on app.notification (brand_id, user_id, created_at);

-- 7. Alerts (database schema 8.2). brand_id is null for a platform-level alert.
create table app.alert (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references app.brand (id),
  severity smallint not null check (severity between 1 and 3),
  kind text not null,
  detail jsonb,
  raised_at timestamptz not null default now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  unique (brand_id, id)
);
create index alert_open_idx on app.alert (brand_id, raised_at) where resolved_at is null;

alter table app.notification enable row level security;
alter table app.notification force row level security;
create policy brand_isolation on app.notification
  using (brand_id = nullif(current_setting('app.brand_id', true), '')::uuid)
  with check (brand_id = nullif(current_setting('app.brand_id', true), '')::uuid);

-- Written out rather than generated, because brand_id may be null here. The condition is the same as on every
-- other table: a null brand never equals the session's brand, so a brand session cannot read a platform alert
-- and cannot write one (nor turn a brand's alert into one).
alter table app.alert enable row level security;
alter table app.alert force row level security;
create policy brand_isolation on app.alert
  using (brand_id = nullif(current_setting('app.brand_id', true), '')::uuid)
  with check (brand_id = nullif(current_setting('app.brand_id', true), '')::uuid);

grant select, insert, update on app.notification, app.alert to mkt_app;
grant select on app.notification, app.alert to mkt_readonly;

-- 8. Definer functions.
grant create on schema app to mkt_definer;

-- Platform alerts: the owner reads them through this function only.
create policy definer_read_platform_alert on app.alert for select to mkt_definer using (brand_id is null);
grant select on app.alert to mkt_definer;

create function app.platform_alerts() returns setof app.alert
language sql stable security definer set search_path = pg_catalog, app
as $$ select * from app.alert where brand_id is null order by raised_at desc, id $$;
alter function app.platform_alerts() owner to mkt_definer;
revoke all on function app.platform_alerts() from public;
grant execute on function app.platform_alerts() to mkt_owner_view;

-- Holds (or, with hold false, releases) the unfinished jobs of one brand, optionally only those of one agent
-- (the agent of the job's run). Returns the ids of the jobs whose flag it changed. Finished jobs and dead jobs
-- are left alone.
create policy definer_read_run on app.run for select to mkt_definer using (true);
grant select on app.run to mkt_definer;
create policy definer_update_job_control on app.job_control for update to mkt_definer using (true) with check (true);
grant update on app.job_control to mkt_definer;

create function app.hold_brand_jobs(p_brand uuid, p_agent text, p_hold boolean) returns setof uuid
language plpgsql security definer set search_path = pg_catalog, app
as $$
begin
  -- The policies the definer holds see every brand, so the function itself keeps a caller to its own brand.
  if p_brand is distinct from nullif(current_setting('app.brand_id', true), '')::uuid then
    raise exception 'a session may hold or release only its own brand''s jobs' using errcode = '42501';
  end if;
  return query
  update app.job_control c set held = p_hold, updated_at = now()
    from app.job_input i, app.run r
   where i.job_id = c.job_id and r.id = i.run_id and r.brand_id = i.brand_id
     and c.brand_id = p_brand and i.brand_id = p_brand
     and i.finished_at is null and c.dead_at is null
     and (p_agent is null or r.agent = p_agent)
     and c.held is distinct from p_hold
  returning c.job_id;
end $$;
alter function app.hold_brand_jobs(uuid, text, boolean) owner to mkt_definer;
revoke all on function app.hold_brand_jobs(uuid, text, boolean) from public;
grant execute on function app.hold_brand_jobs(uuid, text, boolean) to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.hold_brand_jobs(uuid, text, boolean);
drop policy definer_update_job_control on app.job_control;
revoke update on app.job_control from mkt_definer;
drop policy definer_read_run on app.run;
revoke select on app.run from mkt_definer;
drop function app.platform_alerts();
drop table app.alert;
drop table app.notification;
alter table app.job_control drop column queue_id;
alter table app.outbox_action drop constraint outbox_action_kind_check;
drop trigger approval_hash_matches on app.approval;
drop function app.check_approval_hash();
drop trigger version_state_transition on app.content_version_state;
drop function app.check_version_state_transition();
drop table app.version_state_transition;
