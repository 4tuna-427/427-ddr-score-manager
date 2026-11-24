# API・データ契約（Phase 1 MVP 固定仕様）

実装はこの契約に厳密に従うこと。フロントとバックエンドはこのファイルだけを共有前提とする。

## 認証
- 全 `/api/*` はヘッダ `X-API-Token: <token>` 必須（Workers の環境変数 `API_TOKEN` と一致）。`GET /api/health` のみ認証不要。
- フロントは設定画面で入力されたトークンを localStorage に保持し、全リクエストに付ける。

## D1 スキーマ（migrations/0001_init.sql）
```sql
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
```

## エンドポイント
### GET /api/health → `{ok:true}`

### POST /api/analyze
- リクエスト: `multipart/form-data`、フィールド `file`（画像）、任意で `source`、任意で `played_at`（ISO文字列。写真の撮影日時=EXIF由来。妥当な範囲（2010年以降・未来+1時間以内）ならその値を scores.played_at に採用し、無効ならアップロード時刻を使う）。
- 重複検出: 受信画像バイト列の SHA-256 を scores.image_hash と照合し、一致したら Gemini を呼ばずに `409 {error:"duplicate", score_id}` を返す（migration 0002 適用後に有効。未適用時はチェックをスキップ）。
- 処理: 画像を長辺1600px相当のまま Gemini に送信（Workers では受け取った Blob をそのまま中継し、リサイズはフロント側で行う前提。未リサイズでも受け付ける）→ 抽出 → 自プレイヤー確定 → 曲名寄せ → 検算 → D1保存。
- 自プレイヤー確定: 環境変数 `MY_DANCER_NAME`（例 4TUNA）と正規化比較（大文字小文字無視、前後空白除去）で一致したプレイヤーを採用。ソロは player_1。バーサスで両方一致しない場合は player_1 を仮採用し `needs_review=1`、`raw_extraction` に全体を保存。
- 曲名寄せ: 抽出タイトルを正規化（NFKC、ゼロ幅除去、記号・空白除去、小文字化）して songs.title_normalized と完全一致を検索。一意なら chart を特定（play_style+difficulty）。複数候補・不一致なら chart_id=NULL、needs_review=1。
- 検算: EX = (marvelous+ok)*3 + perfect*2 + great。判定合計 = marvelous+perfect+great+good+miss と charts.notes+shock を比較（charts が無い/notes が無い場合は 'no_master'）。不一致は needs_review=1。
- レスポンス 201: `{score: <scores行>, previous: {score, ex_score, diff, played_at} | null}`（previous は同一 chart の直前レコード）

### GET /api/browse?q=&style=&difficulty=&level=&version=&played=&sort=&limit=&offset=
→ 譜面ブラウズ。マスタ全譜面に自己ベスト集計を結合して返す `{items, total}`。
- 絞り込み: `q`（曲名の正規化部分一致 or アーティスト部分一致）、`style` SP/DP、`difficulty`、`level`（完全一致）、`version`（完全一致）、`played` = played|unplayed
- `sort`: level（既定）| title | best（ベストスコア降順、未プレイは最後）| recent（最終プレイ降順、未プレイは最後）
- 各 item: 譜面・曲情報＋ `best_score` / `plays` / `last_played`、ベスト記録の `best_ex_score` / `best_rank` / `best_lamp`

### GET /api/browse/facets
→ `{versions: [...]}`（songs に存在するバージョン一覧、絞り込みUI用）

### GET /api/summary/latest-day
→ 直近のプレイ日（JST基準）のサマリ `{date, total_plays, unique_charts, updates}`。`updates` はその日に自己ベストを更新した譜面（同日複数プレイは最良のみ）で、各要素はスコア行＋ `prev_best`（その日より前の自己ベスト）/ `diff` / `is_new`（初プレイ）。スコアが無い場合は `date: null`。
※ スコア行には `chart_max_ex`（譜面の最大EXスコア）が付く（scores 一覧・詳細・export・summary 共通）。EX達成率は `ex_score / chart_max_ex` でクライアントが算出する。

