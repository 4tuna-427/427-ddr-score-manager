-- Fix max_ex and judge_sum_check / needs_review for charts with shock arrows.
-- charts.notes already includes shock arrows (= MAX COMBO), so:
--   max_ex = (notes + freeze) * 3
--   expected tap judge sum = notes - shock

-- 1. Recalculate max_ex for shock > 0 charts.
UPDATE charts
SET max_ex = (notes + freeze) * 3
WHERE shock IS NOT NULL
  AND shock > 0
  AND notes IS NOT NULL
  AND freeze IS NOT NULL;

-- 2. Recompute judge_sum_check for scores linked to shock > 0 charts.
UPDATE scores
SET judge_sum_check = CASE
  WHEN (SELECT c.notes FROM charts c WHERE c.chart_id = scores.chart_id) IS NULL THEN 'no_master'
  WHEN (
    COALESCE(marvelous, 0) + COALESCE(perfect, 0) + COALESCE(great, 0) + COALESCE(good, 0) + COALESCE(miss, 0)
  ) = (
    (SELECT c.notes - COALESCE(c.shock, 0) FROM charts c WHERE c.chart_id = scores.chart_id)
  ) THEN 'match'
  ELSE 'check'
END
WHERE chart_id IN (
  SELECT chart_id FROM charts WHERE shock IS NOT NULL AND shock > 0
);

-- 3. Clear needs_review (and review_status / has_review_image) for scores on shock > 0 charts
--    when judge_sum_check is now 'match' and no other review reason applies.
--    Note: player_unresolved cannot be checked purely in SQL without parsing raw_extraction JSON,
--    so we require either raw_extraction IS NULL or it is not an unresolved versus extraction,
--    or simply skip rows where raw_extraction indicates is_versus = true without _selected_player.
UPDATE scores
SET needs_review = 0,
    review_status = NULL,
    has_review_image = 0
WHERE needs_review = 1
  AND chart_id IN (
    SELECT chart_id FROM charts WHERE shock IS NOT NULL AND shock > 0
  )
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
    AND max_combo > (SELECT c.notes FROM charts c WHERE c.chart_id = scores.chart_id)
  )
  AND (
    raw_extraction IS NULL
    OR raw_extraction NOT LIKE '%"is_versus":true%'
    OR raw_extraction LIKE '%"_selected_player":%'
  );
