-- 0002_admin_auth: local admin-UI authentication (Phase 11).
ALTER TABLE users ADD COLUMN password_hash text;
