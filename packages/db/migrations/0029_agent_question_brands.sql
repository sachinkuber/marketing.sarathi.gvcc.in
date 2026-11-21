-- Up Migration
-- Milestone 10 (spec 9): the agent-question reminder sweep has no brand context, so it must first learn which brands
-- have a question due for a reminder, as the approval tick does (0017). A definer function returns only brand ids,
-- nothing else of a question, and changes nothing. A question counts while its job still waits on it (not finished,
-- not dead, not cancelled) and it has gone unreminded since before the cutoff the caller passes.
create policy definer_read_agent_question on app.agent_question for select to mkt_definer using (true);
grant select on app.agent_question to mkt_definer;

grant create on schema app to mkt_definer;

create function app.brands_with_due_agent_questions(p_cutoff timestamptz) returns setof uuid
language sql stable security definer set search_path = pg_catalog, app
as $$
  select distinct q.brand_id
    from app.agent_question q
    join app.job_input i on i.job_id = q.job_id and i.brand_id = q.brand_id
    join app.job_control c on c.job_id = q.job_id
   where q.answer is null and coalesce(q.reminded_at, q.created_at) < p_cutoff
     and i.finished_at is null and c.dead_at is null and not c.cancel_requested
$$;
alter function app.brands_with_due_agent_questions(timestamptz) owner to mkt_definer;
revoke all on function app.brands_with_due_agent_questions(timestamptz) from public;
grant execute on function app.brands_with_due_agent_questions(timestamptz) to mkt_app;

revoke create on schema app from mkt_definer;

-- Down Migration
-- No row is touched: only the function, the definer's read policy and its grant go.
drop function app.brands_with_due_agent_questions(timestamptz);
drop policy definer_read_agent_question on app.agent_question;
revoke select on app.agent_question from mkt_definer;
