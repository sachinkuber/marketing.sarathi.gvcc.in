-- Up Migration
-- Milestone 10 (spec 7, 9): who stated an owner statement, the questionnaire's finished state, and the one open
-- question a job may have. Grants stay as migration 0023 gave them: nothing broader is added here.

-- The migration role owns these tables, and row-level security is forced on them, so with no brand set it would see
-- no rows: the guard and the backfill below would pass over every existing row. Forcing is switched off for the five
-- tables the guard and backfill read, and back on at the end of this migration.
alter table app.research_source no force row level security;
alter table app.suggestion no force row level security;
alter table app.verified_fact no force row level security;
alter table app.question no force row level security;
alter table app.agent_question no force row level security;

-- Before anything changes, name any existing row the new constraints would refuse, so the failure says what to settle.
do $$
begin
  if exists (select 1 from app.agent_question where answer is null group by brand_id, job_id having count(*) > 1) then
    raise exception '0028: app.agent_question has a job with more than one unanswered question; remove the extra ones, then run the migration again';
  end if;
  -- An answer needs the owner statement that records it (source_id, added below), and no answer from before this
  -- migration has one.
  if exists (select 1 from app.agent_question where answer is not null) then
    raise exception '0028: app.agent_question has answered questions with no owner statement of the answer; clear those answers or remove the questions, then run the migration again';
  end if;
  if exists (select 1 from app.question group by brand_id, questionnaire_id, position having count(*) > 1) then
    raise exception '0028: app.question repeats a position within a questionnaire; renumber the repeated questions, then run the migration again';
  end if;
  if exists (select 1 from app.question where position < 1) then
    raise exception '0028: app.question has a position below 1; renumber those questions, then run the migration again';
  end if;
  if exists (
    select 1 from app.question
     where options is not null
       and (jsonb_typeof(options) <> 'array' or jsonb_path_exists(options, '$[*] ? (@.type() != "string")'))
  ) then
    raise exception '0028: app.question has options that are not a list of strings; correct or clear them, then run the migration again';
  end if;
end $$;

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
-- If any environment keeps unmatched rows, a later migration validates the constraint once they are settled.
-- Production had none.
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

-- An answered question carries the owner statement of its answer, and an open one none: the answer route writes both
-- in one update, and an agent cites the statement as a source (ruling R11).
alter table app.agent_question
  add column suggested text,
  add column reminded_at timestamptz,
  add column source_id uuid,
  add constraint agent_question_source_fk foreign key (brand_id, source_id) references app.research_source (brand_id, id),
  add constraint agent_question_answer_source check ((answer is null) = (source_id is null));
create unique index agent_question_one_open on app.agent_question (brand_id, job_id) where answer is null;

alter table app.research_source force row level security;
alter table app.suggestion force row level security;
alter table app.verified_fact force row level security;
alter table app.question force row level security;
alter table app.agent_question force row level security;

-- Down Migration
-- No owner row is deleted: every question, answer and agent question stays. Only the added columns, checks and the
-- index go, so who stated an owner statement, which source an answer produced and the questionnaire's finished state
-- (finished_at, finished_by) are no longer recorded.
drop index app.agent_question_one_open;
alter table app.agent_question
  drop constraint agent_question_answer_source,
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
