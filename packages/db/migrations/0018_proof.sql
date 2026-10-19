-- Up Migration
-- Milestone 6: trigger nonces (database schema 8.3), the daily-duty log with the n8n heartbeat, the summary
-- agent's definition, the audit search the owner screen uses, and follow-up M-7 (an approved version has an
-- approving decision on record).

-- 1. Nonces of signed n8n triggers, so a replayed trigger is refused. Not brand-scoped.
create table app.trigger_nonce (
  nonce bytea primary key,
  received_at timestamptz not null default now()
);
grant select, insert, delete on app.trigger_nonce to mkt_app;

-- 2. One row per duty per day. The heartbeat is the row with duty = 'n8n_heartbeat'. Not brand-scoped.
create table app.duty_run (
  duty text not null,
  run_date date not null,
  state text not null constraint duty_run_state_check check (state in ('running', 'done', 'failed', 'not_configured')),
  detail jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (duty, run_date)
);
grant select, insert, update on app.duty_run to mkt_app;

-- 3. The summary agent's first definition. files_hash is a placeholder of 64 zeros: Task 2 of milestone 6
-- adds agents/summary/ and replaces it with the hash of those files.
insert into app.agent_definition_version (agent, version, model, effort, files_hash, live, released_at)
values ('summary', 1, 'claude-opus-5-5', 'low', repeat('0', 64), true, now());

-- 4. Follow-up M-7: awaiting_approval -> approved needs an approving decision for the version. Every edge of
-- the transition table and the same-state no-op are kept as in 0014.
create or replace function app.check_version_state_transition()
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
  if old.state = 'awaiting_approval' and new.state = 'approved' and not exists (
    select 1 from app.approval a
     where a.brand_id = new.brand_id and a.content_version_id = new.content_version_id and a.decision = 'approved'
  ) then
    raise exception 'a version cannot be approved without an approving decision on record' using errcode = '23514';
  end if;
  return new;
end $$;

-- 5. Audit search for the owner screen: newest first, one chain, optional filters, paged by sequence number.
grant create on schema audit to mkt_definer;

create function audit.search(
  p_chain text, p_actor uuid, p_action text, p_from timestamptz, p_to timestamptz, p_before_seq bigint, p_limit integer)
returns setof audit.log
language sql security definer stable set search_path = pg_catalog, audit
as $$
  select * from audit.log l
   where l.chain_key = p_chain
     and (p_actor is null or l.actor_id = p_actor)
     and (p_action is null or l.action = p_action)
     and (p_from is null or l.at >= p_from)
     and (p_to is null or l.at <= p_to)
     and (p_before_seq is null or l.seq < p_before_seq)
   order by l.seq desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
alter function audit.search(text, uuid, text, timestamptz, timestamptz, bigint, integer) owner to mkt_definer;
revoke all on function audit.search(text, uuid, text, timestamptz, timestamptz, bigint, integer) from public;
grant execute on function audit.search(text, uuid, text, timestamptz, timestamptz, bigint, integer) to mkt_owner_view;

revoke create on schema audit from mkt_definer;

-- Down Migration
drop function audit.search(text, uuid, text, timestamptz, timestamptz, bigint, integer);
-- The 0014 body.
create or replace function app.check_version_state_transition()
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
delete from app.agent_definition_version where agent = 'summary' and version = 1;
drop table app.duty_run;
drop table app.trigger_nonce;
