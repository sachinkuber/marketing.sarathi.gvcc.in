-- Up Migration
-- Milestone 6, fix round (Task 11 review I-2): the platform owner sees every brand in the brand list and the
-- switcher, whether or not they hold a membership. The read crosses brands, so it is a definer function that
-- answers only when the named user is a platform owner, and returns nothing at all for anyone else. It returns
-- the same four columns as app.list_all_brands(), which stays reserved for the owner-view role.

grant create on schema app to mkt_definer;

create function app.brands_for_platform_owner(p_user uuid)
returns table (id uuid, name text, slug text, status app.brand_status)
language sql stable security definer set search_path = pg_catalog, app
as $$
  select b.id, b.name, b.slug, b.status from app.brand b
   where exists (select 1 from app.platform_owner o where o.user_id = p_user)
   order by b.slug
$$;
alter function app.brands_for_platform_owner(uuid) owner to mkt_definer;
revoke all on function app.brands_for_platform_owner(uuid) from public;
grant execute on function app.brands_for_platform_owner(uuid) to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.brands_for_platform_owner(uuid);
