-- Immutable proposals; mutable execution records are kept separately. Track
-- deletion intentionally does not erase the plan or its per-file outcome.
CREATE TABLE filename_tag_plans (
    token UUID PRIMARY KEY,
    revision TEXT NOT NULL CHECK (char_length(revision) = 64),
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'running', 'done', 'error')),
    expires_at TIMESTAMPTZ NOT NULL,
    request_id UUID UNIQUE,
    job_id UUID REFERENCES jobs(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((request_id IS NULL) = (job_id IS NULL))
);

CREATE INDEX filename_tag_plans_running ON filename_tag_plans (updated_at) WHERE state = 'running';

CREATE TABLE filename_tag_plan_items (
    token UUID NOT NULL REFERENCES filename_tag_plans(token) ON DELETE CASCADE,
    track_id BIGINT NOT NULL,
    position INTEGER NOT NULL,
    result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    PRIMARY KEY (token, track_id),
    UNIQUE (token, position)
);
