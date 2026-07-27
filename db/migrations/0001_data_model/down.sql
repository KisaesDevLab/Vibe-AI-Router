-- Reverses 0001_data_model completely.

DROP TABLE IF EXISTS app_tokens;
DROP TABLE IF EXISTS budgets_state;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TABLE IF EXISTS audit_log;
DROP FUNCTION IF EXISTS audit_log_immutable();
DROP TABLE IF EXISTS usage_ledger;
DROP TABLE IF EXISTS role_policies;
DROP TABLE IF EXISTS policies;
DROP TABLE IF EXISTS task_classes;
DROP TABLE IF EXISTS model_pricing;
DROP TABLE IF EXISTS models;
DROP TABLE IF EXISTS provider_credentials;
DROP TABLE IF EXISTS providers;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS firms;

DROP FUNCTION IF EXISTS set_updated_at();

DROP TYPE IF EXISTS request_status;
DROP TYPE IF EXISTS budget_scope;
DROP TYPE IF EXISTS sensitivity;
DROP TYPE IF EXISTS model_source;
DROP TYPE IF EXISTS model_status;
DROP TYPE IF EXISTS credential_status;
DROP TYPE IF EXISTS provider_status;
DROP TYPE IF EXISTS provider_auth_type;
DROP TYPE IF EXISTS provider_kind;
DROP TYPE IF EXISTS user_role;
