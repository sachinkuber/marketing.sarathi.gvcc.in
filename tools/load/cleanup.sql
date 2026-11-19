-- After test 41 (tools/load/README.md, "After the run"): removes the two temporary load-test platform owners and
-- closes the load-test brands. Run as the database superuser, in one transaction:
--   psql -v ON_ERROR_STOP=1 -U postgres -d mkt -f tools/load/cleanup.sql
--
-- Users: their memberships and owner rows go, then the user rows; sessions, passwords and second factors go with
-- them (ON DELETE CASCADE). Only addresses of the form loadtest<N>@load-test.invalid are touched.
-- Brands: kept, because their runs, model calls and cost-ledger rows are the evidence of the test and are
-- records the product keeps. They are marked 'closed'. The script refuses while any of their runs is open.
-- Audit entries naming the removed users stay: the audit log is append-only.
\set ON_ERROR_STOP on
begin;

create temp table cleanup_users on commit drop as
  select id, email from auth."user" where email ~ '^loadtest[0-9]+@load-test\.invalid$';
create temp table cleanup_brands on commit drop as
  select id, slug from app.brand where slug ~ '^load-test-';

-- Nothing outside the load-test accounts may depend on them.
do $$
begin
  if exists (select 1 from app.platform_owner where granted_by in (select id from cleanup_users)
               and user_id not in (select id from cleanup_users))
     or exists (select 1 from app.membership where created_by in (select id from cleanup_users)
               and user_id not in (select id from cleanup_users))
     or exists (select 1 from app.invite where invited_by in (select id from cleanup_users))
     or exists (select 1 from app.approval where decided_by in (select id from cleanup_users))
     or exists (select 1 from app.approval_request where escalated_to in (select id from cleanup_users))
     or exists (select 1 from app.approval_setting where updated_by in (select id from cleanup_users)) then
    raise exception 'refused: something outside the load-test accounts refers to them';
  end if;
end $$;

-- Every run in the load-test brands must have ended. An open one is cancelled through the product (its cancel
-- also clears the queue and control rows), not here: wait for it, or cancel it, then run this again.
do $$
begin
  if exists (select 1 from app.run where brand_id in (select id from cleanup_brands)
               and state in ('created', 'running', 'held')) then
    raise exception 'refused: a load-test run is still open';
  end if;
end $$;

delete from app.membership where user_id in (select id from cleanup_users);
delete from app.platform_owner where user_id in (select id from cleanup_users);
delete from auth."user" where id in (select id from cleanup_users);
-- Notifications still queued about the load-test brands stop here: they went to the test users (removed above)
-- and the platform owners, and a send that keeps failing raises an alert (emailed to every owner). Marked
-- failed directly, so no alert is raised for them.
update app.notification set state = 'failed', next_attempt_at = null
 where brand_id in (select id from cleanup_brands) and state = 'queued';

update app.brand set status = 'closed', updated_at = now()
 where id in (select id from cleanup_brands) and status <> 'closed';

select 'users removed' as what, count(*) as n from cleanup_users
union all select 'brands closed', count(*) from cleanup_brands
union all select 'notifications still queued in them', count(*) from app.notification
   where brand_id in (select id from cleanup_brands) and state = 'queued'
union all select 'platform owners left', count(*) from app.platform_owner;
commit;
