-- Up Migration
-- An invited person is not yet a member of any brand, so redeeming an invite is done by named functions
-- owned by the definer role, as in 0005. The definer holds CREATE on schema app only while it takes ownership.
grant create on schema app to mkt_definer;

create policy definer_read_invite on app.invite for select to mkt_definer using (true);
create policy definer_update_invite on app.invite for update to mkt_definer using (true) with check (true);
create policy definer_insert_membership on app.membership for insert to mkt_definer with check (true);
grant select, update on app.invite to mkt_definer;
grant insert on app.membership to mkt_definer;

create function app.peek_invite(p_token_hash bytea)
returns table (email text, role app.membership_role, brand_name text)
language sql security definer set search_path = pg_catalog, app
as $$
  select i.email::text, i.role, b.name
    from app.invite i join app.brand b on b.id = i.brand_id
   where i.token_hash = p_token_hash and i.used_at is null and i.expires_at > now()
$$;
alter function app.peek_invite(bytea) owner to mkt_definer;
revoke all on function app.peek_invite(bytea) from public;
grant execute on function app.peek_invite(bytea) to mkt_app;

create function app.redeem_invite(p_token_hash bytea, p_user uuid)
returns table (brand_id uuid, role app.membership_role)
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare inv app.invite%rowtype;
begin
  select * into inv from app.invite i
   where i.token_hash = p_token_hash and i.used_at is null and i.expires_at > now()
   for update;
  if not found then
    raise exception 'invite is not valid' using errcode = 'MKT01';
  end if;
  update app.invite set used_at = now() where id = inv.id;
  insert into app.membership (brand_id, user_id, role, created_by)
    values (inv.brand_id, p_user, inv.role, inv.invited_by);
  return query select inv.brand_id, inv.role;
end $$;
alter function app.redeem_invite(bytea, uuid) owner to mkt_definer;
revoke all on function app.redeem_invite(bytea, uuid) from public;
grant execute on function app.redeem_invite(bytea, uuid) to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.redeem_invite(bytea, uuid);
drop function app.peek_invite(bytea);
drop policy definer_insert_membership on app.membership;
drop policy definer_update_invite on app.invite;
drop policy definer_read_invite on app.invite;
