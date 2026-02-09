# Home Inventory App Architecture (Codex Handoff)

Last updated: 2026-02-09

## Milestone Status

- [x] Phase 1 completed and merged (`PR #1`): backend foundation, contracts, queue skeleton, migration baseline.
- [x] Phase 2 completed and merged (`PR #2`): receipt extraction + normalization + inventory mutation events.
- [x] Phase 3 completed: agent-driven recommendation generation, extension schedules, and feedback adaptation loop.
- [x] Phase 4 completed: contract coverage, reliability retries/dead-letter behavior, worker restart recovery, and soak tests.
- [x] LLM provider portability completed: OpenAI, OpenRouter, Gemini-compatible OpenAI APIs, and local OpenAI-compatible runtimes (for example LM Studio).
- [x] Phase 4.5 completed: vision-ready receipt ingestion input and live LM Studio end-to-end validation (upload -> extract/persist -> recommend -> inventory update).

## Purpose

This document is the execution-ready architecture brief for building a home inventory app (web + iOS) on top of OpenClaw.
It is written for follow-on agents and engineers.

Primary goals:

- Track grocery and home-supply inventory from uploaded receipts.
- Reduce waste by prioritizing soon-to-expire items.
- Generate daily meal suggestions based on current stock and preferences.
- Generate weekly purchase recommendations based on demand, stock, and user behavior.

## Product Scope (V1)

- Manual receipt upload only (image/PDF from web and iOS).
- Practical pantry-level tracking (not strict ERP-grade lot tracing).
- AI-assisted ingestion and optimization, backed by deterministic SQL state.
- Single household first, with multi-household support in schema design.

Out of scope for V1:

- Direct email/order integrations (Gmail, Amazon, Instacart).
- Barcode scanner-first workflow.
- Smart-fridge/IoT integrations.

## Deployment Baseline

### Recommended now: NAS-first hybrid

- Run stateful services on local NAS (Docker, always-on):
  - `openclaw-gateway`
  - `inventory-api`
  - `inventory-worker`
- Use managed cloud data services:
  - Supabase Postgres (system of record)
  - Supabase Storage (receipt files)
  - Supabase Auth (user/household access)
- Use OpenAI API for extraction/planning intelligence.
- Host web frontend on Cloudflare Pages or Firebase Hosting.

### Cloud migration path

- Lift same containers to a single VM (AWS EC2 or GCP Compute Engine) first.
- Keep Supabase unchanged to avoid database migration.
- Split services only after sustained load requires it.

## System Architecture

### Services

1. Web frontend (React/Vite or Next.js)
2. iOS app (SwiftUI)
3. Inventory API (TypeScript, Fastify)
4. Inventory Worker (TypeScript queue worker)
5. OpenClaw Gateway (agent runtime + automation orchestration)
6. Supabase Postgres/Auth/Storage
7. OpenAI API

### Responsibility split

- Inventory API owns public app API and authorization checks.
- Postgres is the source of truth for stock, usage, and recommendation artifacts.
- Worker owns long-running extraction/planning jobs and retries.
- OpenClaw owns agent orchestration and scheduled reasoning runs.
- Frontends do not read/write OpenClaw filesystem state directly.

## Agent-Driven Intelligence (Required Design Rule)

Decision rules and optimization are AI-agent-driven, not hardcoded-only heuristics.

Implementation model:

1. Deterministic layer (must exist):
   - SQL state transitions, FEFO/FIFO depletion, idempotency, dedupe, audit logs.
   - This guarantees correctness and reproducibility.
2. Agent reasoning layer (must drive optimization):
   - OpenClaw-triggered AI jobs analyze demand patterns, seasonality, cuisine fit, budget pressure, and waste risk.
   - Agent proposes dynamic strategy updates (for example, expiry horizon, reorder priority, substitution rules, meal diversity).
3. Policy guardrails (must gate agent output):
   - Output must validate against schemas and business constraints.
   - Unsafe or low-confidence decisions fall back to deterministic defaults.
4. Continuous adaptation loop (must run):
   - User actions (accepted/skipped suggestions, actual consumption, waste events, manual corrections) are logged.
   - Agent retrains its planning behavior from these signals each day/week.

### Concrete adaptive behavior

- Daily meal planning weights are dynamically adjusted from:
  - near-expiry risk
  - user cuisine preference recency
  - prep-time patterns
  - past acceptance rate
- Weekly purchase planning adapts from:
  - rolling usage trends
  - forecast confidence
  - budget targets
  - stockout/waste penalties
- Substitution strategy adapts:
  - if item availability is low and preference fit is high, recommend alternatives from known accepted foods.

## LLM Provider Portability

- The extraction and planning paths must support multiple model vendors through one configuration surface.
- Default provider is OpenAI.
- OpenRouter and Gemini-compatible OpenAI endpoints use chat-completions transport by default.
- Local OpenAI-compatible runtimes (for example LM Studio) are supported without requiring a cloud API key.
- Environment overrides:
  - `HOME_INVENTORY_LLM_PROVIDER` (`openai`, `openrouter`, `gemini`, `lmstudio`, `openai-compatible`)
  - `HOME_INVENTORY_LLM_BASE_URL`
  - `HOME_INVENTORY_LLM_API_KEY`
  - `HOME_INVENTORY_LLM_MODEL`
  - `HOME_INVENTORY_LLM_REQUEST_MODE` (`responses` or `chat_completions`)

