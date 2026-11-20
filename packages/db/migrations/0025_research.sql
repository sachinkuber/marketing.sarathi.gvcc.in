-- Up Migration
-- Milestone 9 (Phase 2 research): the ledger columns for web searches and fetches, the onboarding intake, and
-- the carry-overs from milestone 8. No production rows exist in the milestone 8 tables yet (0023 is not deployed).

-- Server-side tool use is counted per call, and a search has its own price (millionths of a US dollar per search).
alter table app.model_call
  add column server_tool_searches integer not null default 0 check (server_tool_searches >= 0),
  add column server_tool_fetches integer not null default 0 check (server_tool_fetches >= 0);
alter table app.model_price add column search_micros bigint check (search_micros >= 0);
update app.model_price set search_micros = 10000 where model = 'claude-sonnet-5-5';

-- A profile item is written once; a newer one supersedes it (ruling R10).
alter table app.profile_item add column superseded_by uuid;
alter table app.profile_item
  add foreign key (brand_id, superseded_by) references app.profile_item (brand_id, id);
grant update (superseded_by) on app.profile_item to mkt_app;

-- Owner statements are recorded with the result 'stated' (suggestions.ts); nothing else is a result.
alter table app.research_source
  add constraint research_source_result_check check (result in ('read','blocked','empty','error','stated'));

-- A stored size is the size of the stored bytes. A document nothing refers to can be deleted; a referenced one
-- still fails through the foreign key on research_source.
alter table app.brand_document
  add constraint brand_document_size_matches_bytes check (size_bytes = octet_length(bytes));
grant delete on app.brand_document to mkt_app;

-- The owner's intake answers, and the research run they started.
alter table app.onboarding add column intake jsonb, add column research_run_id uuid;
alter table app.onboarding
  add foreign key (brand_id, research_run_id) references app.run (brand_id, id);

-- Which agent files a job ran with (ruling R9). Null for jobs that run no agent files.
alter table app.job_input add column agent text, add column files_hash text;

-- Down Migration
alter table app.job_input drop column files_hash, drop column agent;
alter table app.onboarding drop column research_run_id, drop column intake;
revoke delete on app.brand_document from mkt_app;
alter table app.brand_document drop constraint brand_document_size_matches_bytes;
alter table app.research_source drop constraint research_source_result_check;
revoke update (superseded_by) on app.profile_item from mkt_app;
alter table app.profile_item drop column superseded_by;
alter table app.model_price drop column search_micros;
alter table app.model_call drop column server_tool_fetches, drop column server_tool_searches;
