import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  getScore, linkChart, patchScore, searchSongs, selectPlayer,
  type Score, type SongSearchItem,
} from '../lib/api'
import { fmtDate } from '../components/ScoreList'

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
  const [score, setScore] = useState<Score | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [query, setQuery] = useState('')
  const [songs, setSongs] = useState<SongSearchItem[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!id) return
    getScore(id)
      .then((r) => setScore(r.score))
      .catch((e) => setError(e.message))
  }, [id])

  useEffect(load, [load])

  if (error) return <p className="warn">{error}</p>
  if (!score) return <p className="muted">読み込み中…</p>

  let raw: any = null
  try {
    raw = score.raw_extraction ? JSON.parse(score.raw_extraction) : null
  } catch { /* ignore */ }
  const hasPlayer2 = !!(raw && raw.player_2)

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
      setEditing(null)
    } catch (e: any) {
      setError(e.message)
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
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const onSearch = async () => {
    try {
      const r = await searchSongs(query)
      setSongs(r.items)
    } catch (e: any) {
      setError(e.message)
    }
  }

  const onLink = async (chartId: string) => {
    if (!id) return
    setBusy(true)
    try {
      const r = await linkChart(id, chartId)
      setScore(r.score)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const renderField = (key: string, label: string, value: unknown, numeric: boolean) => (
    <div className="field-row" key={key}>
      <span className="field-label">{label}</span>
      {editing === key ? (
        <span className="field-edit">
          <input
            value={editValue}
            inputMode={numeric ? 'numeric' : 'text'}
            onChange={(e) => setEditValue(e.target.value)}
            autoFocus
          />
          <button type="button" disabled={busy} onClick={() => saveEdit(key, numeric)}>保存</button>
          <button type="button" onClick={() => setEditing(null)}>取消</button>
        </span>
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
        {score.artist || ''} / {score.play_style} {score.difficulty} Lv.{score.level ?? '?'} / {fmtDate(score.played_at)}
      </p>
      {score.needs_review === 1 && <p className="warn">⚠ 要確認（EX検算: {score.ex_check || '-'}、判定合計: {score.judge_sum_check || '-'}）</p>}

      <div className="card">
        {NUM_FIELDS.map((f) => renderField(f.key, f.label, score[f.key], true))}
        {TEXT_FIELDS.map((f) => renderField(f.key, f.label, score[f.key], false))}
      </div>
      <p className="muted">数値をタップすると編集できます。保存すると検算が再実行されます。</p>

      {hasPlayer2 && (
        <div className="card">
          <h2>バーサス：プレイヤー切替</h2>
          <p className="muted">
            1P: {raw.player_1?.dancer_name || '?'} / 2P: {raw.player_2?.dancer_name || '?'}
            （自分のデータとして取り込む側を選んでください）
          </p>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => onSelectPlayer(1)}>1Pを採用</button>
            <button type="button" disabled={busy} onClick={() => onSelectPlayer(2)}>2Pを採用</button>
          </div>
        </div>
      )}

      {!score.chart_id && (
        <div className="card">
          <h2>曲を紐付ける</h2>
          <div className="row">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="曲名で検索" />
            <button type="button" onClick={onSearch}>検索</button>
          </div>
          <ul className="link-list">
            {songs.map((song) => (
              <li key={song.song_id}>
                <div>
                  <strong>{song.title}</strong> <span className="muted">{song.artist || ''}</span>
                </div>
                <div className="row wrap">
                  {song.charts.map((c) => (
                    <button key={c.chart_id} type="button" disabled={busy} onClick={() => onLink(c.chart_id)}>
                      {c.play_style} {c.difficulty} Lv.{c.level ?? '?'}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {score.chart_id && (
        <p>
          <Link to={`/charts/${encodeURIComponent(score.chart_id)}`}>この譜面のスコア遷移グラフを見る</Link>
        </p>
      )}
    </div>
  )
}
