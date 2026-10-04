-- Up Migration
create type app.brand_status as enum ('onboarding','active','paused','offboarding','closed');
create type app.membership_role as enum ('brand_admin','approver','sales_contact','viewer');
create type app.content_kind as enum ('summary','article','answer_page','social_post','carousel','short_video','long_video','email','ad','landing_page','reply','strategy_brief','campaign','correction');
create type app.version_state as enum ('draft','in_checks','check_failed','awaiting_approval','approved','rejected','superseded','invalidated','scheduled','publish_unknown','published','withdrawn');
create type app.check_kind as enum ('blocking','score');
create type app.approval_decision as enum ('approved','rejected','changes_requested');
create type app.run_state as enum ('created','running','succeeded','failed','needs_manual','cancelled','held');
create type app.job_class as enum ('interactive','publishing','production','bulk');
create type app.attempt_state as enum ('active','succeeded','failed','superseded');
create type app.model_call_status as enum ('started','succeeded','failed','unknown');
create type app.kill_scope as enum ('brand','channel','agent');
create type app.action_state as enum ('pending','submitted','confirmed','failed','unknown');
create type app.notification_state as enum ('queued','sent','delivered','failed');
create type app.popup_choice as enum ('review_now','later');
create type app.actor_kind as enum ('user','agent','system','n8n');
create extension if not exists citext;
create extension if not exists pgcrypto;

create table app.brand (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status app.brand_status not null default 'onboarding',
  shadow_mode boolean not null default false,
  schedule_key uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.platform_owner (
  user_id uuid primary key,
  granted_at timestamptz not null default now(),
  granted_by uuid
);

create table app.membership (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  user_id uuid not null,
  role app.membership_role not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (brand_id, id),
  unique (brand_id, user_id)
);
create index membership_user_idx on app.membership (user_id);

create table app.invite (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  email citext not null,
  role app.membership_role not null,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  invited_by uuid not null,
  created_at timestamptz not null default now(),
  unique (brand_id, id)
);

create table app.approval_setting (
  brand_id uuid primary key references app.brand (id),
  first_reminder_after interval not null default interval '24 hours',
  reminder_gap interval not null default interval '24 hours',
  reminder_count smallint not null default 3 check (reminder_count between 1 and 5),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table app.kill_switch (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  scope app.kill_scope not null,
  target text,
  active boolean not null,
  set_by uuid not null,
  set_at timestamptz not null default now(),
  released_by uuid,
  released_at timestamptz,
  unique (brand_id, id),
  check ((scope = 'brand') = (target is null))
);
create unique index kill_switch_one_active
  on app.kill_switch (brand_id, scope, coalesce(target, '')) where active;

-- Down Migration
drop table app.kill_switch;
drop table app.approval_setting;
drop table app.invite;
drop table app.membership;
drop table app.platform_owner;
drop table app.brand;
drop type app.actor_kind, app.popup_choice, app.notification_state, app.action_state, app.kill_scope,
  app.model_call_status, app.attempt_state, app.job_class, app.run_state, app.approval_decision,
  app.check_kind, app.version_state, app.content_kind, app.membership_role, app.brand_status;
