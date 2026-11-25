# デプロイ手順（Phase 1 MVP）

構成: Cloudflare Workers（API）＋ D1 ＋ Cloudflare Pages（PWA）。すべて無料枠・クレカ不要。
所要時間の目安: 30分程度。前提: Node.js と GitHub アカウント、Cloudflare アカウント。

## 0. 準備
```bash
cd app/worker && npm install
cd ../web && npm install
npx wrangler login   # worker フォルダで実行、ブラウザで Cloudflare にログイン
```

## 1. D1 データベース作成
```bash
cd app/worker
npx wrangler d1 create ddr-score-db
```
表示された `database_id` を `worker/wrangler.toml` の `database_id = "00000000-..."` と差し替える。

## 2. スキーマと初期マスタの投入
```bash
npx wrangler d1 execute ddr-score-db --remote --file ../migrations/0001_init.sql
```

### 既存DBへの追加マイグレーション（Phase 1.1）
Phase 1.1 の Worker は scores.image_hash に書き込むため、**Worker を再デプロイする前に**適用すること:
```bash
npx wrangler d1 execute ddr-score-db --remote --file ../migrations/0002_phase11.sql
```

### 既存DBへの追加マイグレーション（Phase 2.3）
Phase 2.3 の Worker は targets テーブルを使うため、**Worker を再デプロイする前に**適用すること:
```bash
npx wrangler d1 execute ddr-score-db --remote --file ../migrations/0003_targets.sql
```

### ジャケット画像（KV 配信）のセットアップ
ジャケット表示を使う場合のみ。**Worker を再デプロイする前に**マイグレーション 0004 を適用すること:
```bash
npx wrangler d1 execute ddr-score-db --remote --file ../migrations/0004_songs_jacket.sql
```
KV namespace を作成し、発行された ID を控える:
```bash
npx wrangler kv namespace create DDR_JACKETS
```
`worker/wrangler.toml` の末尾にある `[[kv_namespaces]]` ブロックのコメントを外し、`id` に上記 ID を入れてからデプロイする。画像の投入は ddr-song-data リポジトリ側のパイプラインが行う（同リポジトリの JACKETS.md 参照。GitHub Secrets の登録が必要）。KV が空の間は `has_jacket` が 0 のままなので、画面に変化はない。
初期マスタ（1,485曲・ノーツ数つき）はシードSQLを使う。ファイルが大きいので分割して投入する:
```bash
cd ../scripts
python3 - <<'EOF'
import pathlib
stmts=[l for l in pathlib.Path("seed_master.sql").read_text().splitlines() if l.startswith("INSERT")]
pathlib.Path("/tmp/chunks").mkdir(exist_ok=True)
for i in range(0,len(stmts),800):
    pathlib.Path(f"/tmp/chunks/c{i//800:02d}.sql").write_text("\n".join(stmts[i:i+800])+"\n")
print(len(stmts),"statements")
EOF
for f in /tmp/chunks/c*.sql; do (cd ../worker && npx wrangler d1 execute ddr-score-db --remote --file "$f"); done
```
確認: `npx wrangler d1 execute ddr-score-db --remote --command "SELECT count(*) FROM songs"` が 1485 になればOK。

## 3. シークレット登録（worker フォルダ）
```bash
npx wrangler secret put API_TOKEN        # 自分で決めた任意の長い文字列。PWAの設定画面に入れるものと同じにする
npx wrangler secret put GEMINI_API_KEY   # AI Studio で発行した無料枠キー（専用プロジェクトのもの）
npx wrangler secret put MY_DANCER_NAME   # 4TUNA
```

## 4. API デプロイ
```bash
npx wrangler deploy
```
表示された URL（例: `https://ddr-score-api.<account>.workers.dev`）を控える。

動作確認:
```bash
curl https://ddr-score-api.<account>.workers.dev/api/health
curl -H "X-API-Token: <API_TOKEN>" "https://ddr-score-api.<account>.workers.dev/api/songs?q=Roll"
```

