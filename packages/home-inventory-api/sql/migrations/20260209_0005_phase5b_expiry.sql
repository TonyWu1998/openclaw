-- Phase 5B expiry intelligence additions.

alter table inventory_lots
  add column if not exists expires_at timestamptz,
  add column if not exists expiry_estimated_at timestamptz,
  add column if not exists expiry_source text not null default 'unknown' check (expiry_source in ('exact', 'estimated', 'unknown')),
  add column if not exists expiry_confidence numeric;

create index if not exists idx_inventory_lots_expiry_at
  on inventory_lots (household_id, expires_at)
  where expires_at is not null and status = 'active';

create index if not exists idx_inventory_lots_expiry_source
  on inventory_lots (household_id, expiry_source);
