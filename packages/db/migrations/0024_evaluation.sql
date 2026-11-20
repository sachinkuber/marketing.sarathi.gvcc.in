-- Up Migration
-- Agent quality-test runs (spec 11). Platform tables, not brand-scoped: nothing here carries a brand_id column.
-- subject_brand_id only names the brand whose data a run was tested against. mkt_app has no access; the owner
-- console reads through mkt_owner_view; writes come only from the ops superuser.

create table app.evaluation_run (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  version integer not null,
  files_hash text not null,
  sets_hash text not null,
  model text not null,
  subject_brand_id uuid references app.brand (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  passed boolean,
  hostile_total integer not null default 0,
  hostile_passed integer not null default 0,
  other_total integer not null default 0,
  other_passed integer not null default 0,
  -- Null when a price or the exchange rate was missing: an unknown cost is not zero.
  cost_usd_micros bigint,
  cost_inr_micros bigint,
  fx_rate_id uuid references app.fx_rate (id)
);

create table app.evaluation_result (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references app.evaluation_run (id),
  case_id text not null,
  hostile boolean not null,
  passed boolean not null,
  checks jsonb not null,
  judge_reason text,
  input_tokens integer not null,
  output_tokens integer not null,
  searches integer not null default 0,
  usd_micros bigint
);
create index evaluation_result_run on app.evaluation_result (run_id);

-- Dashboard candidates for new test cases (spec 11).
create table app.evaluation_case (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  subject_brand_id uuid references app.brand (id),
  status text not null check (status in ('candidate','exported','dropped')),
  body jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

alter table app.agent_definition_version add column evaluation_run_id uuid references app.evaluation_run (id);

revoke all on app.evaluation_run, app.evaluation_result, app.evaluation_case from public, mkt_app;
grant select on app.evaluation_run, app.evaluation_result, app.evaluation_case to mkt_owner_view;

-- Down Migration
alter table app.agent_definition_version drop column evaluation_run_id;
drop table app.evaluation_case;
drop table app.evaluation_result;
drop table app.evaluation_run;
