-- Up Migration
create table app.content_item (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  kind app.content_kind not null,
  current_version_id uuid,
  created_at timestamptz not null default now(),
  unique (brand_id, id)
);

create table app.content_version (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  content_item_id uuid not null,
  number integer not null check (number >= 1),
  payload_canonical text not null,
  hash text not null,
  hash_scheme text not null,
  provenance jsonb,
  created_by_kind app.actor_kind not null,
  created_by_user uuid,
  created_by_run uuid,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  unique (content_item_id, number),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_item_id) references app.content_item (brand_id, id)
);
create index content_version_item_idx on app.content_version (brand_id, content_item_id, number);

alter table app.content_item
  add constraint content_item_current_version_fk
  foreign key (brand_id, current_version_id) references app.content_version (brand_id, id)
  deferrable initially deferred;

create table app.content_version_state (
  content_version_id uuid primary key,
  brand_id uuid not null,
  state app.version_state not null,
  updated_at timestamptz not null default now(),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id)
);
create index content_version_state_idx on app.content_version_state (brand_id, state);

create table app.content_version_state_change (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  content_version_id uuid not null,
  from_state app.version_state,
  to_state app.version_state not null,
  cause text not null,
  actor_kind app.actor_kind not null,
  actor_id uuid,
  at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id)
);

create table app.asset (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references app.brand (id),
  sha256 text not null,
  byte_length bigint not null check (byte_length >= 0),
  mime text not null,
  storage_key text not null,
  ai_generated boolean not null,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  unique (brand_id, sha256)
);

create table app.check_result (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  content_version_id uuid not null,
  check_name text not null,
  kind app.check_kind not null,
  passed boolean,
  score smallint check (score between 1 and 5),
  not_applicable boolean not null default false,
  not_applicable_reason text,
  confidence smallint check (confidence between 0 and 100),
  detail jsonb,
  definition_version_id uuid,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id),
  check (not_applicable = false or not_applicable_reason is not null),
  check (
    (kind = 'blocking' and passed is not null and score is null)
    or (kind = 'score' and (score is not null or not_applicable))
  )
);

create table app.approval (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  content_version_id uuid not null,
  version_hash text not null,
  hash_scheme text not null,
  decision app.approval_decision not null,
  decided_by uuid not null,
  comment text,
  decided_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id)
);

create table app.approval_invalidation (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  approval_id uuid not null unique,
  reason text not null,
  at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, approval_id) references app.approval (brand_id, id)
);

create table app.approval_request (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  content_version_id uuid not null unique,
  requested_at timestamptz not null default now(),
  reminders_sent smallint not null default 0,
  last_reminder_at timestamptz,
  escalated_at timestamptz,
  escalated_to uuid,
  overdue boolean not null default false,
  closed_at timestamptz,
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id)
);
create index approval_request_open_idx on app.approval_request (brand_id) where closed_at is null;
create index approval_request_overdue_idx on app.approval_request (brand_id) where overdue;

create table app.popup_ack (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  user_id uuid not null,
  approval_request_id uuid not null,
  choice app.popup_choice not null,
  at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, approval_request_id) references app.approval_request (brand_id, id)
);

create table app.outbox_action (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  kind text not null,
  content_version_id uuid,
  approval_id uuid,
  state app.action_state not null default 'pending',
  idempotency_key uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, id),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, content_version_id) references app.content_version (brand_id, id),
  foreign key (brand_id, approval_id) references app.approval (brand_id, id)
);

-- Down Migration
drop table app.outbox_action, app.popup_ack, app.approval_request, app.approval_invalidation, app.approval,
  app.check_result, app.asset, app.content_version_state_change, app.content_version_state;
alter table app.content_item drop constraint content_item_current_version_fk;
drop table app.content_version, app.content_item;
