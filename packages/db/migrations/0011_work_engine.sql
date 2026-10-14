-- Up Migration
-- The tables of database schema 7 (jobs, attempts, model calls, cost). The queue's own tables are the
-- library's, in schema pgboss, installed at deployment.

create table app.agent_definition_version (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  version integer not null,
  model text not null,
  effort text not null,
  files_hash text not null,
  live boolean not null default false,
  released_by uuid,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent, version)
);
create unique index agent_definition_one_live on app.agent_definition_version (agent) where live;

create table app.run (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  agent text not null,
  definition_version_id uuid not null references app.agent_definition_version (id),
  state app.run_state not null default 'created',
  started_by_kind app.actor_kind not null,
  started_by_id uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id)
);

-- expected_result_type, result_type, outcome, held_result and finished_at are additions to the spec's columns (plan decision 4).
create table app.job_input (
  job_id uuid primary key,
  brand_id uuid not null,
  run_id uuid not null,
  class app.job_class not null,
  input jsonb not null,
  saved_steps jsonb not null default '[]'::jsonb,
  expected_result_type text not null,
  result_type text,
  result_hash text,
  outcome jsonb,
  held_result jsonb,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (brand_id, job_id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, run_id) references app.run (brand_id, id)
);

create table app.job_attempt (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  job_id uuid not null,
  attempt_number integer not null,
  worker_id text not null,
  token_id uuid not null unique,
  state app.attempt_state not null default 'active',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (job_id, attempt_number),
  unique (brand_id, id),
  foreign key (brand_id, job_id) references app.job_input (brand_id, job_id)
);
create unique index job_attempt_one_active on app.job_attempt (job_id) where state = 'active';

create table app.job_control (
  job_id uuid primary key,
  brand_id uuid not null,
  cancel_requested boolean not null default false,
  held boolean not null default false,
  dead_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (brand_id, job_id) references app.job_input (brand_id, job_id)
);

create table app.fx_rate (
  id uuid primary key default gen_random_uuid(),
  rate_date date not null,
  base_currency text not null default 'USD',
  quote_currency text not null default 'INR',
  rate_micros bigint not null check (rate_micros > 0),
  source text not null,
  fetched_at timestamptz not null default now(),
  unique (rate_date, base_currency, quote_currency)
);

create table app.model_call (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  run_id uuid not null,
  job_id uuid not null,
  attempt_id uuid not null,
  step text not null,
  request_hash text not null,
  status app.model_call_status not null default 'started',
  possible_duplicate boolean not null default false,
  provider_message_id text,
  provider_request_id text,
  model text not null,
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  cache_read_tokens integer check (cache_read_tokens >= 0),
  cache_write_tokens integer check (cache_write_tokens >= 0),
  charged_micros bigint check (charged_micros >= 0),
  charged_currency text,
  usd_micros bigint check (usd_micros >= 0),
  inr_micros bigint check (inr_micros >= 0),
  fx_rate_id uuid references app.fx_rate (id),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, run_id) references app.run (brand_id, id),
  foreign key (brand_id, job_id) references app.job_input (brand_id, job_id),
  foreign key (brand_id, attempt_id) references app.job_attempt (brand_id, id)
);
create index model_call_duplicate_check on app.model_call (job_id, step, request_hash);
create index model_call_reconcile on app.model_call (status, started_at);

create table app.cost_ledger (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  run_id uuid,
  agent text not null,
  deliverable text,
  model_call_id uuid,
  charged_micros bigint not null check (charged_micros >= 0),
  charged_currency text not null,
  usd_micros bigint not null check (usd_micros >= 0),
  inr_micros bigint not null check (inr_micros >= 0),
  fx_rate_id uuid not null references app.fx_rate (id),
  at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, run_id) references app.run (brand_id, id),
  foreign key (brand_id, model_call_id) references app.model_call (brand_id, id)
);
create unique index cost_ledger_one_per_call on app.cost_ledger (model_call_id) where model_call_id is not null;
create index cost_ledger_brand_at on app.cost_ledger (brand_id, at);

