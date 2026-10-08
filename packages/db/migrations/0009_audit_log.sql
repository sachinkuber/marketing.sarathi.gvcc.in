-- Up Migration
-- The audit log (spec 12, architecture 13.8). Three layers: no run-time role holds any right on the tables, so
-- entries are written only through audit.append; a trigger refuses update, delete and truncate for everyone;
-- and each entry carries a hash that covers its content, its sequence number and the previous entry's hash.

-- The definer role (migration 0005) owns the functions. It may hold CREATE on the schema only while the
-- functions below change hands.
grant usage on schema audit to mkt_definer, mkt_app, mkt_audit_writer, mkt_owner_view;
grant create on schema audit to mkt_definer;
-- The audit-writer role must be able to name app.actor_kind when it calls audit.append. Schema usage lets it
-- look the type up; it still holds no right on any table in the schema.
grant usage on schema app to mkt_audit_writer;

create table audit.log (
  id uuid primary key default gen_random_uuid(),
  chain_key text not null,
  brand_id uuid,
  seq bigint not null check (seq >= 1),
  at timestamptz not null,
  actor_kind app.actor_kind not null,
  actor_id uuid,
  action text not null check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  outcome text not null check (outcome in ('success', 'failure')),
  subject text,
  detail jsonb,
  prev_hash text,
  hash text not null check (hash ~ '^sha256:[0-9a-f]{64}$'),
  unique (chain_key, seq),
  check ((chain_key = 'platform' and brand_id is null) or (brand_id is not null and chain_key = brand_id::text)),
  check ((seq = 1) = (prev_hash is null))
);

-- What has been copied to storage outside the server: the chain, how far, and the hash of the entry at
-- that point (spec 12, "Export job").
create table audit.export (
  id uuid primary key default gen_random_uuid(),
  chain_key text not null,
  through_seq bigint not null check (through_seq >= 1),
  chain_hash text not null check (chain_hash ~ '^sha256:[0-9a-f]{64}$'),
  exported_at timestamptz not null default now(),
  location text not null,
  unique (chain_key, through_seq)
);

grant select, insert on audit.log, audit.export to mkt_definer;

create function audit.refuse_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'the audit log is insert only' using errcode = '42501';
end $$;

create trigger log_no_change before update or delete on audit.log
  for each row execute function audit.refuse_change();
create trigger log_no_truncate before truncate on audit.log
  for each statement execute function audit.refuse_change();
create trigger export_no_change before update or delete on audit.export
  for each row execute function audit.refuse_change();
create trigger export_no_truncate before truncate on audit.export
  for each statement execute function audit.refuse_change();

-- The time of an entry as the hash sees it: UTC, to the microsecond. The export reads it through this function,
-- because a JavaScript Date keeps only milliseconds and an auditor holding the export must be able to
-- recompute each hash from it.
create function audit.at_text(p timestamptz)
returns text
language sql immutable set search_path = pg_catalog
as $$ select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') $$;
alter function audit.at_text(timestamptz) owner to mkt_definer;
revoke all on function audit.at_text(timestamptz) from public;
grant execute on function audit.at_text(timestamptz) to mkt_owner_view;

-- One definition of an entry's hash, used to append and to verify, so the two cannot drift. The input is the
-- jsonb text form of the array of the ten fields (chain key, sequence number, `at` as UTC to the microsecond,
-- actor kind, actor, action, outcome, subject, detail, previous hash), which writes each field and each null
-- unambiguously.
create function audit.entry_hash(
  p_chain_key text, p_seq bigint, p_at timestamptz, p_actor_kind app.actor_kind, p_actor_id uuid,
  p_action text, p_outcome text, p_subject text, p_detail jsonb, p_prev_hash text)
returns text
language sql stable set search_path = pg_catalog
as $$
  select 'sha256:' || encode(sha256(convert_to(jsonb_build_array(
    p_chain_key, p_seq, audit.at_text(p_at),
    p_actor_kind::text, p_actor_id, p_action, p_outcome, p_subject, p_detail, p_prev_hash)::text, 'UTF8')), 'hex')
