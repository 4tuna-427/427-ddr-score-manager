import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueue } from '../lib/queue'
import { ResultCard } from '../components/ResultCard'
import { DiffBadge } from '../components/DiffBadge'
import { getApiToken, getLatestDaySummary, type LatestDaySummary } from '../lib/api'
import { useDataVersion } from '../lib/dataCache'

type FcKind = 'MFC' | 'PFC' | 'GFC' | 'FC'

function fcLabel(clearLamp: string | null | undefined): FcKind | null {
  if (!clearLamp) return null
  const v = clearLamp.trim().toUpperCase()
  if (v === 'MFC' || v === 'MARVELOUS FULL COMBO') return 'MFC'
  if (v === 'PFC' || v === 'PERFECT FULL COMBO') return 'PFC'
  if (v === 'GFC' || v === 'GREAT FULL COMBO') return 'GFC'
  if (v === 'FC' || v === 'FULL COMBO') return 'FC'
  return null
}

function flareBadgeClass(rank: string): string {
  const r = rank.trim().toUpperCase()
  if (r === 'EX') return 'flare-ex'
  if (r === 'IX') return 'flare-ix'
  if (r === 'VII' || r === 'VIII') return 'flare-high'
  if (r === 'IV' || r === 'V' || r === 'VI') return 'flare-mid'
  return 'flare-low'
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  return /\.(png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i.test(file.name)
}

export function HomePage() {
  const { lastResults, lastSkips, enqueue, clearResults } = useQueue()
  const dataVersion = useDataVersion()
  const [params] = useSearchParams()
  const shared = params.get('shared') === '1'
  const [summary, setSummary] = useState<LatestDaySummary | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepthRef = useRef(0)

  useEffect(() => {
    if (!getApiToken()) {
      setSummary(null)
      return
    }
    getLatestDaySummary().then(setSummary).catch(() => setSummary(null))
  }, [dataVersion])

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current += 1
      setDragging(true)
    }

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragging(false)
    }

    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? []).filter(isImageFile)
      for (const f of files) {
        await enqueue(f, f.name, 'upload')
      }
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [enqueue])

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
              {summary.updates.map((u) => {
                const fc = fcLabel(u.clear_lamp)
                const flare = u.flare_rank && u.clear_lamp !== 'FAILED' ? u.flare_rank : null
                return (
                  <li key={u.id}>
                    <Link to={`/charts/${encodeURIComponent(u.chart_id || '')}`} className="update-row">
                      <div className="update-row-top">
                        <span className="update-title">{u.song_title || u.raw_title || '(曲名不明)'}</span>
                        <DiffBadge style={u.play_style} difficulty={u.difficulty} level={u.level} />
                      </div>
                      <div className="update-row-bottom">
                        <div className="update-meta">
                          <span className="update-slot-flare">
                            {flare && <span className={`badge flare-badge ${flareBadgeClass(flare)}`}>{flare}</span>}
                          </span>
                          <span className="update-slot-fc">
                            {fc && <span className={`badge fc-badge fc-${fc.toLowerCase()}`}>{fc}</span>}
                          </span>
                        </div>
                        <div className="update-score">
                          <span className="update-score-val">{u.score.toLocaleString()}</span>
                          <span className="update-score-diff">
                            {u.is_new ? (
                              <span className="badge new">新規</span>
                            ) : (
                              <span className="diff up">+{u.diff?.toLocaleString()}</span>
                            )}
                          </span>
                        </div>
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="muted">この日の自己ベスト更新はありませんでした。</p>
          )}
        </div>
      )}

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-box">
            <strong>ここにリザルト画像をドロップしてアップロード</strong>
            <span className="muted">複数の画像ファイルをまとめて追加できます</span>
          </div>
        </div>
      )}
    </div>
  )
}
