-- Recompute judge_sum_check with the result-screen judgment identity:
--   displayed judge sum (marvelous + perfect + great + good + miss)
--     = notes + freeze + shock - ok
-- A dropped freeze (N.G.) and a hit shock arrow count toward the displayed
-- Miss count, while held freezes and avoided shocks count as O.K. The
-- previous check compared the sum against notes alone, which falsely
-- flagged every play that dropped a freeze
-- (e.g. 8ISMUTH OVERDRIV3 ESP: 649 + 96 - 95 = 650).
-- Rows where the identity cannot be applied (notes / freeze / ok unknown)
-- keep the plain notes comparison, matching judgeSumCheck's fallback.

-- 1. Recompute judge_sum_check for scores linked to a chart.
UPDATE scores
SET judge_sum_check = CASE
  WHEN (SELECT c.notes FROM charts c WHERE c.chart_id = scores.chart_id) IS NULL THEN 'no_master'
  WHEN (
    COALESCE(marvelous, 0) + COALESCE(perfect, 0) + COALESCE(great, 0) + COALESCE(good, 0) + COALESCE(miss, 0)
  ) = (
    SELECT CASE
      WHEN c.freeze IS NOT NULL AND scores.ok IS NOT NULL
        THEN c.notes + c.freeze + COALESCE(c.shock, 0) - scores.ok
      ELSE c.notes
    END FROM charts c WHERE c.chart_id = scores.chart_id
  ) THEN 'match'
  ELSE 'check'
END
WHERE chart_id IS NOT NULL;

-- 2. Clear needs_review (and review_status / has_review_image) for scores
--    whose only review reason was the judge-sum mismatch. Every other
--    review condition from computeReviewReasons is re-checked here;
--    player_unresolved is approximated via raw_extraction, as in 0006.
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
