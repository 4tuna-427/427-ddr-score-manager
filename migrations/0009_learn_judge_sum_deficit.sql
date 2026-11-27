-- Learn the simultaneous-freeze deficit per chart and stop flagging
-- plays that are correct under the game's counting.
--
-- Same-start freeze groups resolve as ONE event in-game (one O.K. if
-- all held, one N.G. if any is released) while the master counts
-- arrows, so a chart with simultaneous freezes always falls short of
-- the judge-sum identity by a fixed P = SUM(group_size - 1), on every
-- play, whatever the player does. charts.judge_sum_deficit stores that
-- learned P (NULL = not learned yet). Learning itself happens in the
-- Worker (see judgeSumDeficitToLearn): only a deficit-only mismatch
-- with a matching EX check and no other review reason teaches a value,
-- and a learned value is never overwritten.
--
-- Seeding: only Blew My Mind CSP is seeded here. Its master values
-- (notes 665 / freeze 46 / shock 2) agree across RemyWiki and gamerch,
-- and the stored play reads judge sum 666 with ok 46 and a matching
-- EX check, so P = 667 - 666 = 1 is proven. 1116 CSP is NOT seeded:
-- the master freeze count disagrees between sources (13 in the
-- investigation vs 14 in the live songs.json fetched 2026-11-26
-- 17:41 JST), so its P (1 or 2) is left for the Worker to learn from
-- the stored play after deploy instead of guessing here. Snow Garland
-- Fairy ESP (+2 surplus) is not a deficit at all and stays flagged.
-- planSync never compares or overwrites judge_sum_deficit, and the
-- sync chart upsert does not set it, so learned/seeded values survive
-- the daily master sync.

-- 1. Learned-deficit column (NULL until a play proves the value).
ALTER TABLE charts ADD COLUMN judge_sum_deficit INTEGER;

-- 2. Seed the one proven chart: Blew My Mind CSP
--    (song_id 8IdlOq1qI8OO1PP88I6olPiI6IqqqIIO, SP CHALLENGE).
UPDATE charts
SET judge_sum_deficit = 1
WHERE chart_id = '8IdlOq1qI8OO1PP88I6olPiI6IqqqIIO|SP|CHALLENGE';

-- 3. Recompute judge_sum_check with the deficit-aware identity:
--      expected = notes + freeze + shock - ok - COALESCE(deficit, 0)
--    Rows where the identity cannot be applied (notes / freeze / ok
--    unknown) keep the plain notes comparison, matching judgeSumCheck.
UPDATE scores
SET judge_sum_check = CASE
  WHEN (SELECT c.notes FROM charts c WHERE c.chart_id = scores.chart_id) IS NULL THEN 'no_master'
  WHEN (
    COALESCE(marvelous, 0) + COALESCE(perfect, 0) + COALESCE(great, 0) + COALESCE(good, 0) + COALESCE(miss, 0)
  ) = (
    SELECT CASE
      WHEN c.freeze IS NOT NULL AND scores.ok IS NOT NULL
        THEN c.notes + c.freeze + COALESCE(c.shock, 0) - scores.ok - COALESCE(c.judge_sum_deficit, 0)
      ELSE c.notes
    END FROM charts c WHERE c.chart_id = scores.chart_id
  ) THEN 'match'
  ELSE 'check'
END
WHERE chart_id IS NOT NULL;

-- 4. Clear needs_review (and review_status / has_review_image) for scores
--    whose only review reason was the judge-sum mismatch. Every other
--    review condition from computeReviewReasons is re-checked here;
--    player_unresolved is approximated via raw_extraction, as in
--    0006/0007/0008.
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
