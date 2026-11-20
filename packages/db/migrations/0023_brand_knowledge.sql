-- Up Migration
-- The brand knowledge tables of Phase 2 (spec 7, database schema 10.1): what onboarding agents found, what the
-- owner decided, the verified facts and safety rules. All brand-scoped, with the same isolation as migration 0011.

create type app.onboarding_step as enum ('intake','research','profile','questionnaire','facts_rules','brief_choices','brief','done');
create type app.suggestion_step as enum ('profile','question','fact','rule','choice');
create type app.suggestion_confidence as enum ('found','assumed','unknown');
create type app.suggestion_decision as enum ('accepted','edited','rejected');
create type app.source_kind as enum ('site','social','search','document','competitor','owner_statement');
create type app.fact_status as enum ('active','expired','superseded');
create type app.safety_rule_kind as enum ('forbidden_topic','forbidden_claim','forbidden_word','competitor_not_named','tone_limit','pause_dates');

-- One row per brand.
create table app.onboarding (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  step app.onboarding_step not null default 'intake',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (brand_id),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id)
);

-- Owner uploads, kept in Postgres so backups and restore cover them.
create table app.brand_document (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  file_name text not null,
  media_type text not null check (media_type in ('application/pdf','image/png','image/jpeg','image/webp')),
  bytes bytea not null,
  size_bytes integer not null check (size_bytes <= 10485760),
  sha256 text not null,
  uploaded_by uuid not null references auth."user" (id),
  uploaded_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id)
);

-- Every source an agent read, and every owner statement.
create table app.research_source (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  run_id uuid,
  kind app.source_kind not null,
  address text,
  document_id uuid,
  read_at timestamptz not null default now(),
  result text not null,
  extract text not null,
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, run_id) references app.run (brand_id, id),
  foreign key (brand_id, document_id) references app.brand_document (brand_id, id)
);

-- The shared shape of spec section 5. A re-run inserts new rows and marks the old undecided ones superseded.
create table app.suggestion (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  run_id uuid,
  step app.suggestion_step not null,
  key text not null,
  proposed jsonb not null,
  why text not null,
  source_ids uuid[] not null default '{}',
  confidence app.suggestion_confidence not null,
  options jsonb,
  decision app.suggestion_decision,
  decided_value jsonb,
  decided_reason text,
  decided_by uuid references auth."user" (id),
  decided_at timestamptz,
  superseded_by uuid,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, run_id) references app.run (brand_id, id),
  foreign key (brand_id, superseded_by) references app.suggestion (brand_id, id)
);
create index suggestion_open on app.suggestion (brand_id, step, key) where decision is null and superseded_by is null;

create table app.profile_item (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  key text not null,
  value jsonb not null,
  status app.suggestion_confidence not null,
  source_ids uuid[] not null default '{}',
  from_suggestion uuid,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, from_suggestion) references app.suggestion (brand_id, id)
);

create table app.questionnaire (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  run_id uuid,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, run_id) references app.run (brand_id, id)
);

create table app.question (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  questionnaire_id uuid not null,
  key text not null,
  position integer not null,
  text text not null,
  why text not null,
  suggested_answer text,
  options jsonb,
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, questionnaire_id) references app.questionnaire (brand_id, id)
);

-- Answers save as typed, so a row is updated in place until the owner moves on.
create table app.answer (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  question_id uuid not null,
  value text not null,
  answered_by uuid not null references auth."user" (id),
  answered_at timestamptz not null default now(),
  unique (brand_id, id),
  unique (brand_id, question_id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, question_id) references app.question (brand_id, id)
);

-- Created only by the owner's confirm action; only status and superseded_by ever change.
create table app.verified_fact (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  statement text not null,
  fact_hash text not null,
  source_ids uuid[] not null,
  confirmed_by uuid not null references auth."user" (id),
  confirmed_at timestamptz not null default now(),
  review_date date not null,
  status app.fact_status not null default 'active',
  superseded_by uuid,
  from_suggestion uuid,
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, superseded_by) references app.verified_fact (brand_id, id),
  foreign key (brand_id, from_suggestion) references app.suggestion (brand_id, id)
);

-- Created only by the owner's confirm action; only active ever changes.
create table app.safety_rule (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  kind app.safety_rule_kind not null,
  text text not null,
  why text not null,
  active boolean not null default true,
  confirmed_by uuid not null references auth."user" (id),
  confirmed_at timestamptz not null default now(),
  from_suggestion uuid,
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, from_suggestion) references app.suggestion (brand_id, id)
);

create table app.agent_question (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  run_id uuid not null,
  job_id uuid not null,
  question text not null,
  why text not null,
  options jsonb,
  answer text,
  answered_by uuid references auth."user" (id),
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, run_id) references app.run (brand_id, id),
  foreign key (brand_id, job_id) references app.job_input (brand_id, job_id)
);

-- Row-level security: the same policy as migrations 0004 and 0011.
do $$
declare t text;
begin
  foreach t in array array['onboarding','brand_document','research_source','suggestion','profile_item','questionnaire','question','answer','verified_fact','safety_rule','agent_question']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format(
      'create policy brand_isolation on app.%I using (brand_id = nullif(current_setting(''app.brand_id'', true), '''')::uuid) with check (brand_id = nullif(current_setting(''app.brand_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;

grant select, insert, update on
  app.brand_document, app.questionnaire, app.question, app.answer, app.agent_question
  to mkt_app;
-- A suggestion's content is written once; only the decision and the superseded_by link are ever updated.
grant select, insert on app.suggestion to mkt_app;
grant update (decision, decided_value, decided_reason, decided_by, decided_at, superseded_by)
  on app.suggestion to mkt_app;
grant select, insert, update, delete on app.onboarding to mkt_app;
-- Written once; a fact or rule that changes is superseded, so only these columns are ever updated.
grant select, insert on app.research_source, app.profile_item, app.verified_fact, app.safety_rule to mkt_app;
grant update (status, superseded_by) on app.verified_fact to mkt_app;
grant update (active) on app.safety_rule to mkt_app;
grant select on
  app.onboarding, app.brand_document, app.research_source, app.suggestion, app.profile_item, app.questionnaire,
  app.question, app.answer, app.verified_fact, app.safety_rule, app.agent_question
  to mkt_readonly;

-- Down Migration
drop table app.agent_question;
drop table app.safety_rule;
drop table app.verified_fact;
drop table app.answer;
drop table app.question;
drop table app.questionnaire;
drop table app.profile_item;
drop table app.suggestion;
drop table app.research_source;
drop table app.brand_document;
drop table app.onboarding;
drop type app.safety_rule_kind, app.fact_status, app.source_kind, app.suggestion_decision,
  app.suggestion_confidence, app.suggestion_step, app.onboarding_step;
