-- 0011: indexes for review queue filtering and per-chart best-score queries.
CREATE INDEX IF NOT EXISTS idx_scores_needs_review ON scores(needs_review, played_at);
CREATE INDEX IF NOT EXISTS idx_scores_chart_score ON scores(chart_id, score);
