-- Up Migration
-- Milestone 9: a PDF may be up to 100 MB (the owner's decision, which supersedes spec 13's 10 MB); an image stays
-- small at 5 MB. 0023 named the column check implicitly, brand_document_size_bytes_check.
alter table app.brand_document drop constraint brand_document_size_bytes_check;
alter table app.brand_document
  add constraint brand_document_size_bytes_check
  check (size_bytes <= case when media_type = 'application/pdf' then 104857600 else 5242880 end);

-- Down Migration
-- No stored document is deleted: the old limit comes back as NOT VALID, so a PDF already stored above 10 MB is
-- kept (the check holds every new or changed row to the old limit and is not run against existing rows).
alter table app.brand_document drop constraint brand_document_size_bytes_check;
alter table app.brand_document
  add constraint brand_document_size_bytes_check check (size_bytes <= 10485760) not valid;
