-- Up Migration
-- Milestone 6, follow-up M-4: a notification whose send failed waits before it is tried again. The wait
-- (2^attempts minutes, at most 60) is worked out by the service; the column holds when the notification is next
-- due, and pending_notifications() skips the rows not yet due. A null value is due at once, so every row that
-- exists now (including those already failed) keeps its present meaning.

alter table app.notification add column next_attempt_at timestamptz;

grant create on schema app to mkt_definer;

-- Queued notifications still under the attempt limit and due at p_now, across brands, oldest first. The
-- two-argument version of 0015 is replaced, since a function cannot change its arguments.
drop function app.pending_notifications(integer, integer);
create function app.pending_notifications(p_limit integer, p_max_attempts integer, p_now timestamptz)
returns table (id uuid, brand_id uuid)
language sql stable security definer set search_path = pg_catalog, app
as $$
  select n.id, n.brand_id from app.notification n
   where n.state = 'queued' and n.attempts < p_max_attempts
     and (n.next_attempt_at is null or n.next_attempt_at <= p_now)
   order by n.created_at, n.id limit p_limit
$$;
alter function app.pending_notifications(integer, integer, timestamptz) owner to mkt_definer;
revoke all on function app.pending_notifications(integer, integer, timestamptz) from public;
grant execute on function app.pending_notifications(integer, integer, timestamptz) to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.pending_notifications(integer, integer, timestamptz);
-- The 0015 body.
grant create on schema app to mkt_definer;
create function app.pending_notifications(p_limit integer, p_max_attempts integer)
returns table (id uuid, brand_id uuid)
language sql stable security definer set search_path = pg_catalog, app
as $$
  select n.id, n.brand_id from app.notification n
   where n.state = 'queued' and n.attempts < p_max_attempts
   order by n.created_at, n.id limit p_limit
$$;
alter function app.pending_notifications(integer, integer) owner to mkt_definer;
revoke all on function app.pending_notifications(integer, integer) from public;
grant execute on function app.pending_notifications(integer, integer) to mkt_app;
revoke create on schema app from mkt_definer;
alter table app.notification drop column next_attempt_at;
