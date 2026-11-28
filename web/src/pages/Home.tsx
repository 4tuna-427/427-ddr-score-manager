import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueue } from '../lib/queue'
import { ResultCard } from '../components/ResultCard'
import { diffLabel } from '../components/DiffBadge'
import { getApiToken, getLatestDaySummary, type LatestDaySummary } from '../lib/api'
import { useDataVersion } from '../lib/dataCache'

export function HomePage() {
  const { items, processing, lastResults, lastSkips, bulkMode, setBulkMode, enqueue, remove, processNow, clearResults } = useQueue()
  const dataVersion = useDataVersion()
  const [params] = useSearchParams()
  const shared = params.get('shared') === '1'
  const fileRef = useRef<HTMLInputElement>(null)
  const [summary, setSummary] = useState<LatestDaySummary | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  useEffect(() => {
    if (!getApiToken()) {
      setSummary(null)
      return
    }
    getLatestDaySummary().then(setSummary).catch(() => setSummary(null))
  }, [dataVersion])

  useEffect(() => {
    if (!sheetOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheetOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sheetOpen])

  const onFiles = async (files: FileList | null) => {
    if (!files) return
    for (const f of Array.from(files)) {
      await enqueue(f, f.name, 'upload')
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  const pendingCount = items.filter((i) => i.status === 'pending' || i.status === 'sending').length
  const errorCount = items.filter((i) => i.status === 'error').length
  const quotaCount = items.filter((i) => i.status === 'quota').length
  const duplicateCount = items.filter((i) => i.status === 'duplicate').length
  const remainingCount = pendingCount + errorCount + quotaCount
  const bulkDays = Math.max(1, Math.ceil(remainingCount / 1000))
  const hasWarn = errorCount > 0 || quotaCount > 0 || duplicateCount > 0

  let dockStatusText = `キュー ${items.length}件`
  if (items.length === 0) {
    dockStatusText = 'キュー 0件'
  } else if (processing) {
    dockStatusText = `送信中 残り${remainingCount}件`
  } else if (pendingCount > 0) {
    dockStatusText = `待機 ${pendingCount}件`
  } else if (quotaCount > 0) {
    dockStatusText = `枠切れ停止 ${quotaCount}件`
  } else if (errorCount > 0) {
    dockStatusText = `再試行待ち ${errorCount}件`
  } else if (duplicateCount > 0) {
    dockStatusText = `重複 ${duplicateCount}件`
  }

  const dockStatusClass = [
    'upload-dock-status',
    hasWarn ? 'has-warn' : (processing || pendingCount > 0) ? 'is-active' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className="home-page">
      <h1>DDR Score Manager</h1>
      {shared && <p className="notice">共有された画像を受け付けました。送信キューに入っています。</p>}
      {!getApiToken() && (
        <p className="warn">APIトークンが未設定です。先に「設定」画面でトークンを保存してください。</p>
      )}

      {lastSkips.length > 0 && (
        <div className="card">
          <p>詳細リザルトではない画像 {lastSkips.length} 件をスキップしました（登録していません）。</p>
          <p className="muted">{lastSkips.join('、')}</p>
          <button type="button" onClick={clearResults}>閉じる</button>
        </div>
      )}

      {lastResults.length > 0 && (
        <div>
          <h2>登録結果</h2>
          <div className="cap-list-lg">
            {lastResults.map((r) => (
              <ResultCard key={r.score.id} result={r} />
            ))}
          </div>
          <button type="button" onClick={clearResults}>結果カードを閉じる</button>
        </div>
      )}

      {summary && summary.date && (
        <div className="card">
          <h2>直近のプレイ日：{summary.date}</h2>
          <p className="muted">
            {summary.total_plays}プレイ / {summary.unique_charts}譜面 / 自己ベスト更新 {summary.updates.length}件
          </p>
          {summary.updates.length > 0 ? (
            <ul className="update-list">
              {summary.updates.map((u) => (
                <li key={u.id}>
                  <Link to={`/charts/${encodeURIComponent(u.chart_id || '')}`}>
                    <span className="update-title">{u.song_title || u.raw_title || '(曲名不明)'}</span>
                    <span className="muted">
                      {' '}{diffLabel(u.play_style, u.difficulty, u.level)}
                    </span>
                    <span className="update-score">
                      {' '}{u.score.toLocaleString()}
                      {u.is_new ? (
                        <span className="badge new">新規</span>
                      ) : (
                        <span className="diff up">+{u.diff?.toLocaleString()}</span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">この日の自己ベスト更新はありませんでした。</p>
          )}
        </div>
      )}

      <div className="upload-dock">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => onFiles(e.target.files)}
          className="sr-only"
        />
        <div className="upload-dock-inner">
          <button
            type="button"
            className="primary upload-dock-btn"
            onClick={() => fileRef.current?.click()}
          >
            写真を選択
          </button>
          <button
            type="button"
            className={dockStatusClass}
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen((v) => !v)}
          >
            <span className="upload-dock-status-text">{dockStatusText}</span>
            <span className="upload-dock-meta">
              {bulkMode && <span className="upload-dock-pill">一括</span>}
              <span className="upload-dock-chevron" aria-hidden="true">{sheetOpen ? '▼' : '▲'}</span>
            </span>
          </button>
        </div>
      </div>

      {sheetOpen && (
        <>
          <div className="upload-sheet-backdrop" onClick={() => setSheetOpen(false)} />
          <section className="upload-sheet" role="dialog" aria-modal="true" aria-label="送信キューと送信設定">
            <div className="upload-sheet-head">
              <h2>送信キュー（{items.length}件）{processing && <span className="muted"> 送信中…</span>}</h2>
              <button type="button" className="upload-sheet-close" onClick={() => setSheetOpen(false)}>閉じる</button>
            </div>
            <div className="upload-sheet-body">
              {items.length === 0 && <p className="muted">キューは空です。</p>}
              {items.length > 0 && (
                <p className="muted">
                  待機中 {pendingCount}件 ／ 再試行待ち {errorCount}件 ／ 枠切れ停止 {quotaCount}件 ／ 重複 {duplicateCount}件（残り {remainingCount}件）
                </p>
              )}
              {bulkMode && remainingCount > 0 && (
                <p className="muted">一括取り込みモード：1日最大約1,000枚ペースで、あと約{bulkDays}日かかる見込みです。</p>
              )}
              {quotaCount > 0 && (
                <p className="warn">本日の無料枠を使い切ったため送信を停止しています。明日以降にアプリを開くと自動で再開します。今すぐ試したい場合は「今すぐ再送」を押してください。</p>
              )}
              <ul className="queue-list">
                {items.map((i) => (
                  <li key={i.id}>
                    <span>{i.name}</span>
                    <span className="muted">
                      {i.status === 'duplicate' ? '重複：同じ画像が登録済みです（削除してください）' : i.status === 'quota' ? '枠切れ停止中（明日以降に自動再開します）' : i.status === 'error' ? '再試行待ち（オンライン復帰または「今すぐ再送」で再送します。詳細は設定画面のエラーログ）' : i.status === 'sending' ? '送信中' : '待機中'}
                    </span>
                    <button type="button" onClick={() => remove(i.id)}>削除</button>
                  </li>
                ))}
              </ul>
              {items.length > 0 && (
                <button type="button" className="primary" onClick={() => processNow({ manual: true })}>今すぐ再送</button>
              )}

              <div className="upload-sheet-settings">
                <h3>送信設定</h3>
                <label>
                  <input
                    type="checkbox"
                    checked={bulkMode}
                    onChange={(e) => setBulkMode(e.target.checked)}
                  />
                  一括取り込みモード（過去画像の大量登録用）
                </label>
                <p className="muted">送信前に自動で長辺1000px・WebPに変換されます。オフライン時はキューに残り、オンライン復帰で自動送信します。</p>
                <p className="muted">ONにすると送信間隔を空けてゆっくり送り、無料枠（1日最大約1,000枚）を使い切ったらその日の送信を自動で止めます。通常のプレイ後の登録ではOFFのままで構いません。</p>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
