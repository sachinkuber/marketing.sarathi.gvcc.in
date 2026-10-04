-- Up Migration
-- Row-level security on every table that carries brand_id, the same policy on each.
-- nullif: after a transaction that set the brand, a pooled connection keeps an empty setting,
-- and casting an empty string to uuid would raise an error instead of matching nothing.
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.columns
     where table_schema = 'app' and column_name = 'brand_id' order by 1
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format(
      'create policy brand_isolation on app.%I using (brand_id = nullif(current_setting(''app.brand_id'', true), '''')::uuid) with check (brand_id = nullif(current_setting(''app.brand_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;

-- app.brand is scoped by its own id.
alter table app.brand enable row level security;
alter table app.brand force row level security;
create policy brand_isolation on app.brand
  using (id = nullif(current_setting('app.brand_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.brand_id', true), '')::uuid);

-- Grants. Run-time roles own nothing.
grant select, insert, update, delete on
  app.brand, app.membership, app.invite, app.approval_setting, app.kill_switch,
  app.content_item, app.content_version_state, app.check_result, app.approval_request, app.popup_ack,
  app.outbox_action
  to mkt_app;
-- Insert only: written once, never changed.
grant select, insert on
  app.content_version, app.content_version_state_change, app.asset, app.approval, app.approval_invalidation
  to mkt_app;
grant select on all tables in schema app to mkt_readonly;

-- Down Migration
revoke all on all tables in schema app from mkt_app, mkt_readonly;
do $$
declare t text;
begin
  for t in select table_name from information_schema.columns where table_schema = 'app' and column_name = 'brand_id'
  loop
    execute format('drop policy brand_isolation on app.%I', t);
    execute format('alter table app.%I no force row level security', t);
    execute format('alter table app.%I disable row level security', t);
  end loop;
end $$;
drop policy brand_isolation on app.brand;
alter table app.brand no force row level security;
alter table app.brand disable row level security;
