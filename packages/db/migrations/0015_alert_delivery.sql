-- Up Migration
-- Milestone 5, notification and alert delivery. Alerts gain a delivery state and a dedupe key, and the
-- functions the service needs for the reads and writes that cross brands (a platform alert has no brand; the
-- retry of undelivered alerts, the pending notifications and the operational findings span every brand).

alter table app.alert add column delivered_at timestamptz;
alter table app.alert add column delivery_attempts smallint not null default 0 check (delivery_attempts >= 0);

-- At most one unresolved alert per (brand or platform, kind, detail.ref), so a recurring check cannot flood.
create unique index alert_open_ref_unique on app.alert
  (coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, (detail ->> 'ref'))
  where resolved_at is null and detail ? 'ref';
create index alert_undelivered_idx on app.alert (raised_at) where delivered_at is null and resolved_at is null;
create index notification_queued_idx on app.notification (created_at) where state = 'queued';

grant create on schema app to mkt_definer;

create policy definer_alert on app.alert for all to mkt_definer using (true) with check (true);
grant select, insert, update on app.alert to mkt_definer;
create policy definer_read_notification on app.notification for select to mkt_definer using (true);
grant select on app.notification to mkt_definer;
create policy definer_read_job_attempt on app.job_attempt for select to mkt_definer using (true);
grant select on app.job_attempt to mkt_definer;

-- Raises an alert. A brand alert is raised only from that brand's own session (like hold_brand_jobs); a null
-- brand is a platform alert. Returns the new id, or null when an unresolved alert with the same
-- (brand, kind, detail.ref) already exists.
create function app.raise_alert(p_brand uuid, p_severity smallint, p_kind text, p_detail jsonb) returns uuid
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare a uuid;
begin
  if p_brand is not null and p_brand is distinct from nullif(current_setting('app.brand_id', true), '')::uuid then
    raise exception 'a session may raise an alert only for its own brand' using errcode = '42501';
  end if;
  insert into app.alert (brand_id, severity, kind, detail) values (p_brand, p_severity, p_kind, p_detail)
  on conflict do nothing
  returning id into a;
  return a;
end $$;
alter function app.raise_alert(uuid, smallint, text, jsonb) owner to mkt_definer;
revoke all on function app.raise_alert(uuid, smallint, text, jsonb) from public;
grant execute on function app.raise_alert(uuid, smallint, text, jsonb) to mkt_app;

-- The alerts still waiting for a confirmed delivery, across brands, oldest first.
create function app.undelivered_alerts(p_limit integer) returns setof app.alert
language sql stable security definer set search_path = pg_catalog, app
as $$ select * from app.alert where delivered_at is null and resolved_at is null order by raised_at, id limit p_limit $$;
alter function app.undelivered_alerts(integer) owner to mkt_definer;
revoke all on function app.undelivered_alerts(integer) from public;
grant execute on function app.undelivered_alerts(integer) to mkt_app;

-- Counts one delivery attempt on an alert and, when it was confirmed, stamps it delivered. Touches nothing else.
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

-- The service's own read of platform alerts for the platform owner's screen. The route is guarded by the
-- platform-owner check; platform_alerts() stays for the owner-view role.
create function app.list_platform_alerts() returns setof app.alert
language sql stable security definer set search_path = pg_catalog, app
as $$ select * from app.alert where brand_id is null order by raised_at desc, id limit 200 $$;
alter function app.list_platform_alerts() owner to mkt_definer;
revoke all on function app.list_platform_alerts() from public;
grant execute on function app.list_platform_alerts() to mkt_app;

-- Acknowledges a platform alert. found: it exists; newly: this call set the acknowledgement.
create function app.ack_platform_alert(p_alert uuid, p_user uuid) returns table (found boolean, newly boolean)
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare n integer;
begin
  if not app.is_platform_owner(p_user) then
    raise exception 'only a platform owner may acknowledge a platform alert' using errcode = '42501';
  end if;
  update app.alert set acknowledged_by = p_user, acknowledged_at = now()
   where id = p_alert and brand_id is null and acknowledged_at is null;
  get diagnostics n = row_count;
  return query select exists (select 1 from app.alert where id = p_alert and brand_id is null), n > 0;
end $$;
alter function app.ack_platform_alert(uuid, uuid) owner to mkt_definer;
revoke all on function app.ack_platform_alert(uuid, uuid) from public;
grant execute on function app.ack_platform_alert(uuid, uuid) to mkt_app;

-- The user IDs of the platform owners.
create function app.platform_owner_ids() returns setof uuid
language sql stable security definer set search_path = pg_catalog, app
as $$ select user_id from app.platform_owner order by granted_at, user_id $$;
alter function app.platform_owner_ids() owner to mkt_definer;
revoke all on function app.platform_owner_ids() from public;
grant execute on function app.platform_owner_ids() to mkt_app;

-- Queued notifications still under the attempt limit, across brands, oldest first.
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

-- What an operator should hear about, across brands: jobs the core has marked dead, jobs that have waited
-- since before the cutoff without any attempt (and are not held), and model calls left in an unknown state.
-- kind is dead_job, waiting_job or unknown_model_call; ref is the job or call id.
create function app.operational_findings(p_waiting_before timestamptz)
returns table (brand_id uuid, kind text, ref uuid)
language sql stable security definer set search_path = pg_catalog, app
as $$
  select c.brand_id, 'dead_job'::text, c.job_id
    from app.job_control c join app.job_input i on i.job_id = c.job_id
   where c.dead_at is not null and i.finished_at is null
  union all
  select i.brand_id, 'waiting_job'::text, i.job_id
    from app.job_input i join app.job_control c on c.job_id = i.job_id
   where i.finished_at is null and c.dead_at is null and not c.held and not c.cancel_requested
     and i.created_at < p_waiting_before
     and not exists (select 1 from app.job_attempt a where a.job_id = i.job_id)
  union all
  select m.brand_id, 'unknown_model_call'::text, m.id from app.model_call m where m.status = 'unknown'
$$;
alter function app.operational_findings(timestamptz) owner to mkt_definer;
revoke all on function app.operational_findings(timestamptz) from public;
grant execute on function app.operational_findings(timestamptz) to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.operational_findings(timestamptz);
drop function app.pending_notifications(integer, integer);
drop function app.platform_owner_ids();
drop function app.ack_platform_alert(uuid, uuid);
drop function app.list_platform_alerts();
drop function app.mark_alert_delivery(uuid, boolean);
drop function app.undelivered_alerts(integer);
drop function app.raise_alert(uuid, smallint, text, jsonb);
drop policy definer_read_job_attempt on app.job_attempt;
revoke select on app.job_attempt from mkt_definer;
drop policy definer_read_notification on app.notification;
revoke select on app.notification from mkt_definer;
drop policy definer_alert on app.alert;
-- Only what this migration granted: 0014 granted select, which platform_alerts() still needs.
revoke insert, update on app.alert from mkt_definer;
drop index app.notification_queued_idx;
drop index app.alert_undelivered_idx;
drop index app.alert_open_ref_unique;
alter table app.alert drop column delivery_attempts;
alter table app.alert drop column delivered_at;
