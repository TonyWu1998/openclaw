-- Phase 5A receipt review and manual inventory entry additions.

create table if not exists receipt_reviews (
  id text primary key,
  receipt_upload_id text not null references receipt_uploads(id) on delete cascade,
  household_id text not null references households(id) on delete cascade,
  mode text not null check (mode in ('overwrite', 'append')),
  notes text,
  idempotency_key text,
  created_at timestamptz not null default now()
);

create index if not exists idx_receipt_reviews_receipt_created
  on receipt_reviews (receipt_upload_id, created_at desc);

create unique index if not exists uq_receipt_reviews_idempotency
  on receipt_reviews (receipt_upload_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists manual_inventory_entries (
  id text primary key,
  household_id text not null references households(id) on delete cascade,
  notes text,
  idempotency_key text,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_manual_inventory_entries_idempotency
  on manual_inventory_entries (household_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists manual_inventory_entry_items (
  id text primary key,
  manual_entry_id text not null references manual_inventory_entries(id) on delete cascade,
  household_id text not null references households(id) on delete cascade,
  item_key text not null,
  item_name text not null,
  quantity numeric not null,
  unit text not null,
  category text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_manual_inventory_entry_items_household_created
  on manual_inventory_entry_items (household_id, created_at desc);