### GET /api/export
→ 全スコア（songs 結合つき、played_at 昇順）を `{exported_at, count, scores}` で返す。`Content-Disposition: attachment` つきのバックアップ用JSON。

### GET /api/scores?limit=50&offset=0&needs_review=0|1
→ `{items: [<scores行 + song_title, artist>], total}`（played_at 降順）

### GET /api/scores/:id → `{score}`

### PATCH /api/scores/:id
- ボディ: 修正したいフィールドのみ（score, ex_score, marvelous..miss, ok, rank, clear_lamp, flare_rank, max_combo, fast_count, slow_count, difficulty, level）
- 保存後に検算を再実行して ex_check / judge_sum_check / needs_review を更新（全チェックが match なら needs_review=0 に戻す。ただし chart_id が NULL の間は needs_review=1 のまま）

### POST /api/scores/:id/select-player  `{player: 1|2}`
- raw_extraction から指定プレイヤーの値で scores を作り直し、名寄せ・検算を再実行する。

### POST /api/scores/:id/link  `{chart_id}`
- chart を紐付け直し、検算を再実行する。

### GET /api/songs?q=... → `{items: [{song_id, title, artist, charts: [{chart_id, play_style, difficulty, level}]}]}`（正規化部分一致、最大20件）

### GET /api/charts/:chart_id/history → `{chart: {...song情報付き}, items: [<scores行> played_at 昇順]}`

### POST /api/admin/sync  `{url?: string}`
- 既定URLは環境変数 `MASTER_URL`（無ければ https://4tuna-427.github.io/ddr-song-data/songs.json ）
- v1形式（levels が `single_*_level` 等のフラット）と v2形式（`levels`/`notecounts` オブジェクト）の両方を自動判別して upsert する。v1 で notecounts が無い場合、既存 charts の notes/freeze/shock は上書きしない（保持）。
- レスポンス: `{songs: n, charts: m}`

## Gemini 連携
- エンドポイント: `POST https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent`、ヘッダ `x-goog-api-key: {GEMINI_API_KEY}`（どちらも Workers 環境変数/シークレット。GEMINI_MODEL 既定 gemini-3.5-flash-lite）
- プロンプトとスキーマは Phase 0 の確定版を使う: `../../phase0/prompt.md` の内容（＋ダンサーネームは上部バナーのみ読む旨の1行追加）と `../../phase0/gemini_schema_api.json`。worker のソース内に定数として埋め込む。
- 画像は base64 で inline_data として送る。mime は受け取ったファイルの type を使う。

## フロントエンド要件
- Vite + React + TypeScript。PWA: Web App Manifest（`share_target` は POST + multipart、action `/share`）＋ Service Worker（share の POST を受けて IndexedDB に保存し `/upload` へリダイレクトする定番方式）。ライブラリは vite-plugin-pwa を使ってよい。
- 画像送信前にブラウザ側で長辺1000px・WebP（quality 0.82）に変換する。
- オフライン時: 送信キューを IndexedDB に保持し、オンライン復帰時に自動再送する（最低限、キュー一覧と手動再送ボタンでも可だが自動再送まで実装する）。
- 画面: (1) ホーム/アップロード（ファイル選択＋キュー状態） (2) 登録結果はアップロード直後に表示（前回比diff） (3) 履歴一覧（曲名・難易度・スコア・日付、needs_review バッジ） (4) スコア詳細（数値タップで編集→PATCH、バーサス時はプレイヤー切替、未紐付け時は曲検索→link） (5) 譜面別グラフ（履歴から遷移、Recharts の LineChart でスコア遷移） (6) 要確認一覧（needs_review=1 のみ） (7) 設定（APIトークン、APIベースURL）
- APIベースURL: 開発時は相対 `/api` でよいが、Pages と Workers が別ドメインになる構成を想定し、設定で変更可能にする（localStorage、既定は空＝相対）。
- デザインは質素でよい。モバイル幅優先。
