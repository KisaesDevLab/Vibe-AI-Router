-- 0001_data_model: full Phase 1 schema. Mirrors db/schema.ts exactly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('admin', 'partner', 'staff');
CREATE TYPE provider_kind AS ENUM ('openai_compat', 'anthropic', 'local');
CREATE TYPE provider_auth_type AS ENUM ('api_key', 'none');
CREATE TYPE provider_status AS ENUM ('unknown', 'healthy', 'degraded', 'down');
CREATE TYPE credential_status AS ENUM ('active', 'grace', 'revoked');
CREATE TYPE model_status AS ENUM ('active', 'deprecated', 'sunset');
CREATE TYPE model_source AS ENUM ('synced', 'custom');
CREATE TYPE sensitivity AS ENUM ('local_only', 'cloud_deidentified', 'cloud_allowed');
CREATE TYPE budget_scope AS ENUM ('firm', 'app', 'user');
CREATE TYPE request_status AS ENUM (
  'ok', 'provider_error', 'policy_blocked', 'scrubber_blocked', 'budget_exceeded',
  'rate_limited', 'capability_missing', 'client_abort', 'error'
);

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1.1
CREATE TABLE firms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 1.2
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  role user_role NOT NULL,
  email text UNIQUE,
  display_name text,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 1.3
CREATE TABLE providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  kind provider_kind NOT NULL,
  label text NOT NULL,
  base_url text NOT NULL,
  auth_type provider_auth_type NOT NULL DEFAULT 'api_key',
  status provider_status NOT NULL DEFAULT 'unknown',
  last_health_at timestamptz,
  health jsonb NOT NULL DEFAULT '{}',
  model_mapping jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 1.4 (no plaintext column exists, by construction)
CREATE TABLE provider_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  key_version integer NOT NULL,
  last4 text NOT NULL,
  status credential_status NOT NULL DEFAULT 'active',
  grace_until timestamptz,
  created_by uuid REFERENCES users(id),
  rotated_from uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 1.5
CREATE TABLE models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id text NOT NULL UNIQUE,
  provider_kind provider_kind NOT NULL,
  display_name text NOT NULL,
  context_window integer NOT NULL,
  max_output integer,
  capabilities jsonb NOT NULL DEFAULT '{}',
  capability_overrides jsonb NOT NULL DEFAULT '{}',
  status model_status NOT NULL DEFAULT 'active',
  deprecation_date date,
  source model_source NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 1.6 (append-only history)
CREATE TABLE model_pricing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  effective_from timestamptz NOT NULL,
  input_per_mtok numeric(14,6),
  output_per_mtok numeric(14,6),
  cache_read_per_mtok numeric(14,6),
  cache_write_per_mtok numeric(14,6),
  currency char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_pricing_model_effective_idx ON model_pricing (model_id, effective_from);

-- 1.7
CREATE TABLE task_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  app text NOT NULL,
  description text NOT NULL DEFAULT '',
  sensitivity sensitivity NOT NULL,
  requires jsonb NOT NULL DEFAULT '{}',
  default_max_tokens integer NOT NULL DEFAULT 1024,
  registered_by_app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 1.8
CREATE TABLE policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  task_class_id uuid NOT NULL REFERENCES task_classes(id),
  default_model_id uuid NOT NULL REFERENCES models(id),
  allowed_model_ids uuid[] NOT NULL DEFAULT '{}',
  fallback_chain uuid[] NOT NULL DEFAULT '{}',
  max_tokens_override integer,
  temperature_min real,
  temperature_max real,
  monthly_budget_cents bigint,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX policies_firm_task_class_uq ON policies (firm_id, task_class_id);

-- 1.9
CREATE TABLE role_policies (
  policy_id uuid NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  role user_role NOT NULL,
  allowed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, role)
);

-- 1.10
CREATE TABLE usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  request_id text NOT NULL UNIQUE,
  firm_id uuid NOT NULL REFERENCES firms(id),
  user_id uuid REFERENCES users(id),
  app text NOT NULL,
  task_class_id uuid REFERENCES task_classes(id),
  model_requested text,
  model_served text,
  provider_id uuid REFERENCES providers(id),
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cached_read_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cost_cents numeric(12,6),
  cost_unknown boolean NOT NULL DEFAULT false,
  cost_estimated boolean NOT NULL DEFAULT false,
  latency_ms integer,
  status request_status NOT NULL,
  engagement_ref text,
  client_ref text,
  request_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_firm_ts_idx ON usage_ledger (firm_id, ts);
CREATE INDEX usage_ledger_task_class_ts_idx ON usage_ledger (task_class_id, ts);
CREATE INDEX usage_ledger_client_ref_ts_idx ON usage_ledger (client_ref, ts);

-- 1.11 (append-only; enforced by trigger — no UPDATE/DELETE)
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  user_id uuid REFERENCES users(id),
  app text,
  task_class text,
  event text NOT NULL,
  model text,
  provider text,
  detail jsonb NOT NULL DEFAULT '{}',
  request_hash text
);
CREATE INDEX audit_log_firm_ts_idx ON audit_log (firm_id, ts);
CREATE INDEX audit_log_event_ts_idx ON audit_log (event, ts);

CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- 1.12
CREATE TABLE budgets_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope budget_scope NOT NULL,
  scope_ref text NOT NULL,
  period char(6) NOT NULL,
  spent_cents numeric(14,6) NOT NULL DEFAULT 0,
  soft_notified_at timestamptz,
  hard_stopped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX budgets_state_scope_period_uq ON budgets_state (scope, scope_ref, period);

-- 1.13
CREATE TABLE app_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  app text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- updated_at triggers for every table that has the column
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'firms','users','providers','provider_credentials','models','model_pricing',
    'task_classes','policies','role_policies','budgets_state','app_tokens'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t || '_set_updated_at', t
    );
  END LOOP;
END $$;
