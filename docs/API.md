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
  max_ex INTEGER                      -- (notes+freeze)*3（notes は shock 込みの MAX COMBO）、算出不能なら NULL
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
- リクエスト: `multipart/form-data`、フィールド `file`（画像）、任意で `source`、任意で `played_at`（ISO文字列。写真の撮影日時=EXIF由来。妥当な範囲（2010年以降・未来+1時間以内）ならその値を scores.played_at に採用し、無効ならアップロード時刻を使う）、任意で `bulk`（`1` のとき一括取り込みモード：Gemini のモデル内リトライを1回に縮小する）。
- 無料枠切れ: 試した全モデルが最終的に 429 で失敗した場合は `429 {error:"quota_exhausted", detail}` を返す（クライアントはその日の送信を止める）。それ以外の抽出失敗は従来どおり `502`。
- 重複検出: 受信画像バイト列の SHA-256 を scores.image_hash と照合し、一致したら Gemini を呼ばずに `409 {error:"duplicate", score_id}` を返す（migration 0002 適用後に有効。未適用時はチェックをスキップ）。
- 非詳細タブのスキップ: 抽出の `result_tab` が詳細リザルト（DETAIL）以外（プレーグラフ/フレア等）の場合、判定データが存在しない画像として登録せず `200 {skipped:true, reason:"not_detail_result", song_title}` を返す（クライアントはエラー扱いせずキューから除き、スキップとして表示する）。判定の優先順位は (1) 判定一式が揃い EX検算（＋譜面特定時は判定合計の恒等式）も一致する読み取りは、タブ報告が誤っていても詳細リザルトとみなす (2) `result_tab` の報告 (3) `result_tab` が得られなかった場合のフォールバック（EX SCORE・MAX COMBO が無く判定の大半も欠けた読み取りを非詳細とみなす）。タブ名が読めなかった（null）だけでは登録は妨げられない。
- 処理: 画像を長辺1600px相当のまま Gemini に送信（Workers では受け取った Blob をそのまま中継し、リサイズはフロント側で行う前提。未リサイズでも受け付ける）→ 抽出 → 自プレイヤー確定 → 曲名寄せ → 検算 → D1保存。
- 自プレイヤー確定: 環境変数 `MY_DANCER_NAME`（例 4TUNA）と正規化比較（大文字小文字無視、前後空白除去）で一致したプレイヤーを採用。ソロは player_1。バーサスで両方一致しない場合は player_1 を仮採用し `needs_review=1`、`raw_extraction` に全体を保存。
- 曲名寄せ: 抽出タイトルを正規化（NFKC、ゼロ幅除去、記号・空白除去、小文字化）して songs.title_normalized と完全一致を検索。一意なら chart を特定（play_style+difficulty）。完全一致が無い場合はあいまい照合（末尾の【アーティスト】等の除去、混同しやすい文字 1/l/i・0/o の畳み込み、編集距離ベースの類似度）にフォールバックし、類似度 0.90 以上で2位に明確な差がある場合のみ自動で紐付ける。それ以外は chart_id=NULL、needs_review=1（要確認画面に候補が提示される）。
- 検算: EX = (marvelous+ok)*3 + perfect*2 + great。判定合計 = marvelous+perfect+great+good+miss は、リザルト画面の仕様（フリーズNG・ショック被弾は Miss 扱い、保持フリーズ・回避ショックは O.K.）により charts.notes + charts.freeze + COALESCE(charts.shock, 0) − ok と比較する（freeze か ok が無い場合は notes と比較。charts が無い/notes が無い場合は 'no_master'）。また ok > freeze + COALESCE(shock, 0)、max_combo > notes + COALESCE(shock, 0) も異常値として検出し、不一致・異常は needs_review=1。なお O.K. の末尾に隣接項目（Good/Miss）の数字が混入する誤読（例: 8→80）については、末尾桁を落とした候補で EX検算と判定合計の両方が一致し上限にも収まる場合に限り、取り込み時に自動補正する（証明できない場合は補正せず要確認に残す。原読取は raw_extraction に残る）。
- 同時フリーズの不足（migration 0009）: 同じタイミングで始まるフリーズはゲーム内で1イベントとして数えられるため、マスタが矢印本数で数える freeze との差が譜面ごとに固定の不足 P（= 同時開始グループの Σ(本数−1)）になる。不足のみ・EX検算一致・判定合計だけが要確認理由のプレイは、その不足分を charts.judge_sum_deficit として学習し（取り込み時と /api/admin/relink の再チェック時。学習済みの値は上書きしない）、以後は期待合計から P を引いて照合する。余り（+方向）は学習せず従来どおりフラグを立てる。日次マスター同期はこの列を比較・上書きしない。Blew My Mind CSP は P=1 をマイグレーションで初期値として入れてあり、1116 CSP はマスタの freeze 数が資料間で食い違う（13 と 14）ため初期値は入れず、学習に任せる。
- レスポンス 201: `{score: <scores行>, previous: {score, ex_score, diff, played_at} | null}`（previous は同一 chart の直前レコード）

