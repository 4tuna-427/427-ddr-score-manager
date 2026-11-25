# フレアタブ（第2タブ）撮影対応 — 設計書

**【2026-11-25 取り下げ】** ユーザーはフレアタブを基本的に表示しない運用のため、本設計（第2タブ撮影によるフレアスキル数値の記録）は実施しない。
フレアの達成度はメインのリザルト画面で、スコアランク表示（AAA等）の右上にある六角形バッジのローマ数字（I〜IX / EX）から判断するもので、これは現行の抽出（flare_rank）で既に記録できている。同日、抽出プロンプトにバッジの位置と読み方を明記する改善を行い、実写真3枚（EX / IX / III）で正しく読み取れることを検証した。フレアスキル数値の記録が必要になった場合のみ、以下の設計を再訪する。

作成: 2026-11-25（Phase 2.3）。**設計のみ。コードは未実装。**
前提: 詳細リザルトタブ（第1タブ）にはフレアスキルの数値表示が無い（Phase 0 で確認済み）。
フレアスキルの数値はリザルト画面の第2タブ（フレア結果タブ）にのみ表示される。

## 現状の確認（実装前に押さえた事実）

- `flare_skill` は Gemini の抽出スキーマ（`worker/src/gemini.ts` の `GEMINI_SCHEMA`、
  `worker/src/lib.ts` の `PlayerExtraction`）には既にあるが、**DB の `scores` テーブルには無い**。
  `scores` にあるのは `flare_rank` のみで、`buildFields` / `SCORE_COLUMNS` も `flare_skill` を保存しない。
  ROADMAP の「スキーマには flare_skill 欄が既にある」は抽出スキーマの話で、DB 保存には
  `ALTER TABLE scores ADD COLUMN flare_skill INTEGER;` のマイグレーション（0004）が別途必要。
- フレアタブにはスコア・判定内訳・EX スコア等の数値が無い（フレアスキルとランクのみが表示される想定）。
  そのためフレア写真だけではスコア行を新規作成できない。**既存のスコア行への追記が基本形**になる。
- 画像はサーバに保存しない（決定済み）。フレア写真も詳細タブと同じくアップロード時に解析して破棄する。

## 必要な実写真（ユーザーへの依頼）

フレアタブの実写真を **最低 3〜5 枚**、以下のバリエーションで提供してもらう:

1. フレアスキル値が異なるもの（例：スキル 0〜数百の範囲で 3 段階以上。値の桁数が変わる境界が望ましい）
2. フレアランクが異なるもの（例：ランク EX / VIII / V など。ランク表示の読み取り確認用）
3. ソロ 1 枚＋バーサス 1 枚（バーサス時は両プレイヤーのフレアスキルが並ぶレイアウトの確認用）
4. 撮影条件は既存の詳細タブ写真 6 枚と同等（正面・明るい・反射少なめ）。斜め・反射が強いものが 1 枚あると耐性の確認になる

あわせて、各写真について「どのプレイのフレアタブか」（曲名・難易度・プレイ日時）が分かると突合の正解データになる。
詳細タブの写真と同じプレイのフレアタブ写真が 1 組でもあると、突合の検証が確実になる。

## 抽出スキーマ案

詳細タブ用の現行スキーマ（`GEMINI_SCHEMA`）とは別に、フレア専用の小さいスキーマを用意する。
`photo_kind` で詳細タブかフレアタブかを Gemini に判別させる（誤判別時の安全策として、
クライアント側でアップロード時に種別を選べる UI も併設するのが望ましい）。

```jsonc
// flare 抽出スキーマ案（responseSchema は Gemini の部分集合に限る：大文字の型・nullable・$ref 不可）
{
  "type": "OBJECT",
  "properties": {
    "photo_kind": { "type": "STRING", "enum": ["flare"] },
    "song_title": { "type": "STRING", "nullable": true },
    "play_style": { "type": "STRING", "nullable": true, "enum": ["SP", "DP"] },
    "is_versus": { "type": "BOOLEAN" },
    "player_1": { "type": "OBJECT", "nullable": true, "properties": {
      "dancer_name": { "type": "STRING", "nullable": true },
      "difficulty": { "type": "STRING", "nullable": true, "enum": ["BEGINNER", "BASIC", "DIFFICULT", "EXPERT", "CHALLENGE"] },
      "level": { "type": "INTEGER", "nullable": true },
      "flare_rank": { "type": "STRING", "nullable": true, "enum": ["EX", "IX", "VIII", "VII", "VI", "V", "IV", "III", "II", "I", "NONE"] },
      "flare_skill": { "type": "INTEGER", "nullable": true }
    }, "required": ["dancer_name", "difficulty", "level", "flare_rank", "flare_skill"] },
    "player_2": { "type": "OBJECT", "nullable": true /* player_1 と同じ */ }
  },
  "required": ["photo_kind", "song_title", "play_style", "is_versus", "player_1", "player_2"]
}
```