-- Row-level security on the new brand tables, the same policy as migration 0004.
do $$
declare t text;
begin
  foreach t in array array['run','job_input','job_attempt','job_control','model_call','cost_ledger']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format(
      'create policy brand_isolation on app.%I using (brand_id = nullif(current_setting(''app.brand_id'', true), '''')::uuid) with check (brand_id = nullif(current_setting(''app.brand_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;

grant select, insert, update, delete on app.run, app.job_input, app.job_attempt, app.job_control, app.model_call to mkt_app;
-- A cost row is written once.
grant select, insert on app.cost_ledger to mkt_app;
-- Shared reference data: read by the application; written by the release step and by named functions only.
grant select on app.agent_definition_version, app.fx_rate to mkt_app, mkt_readonly, mkt_owner_view;
grant select on app.run, app.job_input, app.job_attempt, app.job_control, app.model_call, app.cost_ledger to mkt_readonly;

-- Definer functions: work that has no brand yet, or crosses brands.
grant create on schema app to mkt_definer;

create policy definer_read_job_input on app.job_input for select to mkt_definer using (true);
grant select on app.job_input to mkt_definer;

create function app.job_brand(p_job uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, app
as $$ select brand_id from app.job_input where job_id = p_job $$;
alter function app.job_brand(uuid) owner to mkt_definer;
revoke all on function app.job_brand(uuid) from public;
grant execute on function app.job_brand(uuid) to mkt_app;

create policy definer_update_model_call on app.model_call for update to mkt_definer using (true) with check (true);
create policy definer_read_model_call on app.model_call for select to mkt_definer using (true);
grant select, update on app.model_call to mkt_definer;

-- Marks calls of one job class still "started" from before the cutoff as "unknown" (spec 9.5, reconciliation:
-- older than the class's expiry, so the caller passes one cutoff per class).
create function app.sweep_model_calls(p_class app.job_class, p_cutoff timestamptz) returns integer
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare n integer;
begin
  update app.model_call m set status = 'unknown', finished_at = now()
    from app.job_input j
   where j.job_id = m.job_id and j.class = p_class
     and m.status = 'started' and m.started_at < p_cutoff;
  get diagnostics n = row_count;
  return n;
end $$;
alter function app.sweep_model_calls(app.job_class, timestamptz) owner to mkt_definer;
revoke all on function app.sweep_model_calls(app.job_class, timestamptz) from public;
grant execute on function app.sweep_model_calls(app.job_class, timestamptz) to mkt_app;

-- One rate a day; entering the same day again replaces nothing and returns the stored row.
create function app.record_fx_rate(p_date date, p_rate_micros bigint, p_source text) returns uuid
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare r uuid;
begin
  insert into app.fx_rate (rate_date, rate_micros, source) values (p_date, p_rate_micros, p_source)
  on conflict (rate_date, base_currency, quote_currency) do nothing
  returning id into r;
  if r is null then
    select id into r from app.fx_rate
     where rate_date = p_date and base_currency = 'USD' and quote_currency = 'INR';
  end if;
  return r;
end $$;
alter function app.record_fx_rate(date, bigint, text) owner to mkt_definer;
revoke all on function app.record_fx_rate(date, bigint, text) from public;
grant execute on function app.record_fx_rate(date, bigint, text) to mkt_owner_view;

grant select, insert on app.fx_rate to mkt_definer;
revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.record_fx_rate(date, bigint, text);
drop function app.sweep_model_calls(app.job_class, timestamptz);
drop function app.job_brand(uuid);
drop table app.cost_ledger;
drop table app.model_call;
drop table app.fx_rate;
drop table app.job_control;
drop table app.job_attempt;
drop table app.job_input;
drop table app.run;
drop table app.agent_definition_version;