### GET /api/browse?q=&style=&difficulty=&level=&version=&category=&played=&sort=&dir=&limit=&offset=
→ 譜面ブラウズ。マスタ全譜面に自己ベスト集計を結合して返す `{items, total}`。各 item には `category` が付く。
- カテゴリ: 楽曲の収録バージョン（フォルダ＝初出バージョン。後から追加された譜面では分類しない）で判定する。CLASSIC = 1st〜X3 VS 2ndMIX / WHITE = (2013)〜A / GOLD = A20〜WORLD。判定は lib の `songCategory`（表記ゆれ吸収つき）。songs.version は「現行フォルダ ?? RemyWiki初出」の順で格納済みで、全1,485曲が分類できる（CLASSIC 479曲 / WHITE 306曲 / GOLD 700曲）。
- 絞り込み: `q`（曲名の正規化部分一致 or アーティスト部分一致）、`style` SP/DP、`difficulty`、`level`（完全一致）、`version`（完全一致）、`category` = CLASSIC|WHITE|GOLD、`played` = played|unplayed
- `sort`: level（既定）| title | notes（ノーツ数）| bpm | plays（プレイ回数）| best（ベストスコア）| recent（最終プレイ）。各キーに既定の方向があり（level/title=昇順、それ以外=降順）、`dir=asc|desc` で上書きできる。NULL の項目（ノーツ数なし・未プレイ等）は方向によらず常に最後。BPM は範囲表記（"80-160"）の場合に上限値で比較する。各行には `notes`（ノーツ数、無い譜面は null）も含まれる
- 各 item: 譜面・曲情報＋ `best_score` / `plays` / `last_played`、ベスト記録の `best_ex_score` / `best_rank` / `best_lamp`、`has_jacket`（ジャケット画像が KV にある曲は 1）

### GET /api/jackets/:song_id
→ ジャケット画像（JPEG）を返す。画像は KONAMI の著作物のため公開せず、Workers KV に置いてこの認証つきエンドポイントでのみ配信する。マスタ配信（songs.json）の各曲 `jacket: true/false` が同期で `songs.has_jacket` になる。KV バインディング未設定、または該当曲の画像が無い場合は 404。レスポンスは `Cache-Control: private, max-age=86400`。

### GET /api/browse/facets
→ `{versions: [...]}`（songs に存在するバージョン一覧、絞り込みUI用）

### GET /api/summary/latest-day
→ 直近のプレイ日（JST基準）のサマリ `{date, total_plays, unique_charts, updates}`。`updates` はその日に自己ベストを更新した譜面（同日複数プレイは最良のみ、played_at 降順＝新しい順）で、各要素はスコア行＋ `prev_best`（その日より前の自己ベスト）/ `diff` / `is_new`（初プレイ）。スコアが無い場合は `date: null`。
※ スコア行には `chart_max_ex`（譜面の最大EXスコア）が付く（scores 一覧・詳細・export・summary 共通）。EX達成率は `ex_score / chart_max_ex` でクライアントが算出する。

