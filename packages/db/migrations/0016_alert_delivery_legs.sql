-- Up Migration
-- Per-leg alert delivery: which owners were emailed and whether the second channel confirmed are kept, so a
-- retry sends only what is missing; retries back off and stop at a cap, and the stalled state is a column.

alter table app.alert add column mailed_to uuid[] not null default '{}';
alter table app.alert add column channel_confirmed_at timestamptz;
alter table app.alert add column last_attempt_at timestamptz;
alter table app.alert add column delivery_stalled boolean not null default false;
-- Why the last attempt did not finish: no_platform_owner, email, channel or email+channel. Names only.
alter table app.alert add column delivery_issue text;

grant create on schema app to mkt_definer;

drop function app.mark_alert_delivery(uuid, boolean);
create function app.mark_alert_delivery(
  p_alert uuid, p_mailed uuid[], p_channel boolean, p_issue text, p_at timestamptz, p_max integer
) returns void
language sql security definer set search_path = pg_catalog, app
as $$
  update app.alert a
     set mailed_to = (select coalesce(array_agg(distinct u), '{}') from unnest(a.mailed_to || p_mailed) u),
         channel_confirmed_at = case when p_channel then coalesce(a.channel_confirmed_at, p_at) else a.channel_confirmed_at end,
         delivery_attempts = least(a.delivery_attempts + 1, 32767),
         last_attempt_at = p_at,
         delivery_issue = p_issue,
         delivered_at = case when p_issue is null then coalesce(a.delivered_at, p_at) else a.delivered_at end,
         delivery_stalled = p_issue is not null and a.delivery_attempts + 1 >= p_max
   where a.id = p_alert
$$;
alter function app.mark_alert_delivery(uuid, uuid[], boolean, text, timestamptz, integer) owner to mkt_definer;
revoke all on function app.mark_alert_delivery(uuid, uuid[], boolean, text, timestamptz, integer) from public;
grant execute on function app.mark_alert_delivery(uuid, uuid[], boolean, text, timestamptz, integer) to mkt_app;

-- Alerts due a retry: not delivered, not resolved, not stalled, and past their backoff
-- (2^attempts minutes, at most 60) counted from the last attempt.
drop function app.undelivered_alerts(integer);
create function app.undelivered_alerts(p_limit integer, p_now timestamptz) returns setof app.alert
language sql stable security definer set search_path = pg_catalog, app
as $$
  select * from app.alert
   where delivered_at is null and resolved_at is null and not delivery_stalled
     and (last_attempt_at is null
          or last_attempt_at + make_interval(mins => least(power(2, delivery_attempts)::integer, 60)) <= p_now)
   order by raised_at, id limit p_limit
$$;
alter function app.undelivered_alerts(integer, timestamptz) owner to mkt_definer;
revoke all on function app.undelivered_alerts(integer, timestamptz) from public;
grant execute on function app.undelivered_alerts(integer, timestamptz) to mkt_app;

create function app.get_platform_alert(p_alert uuid) returns setof app.alert
language sql stable security definer set search_path = pg_catalog, app
as $$ select * from app.alert where id = p_alert and brand_id is null $$;
alter function app.get_platform_alert(uuid) owner to mkt_definer;
revoke all on function app.get_platform_alert(uuid) from public;
grant execute on function app.get_platform_alert(uuid) to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
grant create on schema app to mkt_definer;
drop function app.get_platform_alert(uuid);
drop function app.undelivered_alerts(integer, timestamptz);
create function app.undelivered_alerts(p_limit integer) returns setof app.alert
language sql stable security definer set search_path = pg_catalog, app
as $$ select * from app.alert where delivered_at is null and resolved_at is null order by raised_at, id limit p_limit $$;
alter function app.undelivered_alerts(integer) owner to mkt_definer;
revoke all on function app.undelivered_alerts(integer) from public;
grant execute on function app.undelivered_alerts(integer) to mkt_app;
drop function app.mark_alert_delivery(uuid, uuid[], boolean, text, timestamptz, integer);
create function app.mark_alert_delivery(p_alert uuid, p_delivered boolean) returns void
language sql security definer set search_path = pg_catalog, app
as $$
  update app.alert
     set delivery_attempts = least(delivery_attempts + 1, 32767),
         delivered_at = case when p_delivered then coalesce(delivered_at, now()) else delivered_at end
   where id = p_alert
$$;
alter function app.mark_alert_delivery(uuid, boolean) owner to mkt_definer;
revoke all on function app.mark_alert_delivery(uuid, boolean) from public;
grant execute on function app.mark_alert_delivery(uuid, boolean) to mkt_app;
revoke create on schema app from mkt_definer;
alter table app.alert drop column delivery_issue;
alter table app.alert drop column delivery_stalled;
alter table app.alert drop column last_attempt_at;
alter table app.alert drop column channel_confirmed_at;
alter table app.alert drop column mailed_to;
