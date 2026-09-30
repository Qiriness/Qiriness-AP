-- ============================================================================
-- 53 — THE MODEL EACH AGENT RUNS ON, CHOSEN IN SETTINGS
--
-- Until now a model was an env var on the worker (AGENT_*_MODEL) or the
-- dashboard (CHAT_MODEL), and changing one meant a restart on another machine.
-- A row here overrides the env var for one agent; the worker reloads the table
-- every poll and rebuilds its model clients when a row changes. No row means
-- the env var decides, so this changes nothing until somebody picks a model.
--
-- NO DATA IS WRITTEN. COPIED FROM 04_support.sql (53_agent_models.test.mjs
-- asserts the two agree). IDEMPOTENT.
--
-- Requires: 01_foundation.sql (shops, set_updated_at).
-- ============================================================================

create table if not exists public.agent_models (
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- The agent's id, the same one it records under in llm_usage.pass
  -- (scripts/lib/agent-models.mjs, AGENT_MODEL_KEYS). Embeddings are not
  -- here: the stored vectors were made with one model.
  agent text not null,
  -- An OpenAI model id. Only a name: a row can never switch an agent off.
  model text not null,
  -- The Supabase auth.users id of who chose it. No foreign key: auth is
  -- another schema, and the choice outlives the account.
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (shop_id, agent),
  constraint agent_models_agent_check check (
    agent in ('spam', 'categorise', 'situation', 'decompose', 'investigate', 'draft', 'chat')
  ),
  constraint agent_models_model_check check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$')
);

drop trigger if exists agent_models_set_updated_at on public.agent_models;
create trigger agent_models_set_updated_at
before update on public.agent_models
for each row
execute function public.set_updated_at();

alter table public.agent_models enable row level security;

comment on table public.agent_models is
  'The model each agent runs on, when chosen in Settings. Overrides the worker''s AGENT_*_MODEL and the dashboard''s CHAT_MODEL; no row means the env var decides.';