### GET /api/stats
→ 統計・達成状況 `{totals, by_level, by_category, monthly, ex_rate_by_level, calendar, flare}`。
- `graphs`: 統計ページのグラフ用集計。`level_monthly`（月別×レベルのプレイ数。月は `monthly` と同じ直近12か月のJST月）、`judge_daily`（JSTプレイ日ごとの判定合計と判定ありプレイ数。プレイの無い日は含まない）、`coverage`（スタイル×レベル×難易度ごとの {total, played, cleared}。cleared はクリアランプ CLEAR 以上を1回以上記録した譜面数、難易度は chart_id の第3要素から取得）。
- `flare`: `{by_rank, charts_with_flare, targets}`。フレアスキルの合計値や称号ランクは扱わない（ユーザーの方針: アプリの目的は履歴の保存と成長の可視化）。
  - `by_rank`: 譜面ごとの「クリアした最高フレアランク」（I=1..IX=9, EX=10）の分布（強い順）。クリアランプがあるプレイのみ対象（FAILED のバッジ読み取りは数えない）。フレア無しクリアは含まない。
  - `targets`: 現在のフレア目標コンボ（`FLARE_TARGETS` = 16EX / 17EX / 17IX / 18IX）ごとの `{level, min_rank, achieved[], achieved_count, candidates[], candidate_count}`。達成 = そのレベルの譜面を目標以上のフレアランクでクリア済み（EXクリアはIX目標も満たす）。候補 = そのレベルをクリア済みだが目標ランク未満（現在の最高フレアランク付き、近い順）。一覧は achieved 最大50件・candidates 最大20件に切り詰め、件数は実数。
  - 楽曲ブラウズ（GET /api/browse）の各行には `best_flare_rank`（その譜面の全プレイ中の最高フレアランク）が付く。
- 集計単位は譜面ごとのベスト達成：ランプとランクは「ベストスコアのプレイ」ではなく全プレイ中の最良を採用（低スコアでもFCしたプレイがあればFC扱い）。LIFE4 はクリア扱いで FC には数えない。
- `totals`: 全譜面に対するバケット＋ `plays`（総プレイ数）/ `play_days`（JSTのプレイ日数）/ `aaa`（ベストランクAAAの譜面数）/ `max_clear_level`（クリア済み最大レベル、無ければ null）。
- バケット共通フィールド: `total_charts`（マスタ譜面数）/ `played` / `clear` / `fc` / `gfc` / `pfc` / `mfc`（各しきい値以上の譜面数）。
- `by_level`: `{play_style, level, ...バケット}`（SP→DP、レベル降順）。`by_category`: `{category, ...バケット}`（GOLD/WHITE/CLASSIC の順、カテゴリは曲のバージョンで判定）。
- `monthly`: 直近12か月（JST）`{month: "YYYY-MM", plays, pb_updates, avg_ex_rate}`。`pb_updates` は既プレイ譜面の自己ベスト更新回数（初プレイは含まない）。`avg_ex_rate` はその月の全プレイの平均EX率（%・小数1桁。ex_score と譜面の max_ex があるプレイのみ対象。該当プレイが無ければ null）。chart_id 未紐付けのプレイは totals.plays と monthly.plays にのみ数える。
- `ex_rate_by_level`: `{play_style, level, avg_ex_rate, charts}`（SP→DP、レベル降順）。各譜面はベストEX率（ベスト ex_score / max_ex）を1回だけ寄与する。`charts` は寄与した譜面数。max_ex が無い譜面は対象外。
- `calendar`: 直近365日（JST）の日別プレイ数 `[{date: "YYYY-MM-DD", plays}]`（プレイが無い日は省略）。

### GET /api/versus
→ 対戦履歴 `{opponents, recent}`。各スコア行の `raw_extraction`（バーサス時の相手側リザルト）を解析する。`MY_DANCER_NAME` と一致する側を自分、もう一方を相手とする。
- `opponents`: 相手ダンサーネーム別 `{name, plays, wins, losses, draws, last_played_at}`（対戦数降順）。勝敗は両者のスコア比較。どちらかのスコアが無ければその対戦は plays に数えるが勝敗には数えない。
- `recent`: 直近10件 `{score_id, opponent, song_title, my_score, opp_score, result, played_at}`（`result`: win/loss/draw/unknown）。
- 対象外として安全にスキップする行: raw_extraction が無い/壊れている、バーサスでない、どちらも自名に一致しない、相手名が無い。`MY_DANCER_NAME` 未設定時は常に空を返す。