## 5. フロントエンド（Pages）— 2ルートから選ぶ

API（手順1〜4）はどちらのルートでもローカルの wrangler から操作する。違うのはフロント（PWA）の上げ方だけ。

### ルートA：GitHub連携でデプロイ（推奨・宅建アプリと同じ方式）
push するたびに自動デプロイされ、Cloudflare側で前回デプロイへのロールバックもできる。
1. この `app/` を GitHub リポジトリに push する（例: `ddr-score-manager`）。`.gitignore` を同梱済みなので、手順0で作られた `node_modules/` や `web/dist/` は push されない
2. Cloudflare ダッシュボード → Workers & Pages → Create → Pages → Connect to Git でリポジトリを選択
3. ビルド設定: Root directory = `web`、Build command = `npm run build`、Output = `dist`、Framework preset = Vite
4. デプロイされた URL をスマホで開く
5. 更新時は `git push` するだけ（API側の変更がある場合は手順4の `wrangler deploy` も別途行う）

### ルートB：ローカルから wrangler で直接デプロイ（リポジトリ不要）
GitHub にリポジトリを作りたくない場合。更新のたびに下のコマンドを打つ形になる。
```bash
cd app/web && npm run build
cd ../worker && npx wrangler pages deploy ../web/dist --project-name ddr-score-manager
```
※ `web/` には wrangler が入っていないため、wrangler が入っている `worker/` フォルダから実行する（手順0で `npm install` 済み）。初回はプロジェクトが新規作成され、`https://ddr-score-manager.pages.dev` が表示される。2回目以降は同じコマンドで上書きデプロイされる。表示された URL をスマホで開く。

どちらを選んでも、PWA の動作・Share Target・APIとの接続は同じ。迷ったらルートAでよい。

## 6. 初期設定（スマホ）
1. PWA の「設定」タブで、APIベースURL に手順4の Workers URL、APIトークンに手順3の API_TOKEN を入れて保存
2. Chrome のメニューから「アプリをインストール」でホーム画面に追加（Share Target はインストール状態でのみ有効）
3. 試しにリザルト写真を1枚アップロードし、登録結果カードが出ること・履歴に残ることを確認

## 7. マスタの更新
- **自動同期（通常はこちら）**: Worker の Cron Trigger が毎日 04:00 JST（データパイプラインの 03:00 更新の1時間後）に配信中の v1 songs.json を取得し、差分があった曲・譜面だけを取り込む。Worker をデプロイすればトリガーも一緒に登録される。実行結果は Cloudflare ダッシュボードの Worker → Logs で `[cron sync]` を検索すると確認できる（失敗時は `[cron sync] failed:`）。
- 手動同期（フォールバック）も従来どおり可能:
  `curl -X POST -H "X-API-Token: <API_TOKEN>" https://<workers-url>/api/admin/sync -d '{}'`
  レスポンスの `songWrites` / `chartWrites` が実際に更新された行数（0 なら変更なし）。
- 注意: v1 songs.json はノーツ数を持たないため、新曲の譜面は notes が空のまま取り込まれる（判定合計チェックと EX 率表示はその譜面では効かない。レベル・曲名・アーティスト・削除曲の tombstone は自動で最新化される）。ノーツ数つきの最新シードが必要になったら、`scripts/make_seed.py` に最新の songs_v2.json を渡して再生成し、手順2の分割投入を再実行する。

## 注意・既知の制限
- Share Target は Android Chrome で PWA をインストールした場合のみ共有メニューに出る。ホーム画面ショートカットだけでは出ない
- 画像の自動送信（MacroDroid）は Phase 2。現状は共有メニューまたはアプリ内アップロード
- フレアスキルの数値は詳細リザルト画面に表示されないため未対応（Phase 0 で確認済み）
- Gemini 無料枠では送信画像が Google の製品改善に使われ得る（利用可否は大西確認済み）
