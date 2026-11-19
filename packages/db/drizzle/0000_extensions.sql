-- Extensions must exist before any table or index that uses them.
-- pg_trgm: trigram similarity for fuzzy vendor matching (vendors.normalized_name).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