### GET /api/targets / POST /api/targets / DELETE /api/targets/:chart_id
→ 譜面ごとの目標設定（`targets` テーブル。migration 0003 が必要）。
- `GET /api/targets` → `{items: [{chart_id, target_score, target_lamp, updated_at, song_title, artist, play_style, difficulty, level, best_score}]}`（曲名順）。`?chart_id=...` を付けると `{target: ... | null}` を返す。
- `POST /api/targets` `{chart_id, target_score?, target_lamp?}` → upsert。`target_score` は 0〜1,000,000 の整数、`target_lamp` は CLEAR/LIFE4/FC/GFC/PFC/MFC のいずれか。どちらか一方は必須。存在しない chart_id は 404。レスポンス `{target}`（best_score 付き）。
- `DELETE /api/targets/:chart_id` → `{deleted: true}`。目標が無ければ 404。
- 進捗（ベストとの差）はクライアントが算出する。ベストランプは全プレイ中の最良（統計と同じ定義）。

### GET /api/close-calls
→ あと少しリスト `{items}`。各譜面のベストスコアのプレイから、AAA（990,000点）まで 10,000 点以内のものと、次のランプまで判定 5 個以内のものを抽出する（`kind: "aaa" | "lamp"`、`gap` は AAA までの点数差または次ランプまでの判定数、`next_lamp` はランプ種のみ付く）。ランプの距離は lib の `lampGap`（CLEAR/LIFE4→FC は Miss 数、FC→GFC は Great+Good−1、GFC→PFC は Great+Good、PFC→MFC は Perfect 数。FAILED は対象外）。ランプ種を先に、各グループ内で gap 昇順。譜面は1件につき最大2エントリ（aaa/lamp）。各 item には曲名・アーティスト・譜面情報が付く。

### POST /api/import
→ エクスポート JSON（`{scores: [...]}`、GET /api/export の形式）の取り込み。`{imported, skipped, errors, error_count}` を返す。
- 形式検証: `id`（必須・文字列）、`score`（0〜1,000,000の整数）、`played_at`（正の整数・epoch ms）、`play_style`（SP/DP）、`difficulty`（必須）、その他は整数/null・文字列/null の型チェック。不適合の行は `errors`（最大20件、`{index, reason}`）に記録し取り込まない。
- 重複排除: 同じ `id` または同じ `image_hash`（非 null の場合）の行はスキップする（`skipped` に数える）。ペイロード内の重複も同様。export に含まれる結合フィールド（song_title / artist / chart_max_ex）は無視する。
- 取り込みは 100 件ずつのバッチで INSERT する。失敗したバッチの行は `errors` に記録する（image_hash 列が無い DB では失敗するため、migration 0002 適用済みであること）。

### GET /api/export
→ 全スコア（songs 結合つき、played_at 昇順）を `{exported_at, count, scores}` で返す。`Content-Disposition: attachment` つきのバックアップ用JSON。

### GET /api/scores?limit=50&offset=0&needs_review=0|1
→ `{items: [<scores行 + song_title, artist>], total}`（played_at 降順）
- chart_id が NULL の行には `candidates`（あいまい照合の上位候補、最大3件: `{chart_id, song_id, title, artist, score}`。その行の play_style/difficulty の譜面が存在する候補のみ）が付く。要確認画面のワンタップリンク用。

### GET /api/scores/:id → `{score}`（未リンク時は `candidates` が付く）

### DELETE /api/scores/:id
- スコア記録を削除する（存在しない曲名の誤読レコード等の除去用）。→ `{ok: true}`、無ければ 404。

### POST /api/admin/relink
- chart_id が NULL の全スコアについて曲名寄せ（完全一致＋あいまい照合）を再実行し、特定できたものを紐付けて検算を再実行する。→ `{checked, linked, remaining}`

### PATCH /api/scores/:id
- ボディ: 修正したいフィールドのみ（score, ex_score, marvelous..miss, ok, rank, clear_lamp, flare_rank, max_combo, fast_count, slow_count, difficulty, level）
- 保存後に検算を再実行して ex_check / judge_sum_check / needs_review を更新（全チェックが match なら needs_review=0 に戻す。ただし chart_id が NULL の間は needs_review=1 のまま）

### POST /api/scores/:id/select-player  `{player: 1|2}`
- raw_extraction から指定プレイヤーの値で scores を作り直し、名寄せ・検算を再実行する。

### POST /api/scores/:id/link  `{chart_id}`
- chart を紐付け直し、検算を再実行する。

