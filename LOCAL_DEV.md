# ローカルPC開発環境セットアップ手順

本アプリをローカルPC（Windows PowerShell 等）上で起動して開発・動作確認するための手順です。

## 構成概要

- **フロントエンド (`web/`)**: Vite Dev Server (`http://127.0.0.1:3000`)。`/api/*` へのリクエストは自動的に `http://localhost:8787` へプロキシされます。
- **バックエンド (`worker/`)**: `wrangler dev` (`http://localhost:8787`)。
  - **D1 (`DB`)**: 完全ローカル（`worker/.wrangler/state/` 内の SQLite）。本番 DB には影響しません。
  - **KV (`JACKETS`)**: `worker/wrangler.toml` の `remote = true` により、ローカル開発中も本番のジャケット画像 KV を読み取り専用で参照します。
  - **GitHub Pages (`songs.json`) / Gemini API**: ローカル Worker から直接 HTTPS 通信します。

---

## 1. 初回セットアップ

### 1-1. 依存パッケージのインストール

```powershell
cd worker
npm install
cd ..\web
npm install
```

### 1-2. Cloudflare へのログイン（本番ジャケット KV 参照に必要）

```powershell
cd ..\worker
npx wrangler login
```

ブラウザが開くので、Cloudflare アカウントでログインしてください。

### 1-3. ローカル用シークレット (`worker/.dev.vars`) の作成

`worker/.dev.vars.example` をコピーして `worker/.dev.vars` を作成し、実際の値を設定します（`.dev.vars` は `.gitignore` に登録済みです）。

```powershell
Copy-Item .dev.vars.example .dev.vars
```

`worker/.dev.vars` を開き、以下を編集してください。

```dotenv
API_TOKEN=local-dev-token
GEMINI_API_KEY=<Google AI Studio で発行した実際の API キー>
MY_DANCER_NAME=4TUNA
```

### 1-4. ローカル D1 データベースの初期化

マイグレーション（`migrations/`）の適用と、初期楽曲・譜面データ（`scripts/seed_master.sql`）の投入を一括で行います。

```powershell
cd worker
npm run db:init:local
```

最後に `song_count` が `1485` と表示されれば完了です。

---

## 2. 日常の開発サーバー起動

**2つのターミナル**を開いて、それぞれ Worker と Web を起動します。

**ターミナル 1（API / Worker）:**

```powershell
cd worker
npm run dev
```

`http://localhost:8787` で待ち受けます（初回起動時はリモート KV 接続の確認が走る場合があります）。

**ターミナル 2（フロントエンド / Vite）:**

```powershell
cd web
npm run dev
```

`http://127.0.0.1:3000` で待ち受けます。ブラウザで `http://127.0.0.1:3000` を開いてください。

---

## 3. ブラウザ側の初期設定

1. `http://127.0.0.1:3000` を開き、画面内の **「設定」** タブに移動します。
2. 以下を入力して保存します。
   - **API ベース URL**: **空欄** のまま（Vite のプロキシ経由で `/api` が `http://localhost:8787` に転送されます。直接指定する場合は `http://localhost:8787`）
   - **API トークン**: `worker/.dev.vars` に設定した `API_TOKEN` の値（例: `local-dev-token`）

---

## 4. マスタデータ同期・ジャケット表示フラグの反映

`seed_master.sql` 投入直後の状態では、`songs.has_jacket` が初期値のままのためジャケット画像が表示されない場合があります。ローカルの Worker を起動した状態で以下を実行すると、GitHub Pages 上の最新 `songs.json` と同期し、`has_jacket` フラグもローカル D1 に反映されます。

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:8787/api/admin/sync" -Headers @{ "X-API-Token" = "local-dev-token" } -ContentType "application/json" -Body "{}"
```

※ `X-API-Token` には `worker/.dev.vars` に設定した `API_TOKEN` を指定してください。

---

## 5. ローカル DB をリセットしたい場合

テストデータなどを消して初期状態に戻したい場合は、`worker/.wrangler/state` を削除してから初期化スクリプトを再実行します（`worker` を停止した状態で実行してください）。

```powershell
Remove-Item -Recurse -Force worker\.wrangler\state
cd worker
npm run db:init:local
```
