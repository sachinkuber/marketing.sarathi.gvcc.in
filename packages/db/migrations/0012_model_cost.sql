-- Up Migration
-- Model prices (plan decision 5): data the owner confirms from the provider's own price page.
-- Millionths of a US dollar per million tokens. Not brand-scoped; written only by the release step.
create table app.model_price (
  id uuid primary key default gen_random_uuid(),
  model text not null,
  effective_from date not null,
  input_micros bigint not null check (input_micros >= 0),
  output_micros bigint not null check (output_micros >= 0),
  cache_read_micros bigint not null check (cache_read_micros >= 0),
  cache_write_micros bigint not null check (cache_write_micros >= 0),
  source text not null,
  created_at timestamptz not null default now(),
  unique (model, effective_from)
);
grant select on app.model_price to mkt_app, mkt_readonly, mkt_owner_view;

-- Down Migration
drop table app.model_price;