### マスタ修正（chart_corrections、migration 0010）
- 配信マスタのノーツ数が実譜面と違う場合の恒久修正。D1 の charts を直接直しても毎日の同期で戻るため、修正は `chart_corrections` テーブルに保持し、`POST /api/admin/sync` と Cron 同期が毎回「マスタ＋修正」の実効値を書き込む（`applyCorrections`）。NULL のフィールドは修正なし。
- ライフサイクル: アプリで暫定修正 → パイプライン（notecount_overrides.json）へ昇格 → 配信マスタが追いついたら D1 側を畳む。同期のたびに「修正の全項目がマスタと一致する譜面」を `redundantCorrections` として検出する（`findRedundantCorrections`）ので、畳み時はそれを見て DELETE する。マスタに無い譜面や、まだ値が違う修正は検出対象外。
- `judge_sum_mismatch` の detail には、余り（read > expected）の場合のみ `implied_notes`（このプレイが証明する正しい notes）が付く。不足は同時フリーズで説明できるため付けない。

### POST /api/scores/:id/correct-master-notes  `{reason?: string}`
- 要確認プレイからワンタップでマスタ notes を修正する。条件: EX検算が match、理由が judge_sum_mismatch を含む、恒等式から逆算した notes（`impliedMasterNotes`）が現在のマスタ notes より大きい（余り）。不足の場合は 400（同時フリーズ学習の担当）。
- 修正を `chart_corrections` に登録し、charts 行へ即時反映（max_ex 再計算）、その譜面の要確認プレイを再チェックする。→ `{chart_id, notes, max_ex, resolved}`

### GET /api/corrections
- 登録済みのマスタ修正一覧（曲名・譜面情報付き、updated_at 降順）。→ `{corrections: [...]}`

### PUT /api/charts/:chart_id/correction  `{notes?, freeze?, shock?, reason?}`
- 明示値で修正を登録・更新する。各カウントは「非負整数＝上書き、null＝その項目の修正を解除、キー無し＝変更なし」。全項目が null になれば行ごと削除。
- 登録後にマスタ同期を実行して charts 行を「マスタ＋修正」で再導出する（取得失敗時はマージ値を直接反映し `synced: false`）。その譜面の要確認プレイも再チェックする。→ `{chart_id, correction, synced, resolved}`

### DELETE /api/charts/:chart_id/correction
- 修正を削除し、マスタ同期で charts 行を配信値に戻す（同期失敗時は次回同期で戻る）。→ `{chart_id, correction: null, synced, resolved}`

### GET /api/songs/by-phash?phash=...&max_distance=20&limit=5
→ ジャケット pHash（16桁hex＝64bit、`songs.phash_8`）にハミング距離が近い曲を返す `{items: [{song_id, title, artist, distance, charts}]}`（距離昇順、最大5件）。`phash` が16桁hexでない場合は 400。
- **精度の注意（Phase 2.4 検証結果）**: Phase 0 の実写真6枚で検証したところ、正しい曲までの距離は 18〜36（順位 2〜1271位）で、無関係の曲が 16〜20 で一致することもあった。画面写真のモアレ・反射・斜め撮影と `jacket_bbox` の精度が支配的で、**このエンドポイントの候補を自動リンクに使ってはいけない**。候補提示として使う場合も、距離の小ささは一致の証明にならない。ブラウザ側の計算は `web/src/lib/phash.ts`（標準的な imagehash 式 pHash。TS 実装と Python 参照実装の一致は 6 枚全てで確認済み）。
- `max_distance`（既定20、0〜64）、`limit`（既定5、1〜20）で調整できる。phash が無い 36 曲は対象外。

### GET /api/songs?q=... → `{items: [{song_id, title, artist, charts: [{chart_id, play_style, difficulty, level}]}]}`（正規化部分一致、最大20件）

### GET /api/charts/:chart_id/history → `{chart: {...song情報付き}, items: [<scores行> played_at 昇順]}`

