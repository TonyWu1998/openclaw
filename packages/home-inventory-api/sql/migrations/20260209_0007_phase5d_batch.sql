-- Phase 5D batch receipt processing metadata additions.

create table if not exists receipt_batch_groups (
  id text primary key,
  household_id text not null references households(id) on delete cascade,
  requested_count integer not null check (requested_count between 1 and 10),
  accepted_count integer not null check (accepted_count between 0 and 10),
  rejected_count integer not null check (rejected_count between 0 and 10),
  created_at timestamptz not null default now()
);

create index if not exists idx_receipt_batch_groups_household_created
  on receipt_batch_groups (household_id, created_at desc);

create table if not exists receipt_batch_group_items (
  id text primary key,
  batch_group_id text not null references receipt_batch_groups(id) on delete cascade,
  receipt_upload_id text not null references receipt_uploads(id) on delete cascade,
  household_id text not null references households(id) on delete cascade,
  job_id text references receipt_process_jobs(id) on delete set null,
  status text not null check (status in ('accepted', 'rejected')),
  error text,
  idempotency_key text,
  created_at timestamptz not null default now()
);

create index if not exists idx_receipt_batch_group_items_batch
  on receipt_batch_group_items (batch_group_id, created_at asc);

create index if not exists idx_receipt_batch_group_items_household_created
  on receipt_batch_group_items (household_id, created_at desc);

create unique index if not exists uq_receipt_batch_group_items_idempotency
  on receipt_batch_group_items (household_id, receipt_upload_id, idempotency_key)
  where idempotency_key is not null;
