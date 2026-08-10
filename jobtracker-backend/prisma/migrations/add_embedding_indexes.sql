-- Migration: add pgvector indexes for jobEmbedding and profileEmbedding
-- Run this AFTER the pgvector extension is enabled and rows have been
-- populated (index build is faster on existing data).
--
-- ivfflat is chosen over hnsw because:
--   • The dataset is small-to-medium (< 1 M rows).
--   • ivfflat has faster index build time and lower memory overhead.
--   • hnsw can be swapped in for higher recall at larger scale by replacing
--     the CREATE INDEX lines below.
--
-- lists = sqrt(n_rows) is the recommended starting point.
-- Re-run VACUUM ANALYZE after bulk-loading rows to keep stats fresh.

-- Enable extension (idempotent — safe to re-run)
CREATE EXTENSION IF NOT EXISTS vector;

-- JobSnapshot.jobEmbedding — cosine distance
-- Use IF NOT EXISTS so re-running this migration is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'JobSnapshot'
      AND indexname  = 'idx_job_snapshot_embedding_cosine'
  ) THEN
    CREATE INDEX idx_job_snapshot_embedding_cosine
      ON "JobSnapshot"
      USING ivfflat ("jobEmbedding" vector_cosine_ops)
      WITH (lists = 100);
  END IF;
END;
$$;

-- UserProfile.profileEmbedding — cosine distance
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'UserProfile'
      AND indexname  = 'idx_user_profile_embedding_cosine'
  ) THEN
    CREATE INDEX idx_user_profile_embedding_cosine
      ON "UserProfile"
      USING ivfflat ("profileEmbedding" vector_cosine_ops)
      WITH (lists = 10);   -- profiles table is small; low list count is fine
  END IF;
END;
$$;

-- Refresh planner statistics so the index is used immediately
ANALYZE "JobSnapshot";
ANALYZE "UserProfile";
