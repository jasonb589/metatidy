-- History is sorted deterministically; the active preview must find older
-- running jobs without walking every completed result or loading its JSONB.
CREATE INDEX IF NOT EXISTS idx_jobs_history_created
    ON jobs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_history_state_created
    ON jobs (state, created_at DESC, id DESC);

-- Completion follows updated_at, including jobs created earlier but finished
-- later. This cursor is polled independently of visible history filters.
CREATE INDEX IF NOT EXISTS idx_jobs_completed_watch
    ON jobs (updated_at DESC, id DESC)
    WHERE kind = 'scan' AND state = 'done' AND result->>'trigger' = 'watch';
