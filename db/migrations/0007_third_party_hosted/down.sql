-- Reversible: the flag and note are derived data (re-created by the next discovery run or by
-- re-applying 0007), so dropping the columns loses nothing an operator typed.
ALTER TABLE models
  DROP COLUMN IF EXISTS retention_note,
  DROP COLUMN IF EXISTS third_party_hosted;