### POST /api/admin/sync  `{url?: string}`
- 既定URLは環境変数 `MASTER_URL`（無ければ https://4tuna-427.github.io/ddr-song-data/songs.json ）
- v1形式（levels が `single_*_level` 等のフラット）と v2形式（`levels`/`notecounts` オブジェクト）の両方を自動判別して upsert する。v1 で notecounts が無い場合、既存 charts の notes/freeze/shock は上書きしない（保持）。
- 差分があった行だけを書き込む（`planSync`）。マスタが持たない項目（null）は変更とみなさない。
- `chart_corrections`（migration 0010）の修正はマスタへ重ねてから差分判定する。実効値で同期するため、登録済みの修正が同期で配信値に戻ることはない。
- レスポンス: `{songs: n, charts: m, songWrites: w1, chartWrites: w2, redundantCorrections: [chart_id...]}`（songs/charts はマスタ全体の件数、Writes は実際に書き込んだ行数。redundantCorrections は配信マスタが追いついて不要になった修正の一覧＝畳める修正。Cron 同期でも該当がある場合のみログに `redundant_corrections=` として残る。自動削除はしない）
- 自動同期: Worker の Cron Trigger（毎日 04:00 JST、wrangler.toml の `[triggers]`）が同じ処理を実行する。失敗時は Worker のログに `[cron sync] failed:` が残る（手動エンドポイントはフォールバック）。

## Gemini 連携
- エンドポイント: `POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent`、ヘッダ `x-goog-api-key: {GEMINI_API_KEY}`（どちらも Workers 環境変数/シークレット。GEMINI_MODEL 既定 gemini-3.5-flash-lite）
- モデルフォールバック: モデルは優先順リストで試す。既定は `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`（各500回/日の無料枠が別枠のため併用で実質1,000枚/日。2.5-flash-lite はこのプロジェクトで 404＝提供終了のため使わない。3.1 は Phase 0 実画像で 151/152＝99.3%・検算全件パスを実測済み）。`GEMINI_MODEL`（wrangler.toml の `[vars]`）でプライマリを変更でき、`GEMINI_MODELS`（カンマ区切り、シークレット/変数で設定）に指定するとリスト全体を上書きする。各モデル内では 503/429 を最大3回リトライ（1.5s/4s/9s、一括モード時は1回・4s）し、404 またはリトライ切れの 503/429 で次モデルへ移る。400/401/403 などは即失敗する。全モデルが最終的に 429 の場合は枠切れとして `GeminiQuotaExhaustedError` を投げ、`/api/analyze` は 429 を返す。
- プロンプトとスキーマは Phase 0 の確定版を使う: `../../phase0/prompt.md` の内容（＋ダンサーネームは上部バナーのみ読む旨の1行追加）と `../../phase0/gemini_schema_api.json`。worker のソース内に定数として埋め込む。
- 画像は base64 で inline_data として送る。mime は受け取ったファイルの type を使う。

## フロントエンド要件
- Vite + React + TypeScript。PWA: Web App Manifest（`share_target` は POST + multipart、action `/share`）＋ Service Worker（share の POST を受けて IndexedDB に保存し `/upload` へリダイレクトする定番方式）。ライブラリは vite-plugin-pwa を使ってよい。
- 画像送信前にブラウザ側で長辺1000px・WebP（quality 0.82）に変換する。
- オフライン時: 送信キューを IndexedDB に保持し、オンライン復帰時に自動再送する（最低限、キュー一覧と手動再送ボタンでも可だが自動再送まで実装する）。
- 画面: (1) ホーム/アップロード（送信フォームを最上部に配置、ファイル選択＋キュー状態。送信エラーの詳細は画面に出さず設定のエラーログに記録） (2) 登録結果はアップロード直後に表示（前回比diff） (3) 履歴一覧（曲名・難易度・スコア・日付、needs_review バッジ） (4) スコア詳細（数値タップで編集→PATCH、バーサス時はプレイヤー切替、未紐付け時は候補ワンタップ／曲検索→link、記録の削除） (5) 譜面別グラフ（履歴から遷移、Recharts の LineChart でスコア遷移） (6) 要確認一覧（needs_review=1 のみ。再マッチング、候補リンク、削除） (7) 設定（APIトークン、APIベースURL、テーマ、バックアップ/復元、エラーログ）
- 難易度表記: バッジ・ラベルはプレイヤー表記（難易度頭文字＋SP/DP＋レベル、例 `CSP 17`、BEGINNER は小文字 `bSP`）を使う。「EX」は EXスコア と明記し、フレアランクEX・フレアゲージEX と混同しない。
- APIベースURL: 開発時は相対 `/api` でよいが、Pages と Workers が別ドメインになる構成を想定し、設定で変更可能にする（localStorage、既定は空＝相対）。
- デザインは質素でよい。モバイル幅優先。
