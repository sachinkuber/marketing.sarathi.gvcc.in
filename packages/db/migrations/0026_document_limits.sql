-- Up Migration
-- Milestone 9: a PDF may be up to 100 MB (the owner's decision, which supersedes spec 13's 10 MB); an image stays
-- small at 5 MB. 0023 named the column check implicitly, brand_document_size_bytes_check.
alter table app.brand_document drop constraint brand_document_size_bytes_check;
alter table app.brand_document
  add constraint brand_document_size_bytes_check
  check (size_bytes <= case when media_type = 'application/pdf' then 104857600 else 5242880 end);

-- Down Migration
-- Documents already stored above 10 MB would violate the old limit, so they go first.
delete from app.brand_document where size_bytes > 10485760;
alter table app.brand_document drop constraint brand_document_size_bytes_check;
alter table app.brand_document
  add constraint brand_document_size_bytes_check check (size_bytes <= 10485760);