プロンプトは詳細タブ用（`GEMINI_PROMPT`）を流用せず、フレア専用にする。
要点: フレアスキル数値は画面の該当箇所だけを読むこと、桁区切りカンマ除去、表示が無ければ null、
ダンサーネームは上部バナーのみ読むこと（詳細タブと同じ注意書き）。

## 既存スコアへの突合フロー案

フレア写真のアップロードは `POST /api/analyze` とは別フロー（例：`POST /api/analyze-flare`）にする。
詳細タブの抽出と違い、スコア行の新規作成はしない。

1. フレア抽出 → 自プレイヤー確定（`choosePlayer` を流用。`MY_DANCER_NAME` で判定）
2. 曲名寄せ（`findChartByTitle` を流用）→ `chart_id` を特定
3. 突合対象の検索：同一 `chart_id` かつ `played_at` がフレア写真の撮影日（JST）と同日のスコア行を
   新しい順に取得。`played_at` はクライアントが送る EXIF 撮影日時（`played_at` フィールド、既存の仕組みを流用）
4. 候補が 1 件ならその行に `flare_skill` / `flare_rank` を UPDATE（`flare_rank` は既存列あり）
5. 候補が 0 件の場合：そのままでは保存先が無いので、行は作らず `409` 相当で「対応する詳細タブの記録がありません」と返す。
   フレア写真だけ先に来たケースの扱い（保留キューに入れて後から詳細タブが来たら紐付ける等）は別途検討が必要
6. 候補が複数件の場合：最も新しい 1 件に付けるか、`needs_review=1` の行を作って手動選択させるかを選択する。
   安全側の既定は「最も新しい 1 件に付け、レスポンスに候補件数を含める」。同日同一譜面を複数回プレイする運用では
   撮影時刻（EXIF）と `played_at` の近さで絞るのが望ましい（例：±30 分以内の行を優先）
7. 既に `flare_skill` が入っている行への再書き込みは上書き可とし、レスポンスに `previous_flare_skill` を含める

## Phase 0 式の検証手順

Phase 0（`phase0/`）と同じ手順で検証する:

1. 提供されたフレア写真について、目視で正解データ（ground truth JSON）を作る
   （`phase0/ground_truth/` と同じ形式で、フレア用の項目のみ。`phase0/validate.py` の流用は任意）
2. Phase 0 と同じ抽出スクリプト（`phase0/extract.py` 相当、モデルは `gemini-3.5-flash-lite`）で抽出し、
   全項目の一致率を計測する。成功基準：全項目で 95% 以上一致、かつ `flare_skill` の数値読み間違い 0 件
3. 突合フローはローカル D1 で検証する：詳細タブ由来のスコア行を入れた DB に対し、
   フレア抽出結果を突合させ、正しい行に付いたかを全件確認する（成功基準：突合 100%）
4. 検証で判明した読み間違いパターン（例：スキル値の桁読み違い、ランクのローマ数字の見間違い）は
   プロンプトに注意書きとして追加し、再検証する

## 実装時の作業項目（参考・未着手）

- [ ] マイグレーション `0004_flare_skill.sql`（`scores.flare_skill INTEGER` 追加）
- [ ] `worker/src/gemini.ts` にフレア用プロンプト＋スキーマ＋ `extractFlareFromImage` を追加
      （モデルフォールバックは `resolveModelList` を流用する）
- [ ] `POST /api/analyze-flare`（突合フロー上記 1〜7。`lib.ts` に突合の純関数＋単体テスト）
- [ ] PWA：アップロード時に種別（詳細/フレア）を選ぶ UI、フレア解析結果の表示、
      スコア詳細ページでのフレアスキル表示（`flare_skill` が入った行のみ）
- [ ] `docs/API.md` / `DEPLOY.md` の更新（0004 マイグレーションの適用手順を含む）
- [ ] Phase 0 式の検証レポート（`phase0/` と同じ場所に残す）
