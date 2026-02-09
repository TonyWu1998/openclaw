-- Phase 5F pantry health score snapshot additions.

create table if not exists pantry_health_scores (
  id text primary key,
  household_id text not null references households(id) on delete cascade,
  score numeric not null check (score >= 0 and score <= 100),
  stock_balance numeric not null check (stock_balance >= 0 and stock_balance <= 100),
  expiry_risk numeric not null check (expiry_risk >= 0 and expiry_risk <= 100),
  waste_pressure numeric not null check (waste_pressure >= 0 and waste_pressure <= 100),
  plan_adherence numeric not null check (plan_adherence >= 0 and plan_adherence <= 100),
  data_quality numeric not null check (data_quality >= 0 and data_quality <= 100),
  measured_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_pantry_health_scores_household_day
  on pantry_health_scores (household_id, (date(measured_at)));

create index if not exists idx_pantry_health_scores_household_measured
  on pantry_health_scores (household_id, measured_at desc);
