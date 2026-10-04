-- Up Migration
create schema app;
create schema audit;

do $$
declare r text;
begin
  foreach r in array array['mkt_app','mkt_queue','mkt_audit_writer','mkt_owner_view','mkt_readonly','mkt_definer'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

revoke all on schema app from public;
revoke all on schema audit from public;
grant usage on schema app to mkt_app, mkt_readonly, mkt_definer, mkt_owner_view;

-- Down Migration
drop schema audit;
drop schema app;