## Core Data Flow

1. User uploads receipt file.
2. API stores file in Supabase Storage and creates `receipt_uploads` record.
3. API enqueues async `receipt_process` job.
4. Worker calls the configured LLM for structured extraction from OCR text and optional receipt image data.
5. Worker normalizes items and writes inventory lots/events.
6. OpenClaw scheduled job runs daily plan generation.
7. OpenClaw scheduled job runs weekly purchase optimization.
8. API returns latest plans + explanations to web/iOS clients.
9. User feedback is recorded and used by next planning runs.

## Data Model (Supabase/Postgres)

Core tables:

- `households`
- `household_members`
- `user_preferences`
- `receipt_uploads`
- `receipt_items`
- `inventory_lots`
- `inventory_events`
- `recommendation_runs`
- `meal_recommendations`
- `purchase_recommendations`
- `agent_feedback_signals` (new, for adaptive loop)

`agent_feedback_signals` should capture:

- `household_id`
- `recommendation_id` (meal/purchase)
- `signal_type` (`accepted`, `rejected`, `edited`, `ignored`, `consumed`, `wasted`)
- `signal_value` (optional numeric score)
- `context_json` (why/notes/source surface)
- timestamps

## API Surface (Public)

Minimum endpoints:

- `POST /v1/receipts/upload-url`
- `POST /v1/receipts/{receiptUploadId}/process`
- `GET /v1/inventory`
- `POST /v1/inventory/consume`
- `POST /v1/inventory/adjust`
- `GET /v1/recommendations/daily-meals`
- `GET /v1/recommendations/weekly-purchase`
- `PUT /v1/preferences`
- `POST /v1/recommendations/{id}/feedback`

## OpenClaw Extension Surface (Internal)

Create new extension package:

- `extensions/home-inventory`

Register gateway methods:

- `inventory.receipt.process`
- `inventory.plan.daily`
- `inventory.plan.weekly`
- `inventory.recommendation.feedback`

Register schedules:

- Daily planning job at household-local 06:00.
- Weekly purchase job at household-local Sunday 08:00.

## Decisioning Framework (Agent + Guardrails)

Every plan run must produce:

1. Machine-readable decision payload.
2. Human-readable rationale summary.
3. Confidence score per recommendation.
4. Constraint check results.

Run acceptance criteria:

- If confidence >= threshold and constraints pass: publish plan.
- If confidence below threshold: publish deterministic fallback plan and flag for review.
- If schema validation fails: reject output and retry with safe prompt variant.

## Live E2E Validation (LM Studio)

- Real-model E2E flow is covered by:
  - `packages/home-inventory-worker/src/runner/worker-runner.live-lmstudio.e2e.test.ts`
- The test executes this path end to end:
  - upload receipt -> enqueue processing -> worker extraction/persist -> daily/weekly recommendation generation -> feedback -> second receipt inventory update
- Enable and run:
  - `HOME_INVENTORY_LIVE_LMSTUDIO=1`
  - `HOME_INVENTORY_LIVE_LMSTUDIO_BASE_URL=http://<lmstudio-host>:<port>/v1`
  - `HOME_INVENTORY_LIVE_LMSTUDIO_MODEL=<model-id>`

## Security Defaults

- Supabase RLS by `household_id`.
- Private receipt storage with short-lived signed URLs.
- Service keys only in API/worker runtime.
- API auth required for all non-public endpoints.
- Full mutation audit trail in `inventory_events`.

## Reliability Defaults

- Idempotency key per receipt processing request.
- Dedupe on hash + merchant/date/total heuristic.
- Retry with exponential backoff for model/network failures.
- Dead-letter queue for repeated extraction failures.
- Immutable record of raw extraction JSON for reprocessing.

## Phased Build Plan

### Phase 1: Foundation

- DB schema + migrations + RLS.
- API skeleton + auth + upload flow.
- Worker queue and status tracking.

### Phase 2: Receipt ingestion

- OCR/line-item extraction via OpenAI.
- Normalization pipeline (units, categories, merge keys).
- Inventory mutation events.

### Phase 3: Agent-driven optimization

- OpenClaw extension for planning methods + schedules.
- Daily meal and weekly purchase recommendation generation.
- Feedback ingestion and adaptation loop.

### Phase 4: Backend validation and hardening gates

- End-to-end backend tests (upload -> extract -> inventory mutation -> daily/weekly recommendation generation).
- Contract tests for all public API endpoints and payload schemas.
- Reliability tests (retry paths, idempotency, dedupe, dead-letter handling, recovery after worker restart).
- Performance and soak tests for expected household load on NAS baseline.
- Production-readiness checklist sign-off before frontend integration begins.

### Phase 5: Client experiences

- Web dashboard for inventory, waste risk, and plans.
- iOS app with upload, inventory view, and recommendation feedback.

### Phase 6: Hardening

- Observability, SLOs, alerting.
- Cloud VM migration runbook.
- Backup/restore and disaster recovery checks.

## Non-Goals and Tradeoffs

- V1 prioritizes practical value and adaptation quality over perfect inventory precision.
- Agent-driven optimization is required, but deterministic safety rails are mandatory.
- Keep architecture simple enough for NAS deployment while preserving cloud portability.

## Handoff Notes For Other Agents

- Treat this file as the source brief for this product line.
- If architecture decisions change, update this file first before code fan-out.
- Keep implementation decisions consistent with "agent-driven optimization + deterministic guardrails."
