-- Phase 5E shopping drafts and price intelligence additions.

create table if not exists shopping_drafts (
  id text primary key,
  household_id text not null references households(id) on delete cascade,
  week_of date not null,
  source_run_id text references recommendation_runs(id) on delete set null,
  status text not null check (status in ('draft', 'finalized')),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_shopping_drafts_household_week
  on shopping_drafts (household_id, week_of desc, created_at desc);

create table if not exists shopping_draft_items (
  id text primary key,
  draft_id text not null references shopping_drafts(id) on delete cascade,
  household_id text not null references households(id) on delete cascade,
  recommendation_id text references purchase_recommendations(id) on delete set null,
  item_key text not null,
  item_name text not null,
  quantity numeric not null,
  unit text not null,
  priority text not null check (priority in ('high', 'medium', 'low')),
  rationale text not null,
  item_status text not null default 'planned' check (item_status in ('planned', 'skipped', 'purchased')),
  notes text,
  last_unit_price numeric,
  avg_unit_price_30d numeric,
  min_unit_price_90d numeric,
  price_trend_pct numeric,
  price_alert boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_shopping_draft_items_draft
  on shopping_draft_items (draft_id, created_at asc);
