-- Up Migration
-- The reminder tick has no brand context: it must first learn which brands have an open approval request.
-- A definer function returns only brand IDs (nothing else of a request), and changes nothing.
create policy definer_read_approval_request on app.approval_request for select to mkt_definer using (true);
grant select on app.approval_request to mkt_definer;

grant create on schema app to mkt_definer;

create function app.brands_with_open_requests() returns setof uuid
language sql stable security definer set search_path = pg_catalog, app
as $$ select distinct brand_id from app.approval_request where closed_at is null $$;
alter function app.brands_with_open_requests() owner to mkt_definer;
revoke all on function app.brands_with_open_requests() from public;
grant execute on function app.brands_with_open_requests() to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.brands_with_open_requests();
drop policy definer_read_approval_request on app.approval_request;
revoke select on app.approval_request from mkt_definer;
