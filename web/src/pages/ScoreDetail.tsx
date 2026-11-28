import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  deleteScore, getScore, linkChart, patchScore, selectPlayer,
  type Score,
} from '../lib/api'
import { getDataVersion, getPageCache, setPageCache } from '../lib/dataCache'
import { fmtDate } from '../components/ScoreList'
import { diffLabel } from '../components/DiffBadge'
import { JudgeBar } from '../components/JudgeBar'
import { ReviewImage } from '../components/ReviewImage'
import { ReviewReasonBadges } from '../components/ReviewReasonBadges'
import { SongSearchPanel } from '../components/SongSearchPanel'
import { exRatePercent } from '../lib/stats'

const NUM_FIELDS: { key: keyof Score; label: string }[] = [
  { key: 'score', label: 'スコア' },
  { key: 'ex_score', label: 'EXスコア' },
  { key: 'marvelous', label: 'Marvelous' },
  { key: 'perfect', label: 'Perfect' },
  { key: 'great', label: 'Great' },
  { key: 'good', label: 'Good' },
  { key: 'ok', label: 'O.K.' },
  { key: 'miss', label: 'Miss' },
  { key: 'max_combo', label: 'MAX COMBO' },
  { key: 'fast_count', label: 'FAST' },
  { key: 'slow_count', label: 'SLOW' },
  { key: 'level', label: 'レベル' },
]
const TEXT_FIELDS: { key: keyof Score; label: string }[] = [
  { key: 'rank', label: 'ランク' },
  { key: 'clear_lamp', label: 'クリアランプ' },
  { key: 'flare_rank', label: 'フレアランク' },
  { key: 'difficulty', label: '難易度' },
]

