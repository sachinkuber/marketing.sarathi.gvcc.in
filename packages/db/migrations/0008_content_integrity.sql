-- Up Migration
-- A content version is the record of exactly what was approved and may be published (spec 10.1, 10.2).
-- It never changes, and its hash is the SHA-256 of its payload. Both are enforced by the database for every
-- role, the table owner and the superuser included; a trigger fires for all of them.

create function app.refuse_content_version_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'a content version cannot be changed or removed' using errcode = '42501';
end $$;

-- Row triggers do not fire for TRUNCATE, so it has its own.
create trigger content_version_no_change
  before update or delete on app.content_version
  for each row execute function app.refuse_content_version_change();
create trigger content_version_no_truncate
  before truncate on app.content_version
  for each statement execute function app.refuse_content_version_change();

create function app.check_content_version_hash()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare payload jsonb;
begin
  if new.hash_scheme <> 'cv1' then
    raise exception 'unknown hash scheme %', new.hash_scheme using errcode = '23514';
  end if;
  if new.hash <> 'sha256:' || encode(sha256(convert_to(new.payload_canonical, 'UTF8')), 'hex') then
    raise exception 'the hash does not match the payload' using errcode = '23514';
  end if;
  begin
    payload := new.payload_canonical::jsonb;
  exception when others then
    raise exception 'the payload is not JSON' using errcode = '23514';
  end;
  -- The hash covers who the item is for. A payload that names another brand or item than its row is refused.
  if payload ->> 'brand_id' is distinct from new.brand_id::text
     or payload ->> 'content_item_id' is distinct from new.content_item_id::text then
    raise exception 'the payload names a different brand or item than its row' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger content_version_hash
  before insert on app.content_version
  for each row execute function app.check_content_version_hash();

-- Down Migration
drop trigger content_version_hash on app.content_version;
drop function app.check_content_version_hash();
drop trigger content_version_no_truncate on app.content_version;
drop trigger content_version_no_change on app.content_version;
drop function app.refuse_content_version_change();
