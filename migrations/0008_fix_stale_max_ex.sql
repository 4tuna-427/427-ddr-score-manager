-- Recompute charts.max_ex with the current formula and clear review flags
-- that only existed because of the stale values.
--
-- Migration 0006 rewrote max_ex for shock charts as (notes + freeze) * 3
-- under its then-model (notes includes shock rows). The model was reversed
-- afterwards (notes excludes shock rows; an avoided shock earns O.K. and
-- EX), so the correct maximum is (notes + freeze + shock) * 3 — the
-- formula expandMaster now uses. planSync never compared max_ex, so rows
-- written by 0006 kept their stale, too-small values indefinitely
-- (e.g. Another Phase CSP: stored 1644, correct (542 + 6 + 41) * 3 = 1767),
-- falsely flagging plays as EXスコア超過 and inflating stats EX rates.

-- 1. Recompute max_ex for every chart whose notecounts are known.
UPDATE charts
SET max_ex = (notes + freeze + COALESCE(shock, 0)) * 3
WHERE notes IS NOT NULL
  AND freeze IS NOT NULL
  AND max_ex IS NOT (notes + freeze + COALESCE(shock, 0)) * 3;

-- 2. Clear needs_review (and review_status / has_review_image) for scores
--    whose only review reason was exceeding the stale max_ex. Every other
--    review condition from computeReviewReasons is re-checked here against
--    the corrected charts; player_unresolved is approximated via
--    raw_extraction, as in 0006/0007.
UPDATE scores
SET needs_review = 0,
    review_status = NULL,
    has_review_image = 0
WHERE needs_review = 1
  AND chart_id IS NOT NULL
  AND judge_sum_check = 'match'
  AND ex_check != 'mismatch'
  AND NOT (
    ex_score IS NOT NULL AND (
      ex_score < 0 OR (
        (SELECT c.max_ex FROM charts c WHERE c.chart_id = scores.chart_id) IS NOT NULL
        AND ex_score > (SELECT c.max_ex FROM charts c WHERE c.chart_id = scores.chart_id)
      )
    )
  )
  AND NOT (score > 0 AND (ex_score IS NULL OR ex_score = 0))
  AND NOT (
    level IS NOT NULL
    AND (SELECT c.level FROM charts c WHERE c.chart_id = scores.chart_id) IS NOT NULL
    AND level != (SELECT c.level FROM charts c WHERE c.chart_id = scores.chart_id)
  )
  AND NOT (
    ok IS NOT NULL
    AND (SELECT c.freeze FROM charts c WHERE c.chart_id = scores.chart_id) IS NOT NULL
    AND ok > (SELECT c.freeze + COALESCE(c.shock, 0) FROM charts c WHERE c.chart_id = scores.chart_id)
  )
  AND NOT (
    max_combo IS NOT NULL
    AND (SELECT c.notes FROM charts c WHERE c.chart_id = scores.chart_id) IS NOT NULL
    AND max_combo > (SELECT c.notes + COALESCE(c.shock, 0) FROM charts c WHERE c.chart_id = scores.chart_id)
  )
  AND (
    raw_extraction IS NULL
    OR raw_extraction NOT LIKE '%"is_versus":true%'
    OR raw_extraction LIKE '%"_selected_player":%'
  );