export function ScoreDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const cacheKey = id ? `score:${id}` : ''
  const [score, setScore] = useState<Score | null>(() => (cacheKey ? getPageCache<Score>(cacheKey)?.data ?? null : null))
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [showRelink, setShowRelink] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!id) return
    const c = getPageCache<Score>(cacheKey)
    if (c) setScore(c.data)
    if (c && c.version === getDataVersion()) return
    let alive = true
    getScore(id)
      .then((r) => {
        if (!alive) return
        setScore(r.score)
        setPageCache(cacheKey, r.score)
      })
      .catch((e) => {
        if (alive && !c) setError(e.message)
      })
    return () => { alive = false }
  }, [id, cacheKey])

  if (error) return <p className="warn">{error}</p>
  if (!score) return <p className="muted">読み込み中…</p>

  let raw: { player_1?: { dancer_name?: string | null }; player_2?: { dancer_name?: string | null } } | null = null
  try {
    raw = score.raw_extraction ? JSON.parse(score.raw_extraction) : null
  } catch { /* ignore */ }
  const hasPlayer2 = !!(raw && raw.player_2)
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

  const startEdit = (key: string, value: unknown) => {
    setEditing(key)
    setEditValue(value == null ? '' : String(value))
  }

  const saveEdit = async (key: string, numeric: boolean) => {
    if (!id) return
    setBusy(true)
    try {
      const value = editValue.trim() === '' ? null : numeric ? Number(editValue) : editValue.trim()
      const r = await patchScore(id, { [key]: value })
      setScore(r.score)
      setPageCache(cacheKey, r.score)
      setEditing(null)
    } catch (e: unknown) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const onSelectPlayer = async (player: 1 | 2) => {
    if (!id) return
    setBusy(true)
    try {
      const r = await selectPlayer(id, player)
      setScore(r.score)
      setPageCache(cacheKey, r.score)
    } catch (e: unknown) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const onLink = async (chartId: string) => {
    if (!id) return
    setBusy(true)
    try {
      const r = await linkChart(id, chartId)
      setScore(r.score)
      setPageCache(cacheKey, r.score)
      setShowRelink(false)
    } catch (e: unknown) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const renderField = (key: string, label: string, value: unknown, numeric: boolean) => (
    <div className="field-row" key={key}>
      <span className="field-label">{label}</span>
      {editing === key ? (
        <form className="field-edit" onSubmit={(e) => { e.preventDefault(); saveEdit(key, numeric) }}>
          <input
            value={editValue}
            inputMode={numeric ? 'numeric' : 'text'}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null) }}
            autoFocus
          />
          <button type="submit" disabled={busy}>保存</button>
          <button type="button" onClick={() => setEditing(null)}>取消</button>
        </form>
      ) : (
        <button type="button" className="field-value" onClick={() => startEdit(key, value)}>
          {value == null || value === '' ? '—' : typeof value === 'number' ? value.toLocaleString() : String(value)}
        </button>
      )}
    </div>
  )

  return (
    <div>
      <h1>{score.song_title || score.raw_title || '(曲名不明)'}</h1>
      <p className="muted">
        {score.artist || ''} / {diffLabel(score.play_style, score.difficulty, score.level)} / {fmtDate(score.played_at)}
      </p>
      {score.needs_review === 1 && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>⚠ 要確認</strong>
            <ReviewImage scoreId={score.id} hasImage={score.has_review_image} />
          </div>
          <ReviewReasonBadges reasons={score.review_reasons} reviewStatus={score.review_status} />
        </div>
      )}

      <div className="card">
        {NUM_FIELDS.map((f) => renderField(f.key, f.label, score[f.key], true))}
        {TEXT_FIELDS.map((f) => renderField(f.key, f.label, score[f.key], false))}
      </div>
      <p className="muted">数値をタップすると編集できます。保存すると検算が再実行されます。</p>

      <div className="card">
        <h2>判定割合</h2>
        {exRatePercent(score) != null && <p className="muted">EXスコア達成率 {exRatePercent(score)}%（EXスコア {score.ex_score?.toLocaleString()} / 最大 {score.chart_max_ex?.toLocaleString()}）</p>}
        <JudgeBar score={score} />
      </div>

      {hasPlayer2 && (
        <div className="card">
          <h2>バーサス：プレイヤー切替</h2>
          <p className="muted">
            1P: {raw?.player_1?.dancer_name || '?'} / 2P: {raw?.player_2?.dancer_name || '?'}
            （自分のデータとして取り込む側を選んでください）
          </p>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => onSelectPlayer(1)}>1Pを採用</button>
            <button type="button" disabled={busy} onClick={() => onSelectPlayer(2)}>2Pを採用</button>
          </div>
        </div>
      )}

      {(!score.chart_id || showRelink) && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>{score.chart_id ? '曲・譜面を変更する' : '曲を紐付ける'}</h2>
            {score.chart_id && (
              <button type="button" onClick={() => setShowRelink(false)}>閉じる</button>
            )}
          </div>
          {(score.song_charts ?? []).length > 0 && (
            <>
              <p className="muted">一致した曲の譜面から選択：</p>
              <div className="review-actions" style={{ marginBottom: 8 }}>
                {(score.song_charts ?? []).map((ch) => (
                  <button key={ch.chart_id} type="button" disabled={busy} onClick={() => onLink(ch.chart_id)}>
                    {diffLabel(ch.play_style, ch.difficulty, ch.level)}
                  </button>
                ))}
              </div>
            </>
          )}
          {(score.candidates ?? []).length > 0 && (
            <>
              <p className="muted">読み取り曲名に近い候補：</p>
              <div className="review-actions">
                {(score.candidates ?? []).map((cand) => (
                  <button key={cand.chart_id} type="button" disabled={busy} onClick={() => onLink(cand.chart_id)}>
                    {cand.title}（一致度 {Math.round(cand.score * 100)}%）でリンク
                  </button>
                ))}
              </div>
            </>
          )}
          <SongSearchPanel
            initialQuery={score.raw_title || score.song_title || ''}
            busy={busy}
            onSelectChart={(chartId) => void onLink(chartId)}
            onError={setError}
          />
        </div>
      )}

      {score.chart_id && (
        <div className="row wrap" style={{ justifyContent: 'space-between', margin: '10px 0' }}>
          <Link to={`/charts/${encodeURIComponent(score.chart_id)}`}>この譜面のスコア遷移グラフを見る</Link>
          {!showRelink && (
            <button
              type="button"
              onClick={() => setShowRelink(true)}
            >
              別の曲・譜面に変更
            </button>
          )}
        </div>
      )}

      <div className="card">
        <h2>記録の削除</h2>
        <p className="muted">曲として存在しない記録（誤読など）を消す場合に使います。元に戻せません。</p>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={async () => {
            if (!id) return
            if (!window.confirm('この記録を削除しますか？元に戻せません。')) return
            setBusy(true)
            try {
              await deleteScore(id)
              if (window.history.length > 1) navigate(-1)
              else navigate('/history')
            } catch (e: unknown) {
              setError(errMsg(e))
              setBusy(false)
            }
          }}
        >
          この記録を削除
        </button>
      </div>
    </div>
  )
}
