import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useQueue } from '../lib/queue'

export function UploadDock() {
  const { items, processing, bulkMode, setBulkMode, remove, processNow, enqueue } = useQueue()
  const { pathname } = useLocation()
  const isHome = pathname === '/' || pathname === '/upload'
  const fileRef = useRef<HTMLInputElement>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

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

  if (!isHome && items.length === 0 && !sheetOpen) {
    return null
  }

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
    <>
      {(isHome || items.length > 0) && (
        <div className={isHome ? 'upload-dock' : 'upload-dock is-compact'}>
          {isHome && (
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => onFiles(e.target.files)}
              className="sr-only"
            />
          )}
          <div className="upload-dock-inner">
            {isHome && (
              <button
                type="button"
                className="primary upload-dock-btn"
                onClick={() => fileRef.current?.click()}
              >
                写真を選択
              </button>
            )}
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
      )}

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
    </>
  )
}
