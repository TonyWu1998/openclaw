-- Phase 2 receipt ingestion schema additions.
-- Adds normalized receipt line items and inventory metadata columns.

create table if not exists receipt_items (
  id text primary key,
  receipt_upload_id text not null references receipt_uploads(id) on delete cascade,
  household_id text not null references households(id) on delete cascade,
  raw_name text not null,
  normalized_name text not null,
  item_key text not null,
  quantity numeric not null,
  unit text not null,
  category text not null,
  confidence numeric,
  unit_price numeric,
  line_total numeric,
  created_at timestamptz not null default now()
);

create index if not exists idx_receipt_items_household_item
  on receipt_items (household_id, item_key);

create index if not exists idx_receipt_items_receipt
  on receipt_items (receipt_upload_id);

alter table inventory_lots
  add column if not exists category text not null default 'other';

alter table inventory_events
  add column if not exists source text not null default 'receipt';
