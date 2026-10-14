-- Up Migration
-- The worker's reconciliation asks which of the jobs the queue shows as failed the core has not yet marked
-- dead. It crosses brands and has no brand context, so it is a definer function that reads two columns and
-- changes nothing.
create policy definer_read_job_control on app.job_control for select to mkt_definer using (true);
grant select on app.job_control to mkt_definer;

-- Changing the owner needs the definer to hold create on the schema, for this migration only.
grant create on schema app to mkt_definer;

create function app.unmarked_dead_jobs(p_jobs uuid[]) returns setof uuid
language sql stable security definer set search_path = pg_catalog, app
as $$
  select i.job_id
    from app.job_input i left join app.job_control c on c.job_id = i.job_id
   where i.job_id = any (p_jobs) and c.dead_at is null and i.finished_at is null
$$;
alter function app.unmarked_dead_jobs(uuid[]) owner to mkt_definer;
revoke all on function app.unmarked_dead_jobs(uuid[]) from public;
grant execute on function app.unmarked_dead_jobs(uuid[]) to mkt_app;
revoke create on schema app from mkt_definer;

-- Down Migration
drop function app.unmarked_dead_jobs(uuid[]);
drop policy definer_read_job_control on app.job_control;