$$;
alter function audit.entry_hash(text, bigint, timestamptz, app.actor_kind, uuid, text, text, text, jsonb, text)
  owner to mkt_definer;
revoke all on function audit.entry_hash(text, bigint, timestamptz, app.actor_kind, uuid, text, text, text, jsonb, text) from public;

-- Appends one entry to the brand's chain (or the platform chain when the brand is null). The advisory lock is
-- held until the caller's transaction ends, so two writers cannot extend the same previous entry, and a
-- rolled-back transaction leaves no gap. Called by the application role inside the transaction of the change
-- it records, and by the audit-writer role for entries that belong to no transaction.
-- Notes for callers:
--  * A caller at REPEATABLE READ or SERIALIZABLE may get 23505 on the unique (chain_key, seq) when its snapshot
--    predates another writer's entry. That fails closed (the entry is not written) and is harmless.
--  * A transaction that appends to two chains must do so in a fixed order (for example the brand chain, then
--    the platform chain), or two such transactions can deadlock on the advisory locks.
--  * The cross-brand guard below is defence in depth, not a boundary: the application role sets
--    app.brand_id itself, so it is only as strong as the code that sets it.
create function audit.append(
  p_brand uuid, p_actor_kind app.actor_kind, p_actor uuid,
  p_action text, p_outcome text, p_subject text, p_detail jsonb)
returns bigint
language plpgsql security definer set search_path = pg_catalog, audit
as $$
declare
  v_chain text := coalesce(p_brand::text, 'platform');
  v_set uuid := nullif(current_setting('app.brand_id', true), '')::uuid;
  v_seq bigint;
  v_prev text;
  v_at timestamptz;
begin
  -- A session working inside one brand cannot write another brand's chain.
  if v_set is not null and p_brand is not null and v_set <> p_brand then
    raise exception 'an audit entry for another brand cannot be written from this session' using errcode = '42501';
  end if;
  if p_brand is not null and not exists (select 1 from app.brand where id = p_brand) then
    raise exception 'unknown brand' using errcode = '23503';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('audit.log:' || v_chain, 0));
  -- Read the clock only once the lock is held, so `at` never runs backwards along a chain.
  v_at := clock_timestamp();
  select l.seq, l.hash into v_seq, v_prev from audit.log l where l.chain_key = v_chain order by l.seq desc limit 1;
  v_seq := coalesce(v_seq, 0) + 1;
  insert into audit.log (chain_key, brand_id, seq, at, actor_kind, actor_id, action, outcome, subject, detail, prev_hash, hash)
  values (v_chain, p_brand, v_seq, v_at, p_actor_kind, p_actor, p_action, p_outcome, p_subject, p_detail, v_prev,
          audit.entry_hash(v_chain, v_seq, v_at, p_actor_kind, p_actor, p_action, p_outcome, p_subject, p_detail, v_prev));
  return v_seq;
end $$;
alter function audit.append(uuid, app.actor_kind, uuid, text, text, text, jsonb) owner to mkt_definer;
revoke all on function audit.append(uuid, app.actor_kind, uuid, text, text, text, jsonb) from public;
grant execute on function audit.append(uuid, app.actor_kind, uuid, text, text, text, jsonb) to mkt_app, mkt_audit_writer;

revoke create on schema audit from mkt_definer;

-- Down Migration
drop function audit.append(uuid, app.actor_kind, uuid, text, text, text, jsonb);
drop function audit.entry_hash(text, bigint, timestamptz, app.actor_kind, uuid, text, text, text, jsonb, text);
drop function audit.at_text(timestamptz);
drop table audit.export;
drop table audit.log;
drop function audit.refuse_change();
revoke usage on schema app from mkt_audit_writer;
revoke usage on schema audit from mkt_definer, mkt_app, mkt_audit_writer, mkt_owner_view;
