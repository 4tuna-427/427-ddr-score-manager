-- 0010: user-registered corrections to chart master notecounts.
--
-- The delivered master (songs.json, sourced from community wikis) can
-- carry a wrong notecount: Snow Garland Fairy ESP is listed as 593
-- notes while the game's own MAX COMBO (595) and a verified play's
-- judge sum (595, EX cross-check matching) prove the chart has 595.
-- Editing the charts table directly would be reverted by the daily
-- master sync, so corrections live in their own table and syncMaster
-- overlays them onto the master on every run (applyCorrections in
-- worker/src/lib.ts). A NULL field means "no correction for it".
CREATE TABLE IF NOT EXISTS chart_corrections (
  chart_id TEXT PRIMARY KEY,
  notes INTEGER,
  freeze INTEGER,
  shock INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
