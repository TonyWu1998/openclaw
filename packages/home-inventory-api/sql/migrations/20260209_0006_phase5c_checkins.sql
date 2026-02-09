-- Phase 5C meal check-ins and inventory consumption additions.

create table if not exists meal_checkins (
  id text primary key,
  recommendation_id text not null,
  household_id text not null references households(id) on delete cascade,
  meal_date date not null,
  title text not null,
  status text not null check (status in ('pending', 'completed', 'needs_adjustment')),
  outcome text check (outcome in ('made', 'skipped', 'partial')),
  notes text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_meal_checkins_household_status
  on meal_checkins (household_id, status, meal_date desc);

create unique index if not exists uq_meal_checkins_idempotency
  on meal_checkins (household_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists meal_checkin_lines (
  id text primary key,
  checkin_id text not null references meal_checkins(id) on delete cascade,
  household_id text not null references households(id) on delete cascade,
  item_key text not null,
  unit text not null,
  quantity_consumed numeric,
  quantity_wasted numeric,
  created_at timestamptz not null default now()
);

create index if not exists idx_meal_checkin_lines_checkin
  on meal_checkin_lines (checkin_id);
