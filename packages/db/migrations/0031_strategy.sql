-- Up Migration
-- Milestone 11 (spec 10, 11): one strategy brief item per brand, a waiting version that can be invalidated (when a
-- fact the brief cites changes), and a definer function that records an evaluation candidate for the dashboard.

-- A waiting version can be invalidated, like an approved or scheduled one.
insert into app.version_state_transition (from_state, to_state) values ('awaiting_approval', 'invalidated');

-- The migration role owns content_item and row-level security is forced on it, so with no brand set the guard below
-- would see no rows. Forcing is switched off for the guard and on again straight after.
alter table app.content_item no force row level security;

do $$
begin
  if exists (select 1 from app.content_item where kind = 'strategy_brief' group by brand_id having count(*) > 1) then
    raise exception '0031: a brand has more than one strategy brief item; keep one and remove the others, then run the migration again';
  end if;
end $$;

alter table app.content_item force row level security;

create unique index content_item_one_brief on app.content_item (brand_id) where kind = 'strategy_brief';

-- Evaluation candidates are platform rows that mkt_app cannot touch (0024). This function is the one way the app
-- records one, so it checks what it is given.
grant select, insert on app.evaluation_case to mkt_definer;
grant create on schema app to mkt_definer;

create function app.add_evaluation_case(p_agent text, p_brand uuid, p_body jsonb, p_created_by uuid)
returns uuid
language plpgsql security definer set search_path = pg_catalog, app
as $$
declare
  new_id uuid := gen_random_uuid();
  suggestion text;
begin
  if p_body is null or p_created_by is null then
    raise exception 'an evaluation case needs a body and a creator' using errcode = '22023';
  end if;
  if p_agent is null or p_agent !~ '^[a-z][a-z_]{1,39}$' then
    raise exception 'the agent name must be 2 to 40 lowercase letters and underscores, starting with a letter' using errcode = '22023';
  end if;
  if octet_length(p_body::text) > 16384 then
    raise exception 'the case body is over 16 KB' using errcode = '22023';
  end if;
  suggestion := p_body ->> 'suggestionId';
  if suggestion is not null then
    -- Two calls for one suggestion must not both pass the check below.
    perform pg_advisory_xact_lock(hashtextextended('evaluation_case:' || suggestion, 0));
    if exists (
      select 1 from app.evaluation_case c
       where c.body ->> 'suggestionId' = suggestion and c.status <> 'dropped'
    ) then
      raise exception 'this suggestion is already in an evaluation case' using errcode = '23505';
    end if;
  end if;
  insert into app.evaluation_case (id, agent, subject_brand_id, status, body, created_by)
  values (new_id, p_agent, p_brand, 'candidate', p_body, p_created_by);
  return new_id;
end $$;
alter function app.add_evaluation_case(text, uuid, jsonb, uuid) owner to mkt_definer;
revoke all on function app.add_evaluation_case(text, uuid, jsonb, uuid) from public;
grant execute on function app.add_evaluation_case(text, uuid, jsonb, uuid) to mkt_app;
revoke create on schema app from mkt_definer;

-- Down Migration
-- Drops only what this migration added. No row of the owner's is deleted; a version already in invalidated (from
-- awaiting_approval) stays as it is, and only the reference row that allowed the move goes.
drop function app.add_evaluation_case(text, uuid, jsonb, uuid);
revoke select, insert on app.evaluation_case from mkt_definer;
drop index app.content_item_one_brief;
delete from app.version_state_transition where from_state = 'awaiting_approval' and to_state = 'invalidated';
