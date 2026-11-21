-- Up Migration
-- Milestone 10 (spec 7, 9): who stated an owner statement, the questionnaire's finished state, and the one open
-- question a job may have. Grants stay as migration 0023 gave them: nothing broader is added here.

-- An owner statement records the user who stated it (decision D7). Other sources have no such user.
alter table app.research_source add column stated_by uuid references auth."user" (id);

-- Existing owner statements get the deciding user of the suggestion whose verified fact cites them.
update app.research_source rs
   set stated_by = d.decided_by
  from (
    select distinct on (src.id) src.id, s.decided_by
      from app.research_source src
      join app.verified_fact f on f.brand_id = src.brand_id and src.id = any (f.source_ids)
      join app.suggestion s on s.brand_id = f.brand_id and s.id = f.from_suggestion
     where src.kind = 'owner_statement' and src.stated_by is null and s.decided_by is not null
     order by src.id, f.confirmed_at
  ) d
 where rs.id = d.id;

-- The check is added validated when every owner statement was matched; otherwise it is added not valid (new rows
-- are held to it, old rows are left for the owner to settle) and validated only once none is left unmatched.
do $$
begin
  if exists (select 1 from app.research_source where kind = 'owner_statement' and stated_by is null) then
    alter table app.research_source
      add constraint research_source_owner_statement_stated_by
      check (kind <> 'owner_statement' or stated_by is not null) not valid;
  else
    alter table app.research_source
      add constraint research_source_owner_statement_stated_by
      check (kind <> 'owner_statement' or stated_by is not null);
  end if;
end $$;

alter table app.questionnaire
  add column finished_at timestamptz,
  add column finished_by uuid references auth."user" (id);

alter table app.question
  add constraint question_options_strings
    check (options is null or (jsonb_typeof(options) = 'array' and not jsonb_path_exists(options, '$[*] ? (@.type() != "string")'))),
  add constraint question_position_positive check (position >= 1),
  add constraint question_position_unique unique (brand_id, questionnaire_id, position);

-- Set when the questionnaire is finished: the owner statement that holds the answer.
alter table app.answer
  add column source_id uuid,
  add constraint answer_source_fk foreign key (brand_id, source_id) references app.research_source (brand_id, id);

alter table app.agent_question
  add column suggested text,
  add column reminded_at timestamptz,
  add column source_id uuid,
  add constraint agent_question_source_fk foreign key (brand_id, source_id) references app.research_source (brand_id, id);
create unique index agent_question_one_open on app.agent_question (brand_id, job_id) where answer is null;

-- Down Migration
-- No owner row is deleted: every question, answer and agent question stays. Only the added columns, checks and the
-- index go, so who stated an owner statement and which source an answer produced are no longer recorded.
drop index app.agent_question_one_open;
alter table app.agent_question
  drop constraint agent_question_source_fk,
  drop column source_id,
  drop column reminded_at,
  drop column suggested;
alter table app.answer
  drop constraint answer_source_fk,
  drop column source_id;
alter table app.question
  drop constraint question_position_unique,
  drop constraint question_position_positive,
  drop constraint question_options_strings;
alter table app.questionnaire
  drop column finished_by,
  drop column finished_at;
alter table app.research_source
  drop constraint research_source_owner_statement_stated_by,
  drop column stated_by;
