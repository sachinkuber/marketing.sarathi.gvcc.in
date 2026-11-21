-- Up Migration
-- Milestone 10: startAttempt sums the searches recorded for a research run (all its model calls) to hold the run's
-- search cap. The sum looks calls up by brand and run, so it gets its own index.
create index model_call_brand_run on app.model_call (brand_id, run_id);

-- Down Migration
drop index app.model_call_brand_run;
