-- Up Migration
-- Milestone 9: the AI reads one PDF part at a time (at most 8 MB), so a large upload is split into whole-page
-- parts when it is stored. The original stays in brand_document unchanged; each part is a copy of some of its pages.
create table app.brand_document_part (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  document_id uuid not null,
  part_no integer not null check (part_no >= 1),
  first_page integer not null check (first_page >= 1),
  last_page integer not null check (last_page >= first_page),
  bytes bytea not null,
  size_bytes integer not null check (size_bytes = octet_length(bytes) and size_bytes <= 8388608),
  sha256 text not null,
  created_at timestamptz not null default now(),
  unique (brand_id, id),
  unique (brand_id, document_id, part_no),
  foreign key (brand_id) references app.brand (id),
  foreign key (brand_id, document_id) references app.brand_document (brand_id, id) on delete cascade
);

alter table app.brand_document_part enable row level security;
alter table app.brand_document_part force row level security;
create policy brand_isolation on app.brand_document_part
  using (brand_id = nullif(current_setting('app.brand_id', true), '')::uuid)
  with check (brand_id = nullif(current_setting('app.brand_id', true), '')::uuid);

grant select, insert, delete on app.brand_document_part to mkt_app;
grant select on app.brand_document_part to mkt_readonly;

-- Down Migration
-- Only the parts go; the documents they were copied from stay.
drop table app.brand_document_part;
