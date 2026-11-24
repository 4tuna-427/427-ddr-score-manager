CREATE TABLE songs (
  song_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  artist TEXT,
  version TEXT,
  bpm TEXT,
  phash_8 TEXT,
  phash_16 TEXT,
  availability TEXT,
  deleted_at TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_songs_norm ON songs(title_normalized);

CREATE TABLE charts (
  chart_id TEXT PRIMARY KEY,          -- "{song_id}|{SP|DP}|{BEGINNER|BASIC|DIFFICULT|EXPERT|CHALLENGE}"
  song_id TEXT NOT NULL REFERENCES songs(song_id),
  play_style TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  level INTEGER,
  notes INTEGER,
  freeze INTEGER,
  shock INTEGER,
  max_ex INTEGER                      -- (notes+freeze+shock)*3、算出不能なら NULL
);
CREATE INDEX idx_charts_song ON charts(song_id);

CREATE TABLE scores (
  id TEXT PRIMARY KEY,                -- ULID 相当のランダムID（実装側で生成）
  chart_id TEXT REFERENCES charts(chart_id),
  song_id TEXT,
  raw_title TEXT,
  play_style TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  level INTEGER,
  score INTEGER NOT NULL,
  ex_score INTEGER,
  rank TEXT,
  clear_lamp TEXT,
  flare_rank TEXT,
  marvelous INTEGER, perfect INTEGER, great INTEGER, good INTEGER, ok INTEGER, miss INTEGER,
  fast_count INTEGER, slow_count INTEGER,
  max_combo INTEGER,
  ex_check TEXT,                      -- 'match'|'mismatch'|'no_ex'
  judge_sum_check TEXT,               -- 'match'|'check'|'no_master'
  needs_review INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'share',  -- 'share'|'upload'|'manual'
  raw_extraction TEXT,                -- Gemini抽出JSON全体（バーサス時のプレイヤー再選択用）
  played_at INTEGER NOT NULL,         -- epoch ms
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_scores_chart_played ON scores(chart_id, played_at);
CREATE INDEX idx_scores_played ON scores(played_at);
