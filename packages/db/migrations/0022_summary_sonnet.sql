-- Up Migration
-- Milestone 7, ruling R20: the owner (2026-11-18) made Claude Sonnet 5.5 the default model. Version 2 of the summary
-- agent runs on claude-sonnet-5-5. Version 1 (Opus) stays on record, not live, so the owner can switch back.
-- Only one version of an agent may be live (agent_definition_one_live), so version 1 is released from live first.
-- files_hash is the hash of agents/summary/ with the version 2 definition.json; a test recomputes it.

update app.agent_definition_version set live = false where agent = 'summary' and version = 1;
insert into app.agent_definition_version (agent, version, model, effort, files_hash, live, released_at)
values ('summary', 2, 'claude-sonnet-5-5', 'low', 'dcd031ab2a59622899a2fe9121969442c20a5fff8ac216c4f4e35fc24f1427f0', true, now());

-- Down Migration
delete from app.agent_definition_version where agent = 'summary' and version = 2;
update app.agent_definition_version set live = true where agent = 'summary' and version = 1;
