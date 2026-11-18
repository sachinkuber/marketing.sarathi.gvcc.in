-- Up Migration
-- Milestone 7: the worker's heartbeat. The worker's timer calls the core, and the core stamps the worker's id and
-- the time here, so /health/worker can say whether the worker has been seen lately. Platform data: no brand_id,
-- outside row-level security. The application role reaches it only through the two definer functions below.

create table app.worker_heartbeat (
  worker_id text primary key constraint worker_heartbeat_id_length check (char_length(worker_id) <= 200),
  seen_at timestamptz not null
);
revoke all on app.worker_heartbeat from public;
grant select, insert, update on app.worker_heartbeat to mkt_definer;

-- Changing the owner needs the definer to hold create on the schema, for this migration only.
grant create on schema app to mkt_definer;

create function app.stamp_worker(p_worker_id text) returns void
language plpgsql security definer set search_path = pg_catalog, app
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) < 1 or char_length(p_worker_id) > 200 then
    raise exception 'a worker id is 1 to 200 characters' using errcode = '22023';
  end if;
  insert into app.worker_heartbeat (worker_id, seen_at) values (p_worker_id, now())
  on conflict (worker_id) do update set seen_at = excluded.seen_at;
end $$;
alter function app.stamp_worker(text) owner to mkt_definer;
revoke all on function app.stamp_worker(text) from public;
grant execute on function app.stamp_worker(text) to mkt_app;

create function app.worker_last_seen() returns timestamptz
language sql stable security definer set search_path = pg_catalog, app
as $$
  select max(seen_at) from app.worker_heartbeat
$$;
alter function app.worker_last_seen() owner to mkt_definer;
revoke all on function app.worker_last_seen() from public;
grant execute on function app.worker_last_seen() to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.worker_last_seen();
drop function app.stamp_worker(text);
drop table app.worker_heartbeat;
