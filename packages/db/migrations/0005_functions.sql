-- Up Migration
-- Changing a function's owner needs the right to act as the new owner. The migration role created
-- mkt_definer, so it may grant itself that right; no run-time role gets it.
grant mkt_definer to mkt_migration with set true;
-- Becoming a function's owner also needs CREATE on its schema. Held only while the functions below
-- change hands, and revoked at the end of this file.
grant create on schema app to mkt_definer;

-- Policies that let only the function owner see across brands. No run-time role has these.
create policy definer_read_brand on app.brand for select to mkt_definer using (true);
create policy definer_insert_brand on app.brand for insert to mkt_definer with check (true);
create policy definer_read_membership on app.membership for select to mkt_definer using (true);
create policy definer_insert_setting on app.approval_setting for insert to mkt_definer with check (true);
grant select, insert on app.brand to mkt_definer;
grant select on app.membership to mkt_definer;
grant select on app.platform_owner to mkt_definer;
grant insert on app.approval_setting to mkt_definer;

create function app.list_all_brands()
returns table (id uuid, name text, slug text, status app.brand_status)
language sql security definer set search_path = pg_catalog, app
as $$ select id, name, slug, status from app.brand order by slug $$;
alter function app.list_all_brands() owner to mkt_definer;
revoke all on function app.list_all_brands() from public;
grant execute on function app.list_all_brands() to mkt_owner_view;

create function app.is_platform_owner(p_user uuid)
returns boolean
language sql security definer set search_path = pg_catalog, app
as $$ select exists (select 1 from app.platform_owner where user_id = p_user) $$;
alter function app.is_platform_owner(uuid) owner to mkt_definer;
revoke all on function app.is_platform_owner(uuid) from public;
grant execute on function app.is_platform_owner(uuid) to mkt_app;

create function app.memberships_for_user(p_user uuid)
returns table (brand_id uuid, role app.membership_role)
language sql security definer set search_path = pg_catalog, app
as $$ select m.brand_id, m.role from app.membership m where m.user_id = p_user $$;
alter function app.memberships_for_user(uuid) owner to mkt_definer;
revoke all on function app.memberships_for_user(uuid) from public;
grant execute on function app.memberships_for_user(uuid) to mkt_app;

create function app.create_brand(p_name text, p_slug text)
returns uuid
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare new_id uuid := gen_random_uuid();
begin
  perform set_config('app.brand_id', new_id::text, true);
  insert into app.brand (id, name, slug) values (new_id, p_name, p_slug);
  insert into app.approval_setting (brand_id) values (new_id);
  return new_id;
end $$;
alter function app.create_brand(text, text) owner to mkt_definer;
revoke all on function app.create_brand(text, text) from public;
grant execute on function app.create_brand(text, text) to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.create_brand(text, text);
drop function app.memberships_for_user(uuid);
drop function app.is_platform_owner(uuid);
drop function app.list_all_brands();
drop policy definer_insert_setting on app.approval_setting;
drop policy definer_read_membership on app.membership;
drop policy definer_insert_brand on app.brand;
drop policy definer_read_brand on app.brand;
