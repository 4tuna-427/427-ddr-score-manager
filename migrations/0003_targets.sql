-- Phase 2.3: per-chart targets (goal score / lamp).
-- Apply BEFORE deploying the Phase 2.3 worker (its /api/targets endpoints
-- read and write this table).
-- A target is one row per chart: an optional target score and/or target
-- lamp. Progress is computed live against the chart's best play, so no
-- denormalized progress column is needed.
CREATE TABLE targets (
  chart_id TEXT PRIMARY KEY REFERENCES charts(chart_id),
  target_score INTEGER,
  target_lamp TEXT,
  updated_at INTEGER NOT NULL
);
