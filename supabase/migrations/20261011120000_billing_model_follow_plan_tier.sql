-- Preserve existing billing choices. Equality with a tier default is NOT
-- provenance: an admin may explicitly have accepted the same model.
-- New records may leave billing_model null to follow the tier. Existing values
-- remain authoritative; a reviewed per-client migration can change a choice.
-- This upstream migration has not been applied to our isolated dev database.
-- Keep its identity while replacing the unsafe inferred backfill with a no-op.
select 1;
