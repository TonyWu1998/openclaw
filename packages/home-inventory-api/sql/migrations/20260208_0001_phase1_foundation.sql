-- Phase 1 foundation schema for home inventory backend.
-- Target: Postgres / Supabase

create extension if not exists "pgcrypto";

create table if not exists households (
  id text primary key,
  name text not null,
  timezone text not null default 'UTC',
  currency text not null default 'USD',
  created_at timestamptz not null default now()
);

create table if not exists household_members (
  household_id text not null references households(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists user_preferences (
  household_id text primary key references households(id) on delete cascade,
  cuisines text[] not null default '{}',
  allergies text[] not null default '{}',
  dislikes text[] not null default '{}',
  servings integer not null default 2,
  weekly_budget numeric(12,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists receipt_uploads (
  id text primary key,
  household_id text not null references households(id) on delete cascade,
  storage_path text not null,
  source text not null default 'manual_upload',
  merchant_name text,
  purchased_at timestamptz,
  status text not null check (status in ('uploaded', 'processing', 'parsed', 'failed')),
  extraction_json jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_receipt_uploads_household_created
  on receipt_uploads (household_id, created_at desc);

create table if not exists receipt_process_jobs (
  id text primary key,
  receipt_upload_id text not null references receipt_uploads(id) on delete cascade,
  household_id text not null references households(id) on delete cascade,
  status text not null check (status in ('queued', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  worker_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists idx_receipt_process_jobs_queue
  on receipt_process_jobs (status, created_at asc)
  where status in ('queued', 'processing');

create table if not exists inventory_lots (
  id text primary key,
  household_id text not null references households(id) on delete cascade,
  item_key text not null,
  item_name text not null,
  quantity_remaining numeric not null,
  unit text not null,
  purchased_at timestamptz,
  expires_on date,
  status text not null default 'active' check (status in ('active', 'consumed', 'discarded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_inventory_lots_household_item
  on inventory_lots (household_id, item_key);

create index if not exists idx_inventory_lots_expiry
  on inventory_lots (household_id, expires_on)
  where status = 'active';

create table if not exists inventory_events (
  id text primary key,
  household_id text not null references households(id) on delete cascade,
  lot_id text references inventory_lots(id) on delete set null,
  event_type text not null check (event_type in ('add', 'consume', 'adjust', 'waste')),
  quantity numeric not null,
  unit text not null,
  reason text,
  actor_id uuid,
  event_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_inventory_events_household_time
  on inventory_events (household_id, event_at desc);
