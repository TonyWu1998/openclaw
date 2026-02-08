-- Phase 3 recommendation and feedback schema additions.

create table if not exists recommendation_runs (
  id text primary key,
  household_id text not null references households(id) on delete cascade,
  run_type text not null check (run_type in ('daily', 'weekly')),
  target_date date not null,
  model text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_recommendation_runs_household_type
  on recommendation_runs (household_id, run_type, created_at desc);

create table if not exists meal_recommendations (
  id text primary key,
  run_id text not null references recommendation_runs(id) on delete cascade,
  household_id text not null references households(id) on delete cascade,
  meal_date date not null,
  title text not null,
  cuisine text not null,
  rationale text not null,
  item_keys text[] not null,
  score numeric not null,
  created_at timestamptz not null default now()
);

create table if not exists purchase_recommendations (
  id text primary key,
  run_id text not null references recommendation_runs(id) on delete cascade,
  household_id text not null references households(id) on delete cascade,
  week_of date not null,
  item_key text not null,
  item_name text not null,
  quantity numeric not null,
  unit text not null,
  priority text not null check (priority in ('high', 'medium', 'low')),
  rationale text not null,
  score numeric not null,
  created_at timestamptz not null default now()
);

create table if not exists agent_feedback_signals (
  id text primary key,
  recommendation_id text not null,
  household_id text not null references households(id) on delete cascade,
  signal_type text not null check (signal_type in ('accepted', 'rejected', 'edited', 'ignored', 'consumed', 'wasted')),
  signal_value numeric not null,
  context text,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_feedback_household_created
  on agent_feedback_signals (household_id, created_at desc);
