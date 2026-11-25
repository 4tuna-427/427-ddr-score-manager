import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { deleteTarget, getChartHistory, getTarget, saveTarget, type ChartHistory, type Target } from '../lib/api'
import { useIsDark } from '../lib/theme'
import { ScoreList, fmtDate } from '../components/ScoreList'
import { DiffBadge } from '../components/DiffBadge'

const LAMP_ORDER: Record<string, number> = { FAILED: 0, CLEAR: 1, LIFE4: 2, FC: 3, GFC: 4, PFC: 5, MFC: 6 }
const TARGET_LAMPS = ['', 'CLEAR', 'LIFE4', 'FC', 'GFC', 'PFC', 'MFC']

export function ChartPage() {
  const dark = useIsDark()
  const { chartId } = useParams<{ chartId: string }>()
  const [data, setData] = useState<ChartHistory | null>(null)
  const [error, setError] = useState('')
  const [target, setTarget] = useState<Target | null>(null)
  const [targetScore, setTargetScore] = useState('')
  const [targetLamp, setTargetLamp] = useState('')
  const [targetMsg, setTargetMsg] = useState('')

  useEffect(() => {
    if (!chartId) return
    getChartHistory(decodeURIComponent(chartId))
      .then(setData)
      .catch((e) => setError(e.message))
    getTarget(decodeURIComponent(chartId))
      .then((r) => {
        setTarget(r.target)
        setTargetScore(r.target?.target_score != null ? String(r.target.target_score) : '')
        setTargetLamp(r.target?.target_lamp ?? '')
      })
      .catch(() => undefined)
  }, [chartId])

  if (error) return <p className="warn">{error}</p>
  if (!data) return <p className="muted">読み込み中…</p>

  const chart = data.chart
  const title = chart.song_title || chart.title || '(曲名不明)'
  const items = data.items.map((s) => ({ ...s, chart_max_ex: s.chart_max_ex ?? chart.max_ex ?? null }))
  const points = data.items.map((s) => ({
    t: s.played_at,
    date: fmtDate(s.played_at),
    score: s.score,
    ex: s.ex_score,
  }))

  const bestScore = items.length > 0 ? Math.max(...items.map((s) => s.score)) : null
  const bestLamp = items.reduce<string | null>((best, s) => {
    if (!s.clear_lamp) return best
    if (best == null || (LAMP_ORDER[s.clear_lamp] ?? -1) > (LAMP_ORDER[best] ?? -1)) return s.clear_lamp
    return best
  }, null)

  const doSaveTarget = async () => {
    if (!chartId) return
    const score = targetScore.trim() === '' ? null : parseInt(targetScore, 10)
    if (score !== null && (Number.isNaN(score) || score < 0 || score > 1000000)) {
      setTargetMsg('目標スコアは 0〜1,000,000 の整数で入力してください')
      return
    }
    try {
      const r = await saveTarget(decodeURIComponent(chartId), score, targetLamp === '' ? null : targetLamp)
      setTarget(r.target)
      setTargetMsg('目標を保存しました')
    } catch (e) {
      setTargetMsg(`保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const doDeleteTarget = async () => {
    if (!chartId) return
    try {
      await deleteTarget(decodeURIComponent(chartId))
      setTarget(null)
      setTargetScore('')
      setTargetLamp('')
      setTargetMsg('目標を削除しました')
    } catch (e) {
      setTargetMsg(`削除に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div>
      <h1>{title}</h1>
      <p className="muted">
        {chart.category && <span className={`badge cat-${chart.category.toLowerCase()}`}>{chart.category}</span>}{' '}
        {chart.artist || ''} / <DiffBadge style={chart.play_style} difficulty={chart.difficulty} level={chart.level} />{chart.version ? ` ・ ${chart.version}` : ''}
      </p>
      <div className="card">
        <h2>目標</h2>
        {target && (
          <div>
            {target.target_score != null && (
              <p>
                目標スコア {target.target_score.toLocaleString()}：
                {bestScore == null ? (
                  <span className="muted"> まだプレイ記録がありません</span>
                ) : bestScore >= target.target_score ? (
                  <span className="diff up"> 達成済み（ベスト {bestScore.toLocaleString()}）</span>
                ) : (
                  <span> あと {(target.target_score - bestScore).toLocaleString()}点（ベスト {bestScore.toLocaleString()}）</span>
                )}
              </p>
            )}
            {target.target_lamp && (
              <p>
                目標ランプ {target.target_lamp}：
                {bestLamp == null ? (
                  <span className="muted"> まだプレイ記録がありません</span>
                ) : (LAMP_ORDER[bestLamp] ?? -1) >= (LAMP_ORDER[target.target_lamp] ?? 99) ? (
                  <span className="diff up"> 達成済み（ベスト {bestLamp}）</span>
                ) : (
                  <span> あと {(LAMP_ORDER[target.target_lamp] ?? 0) - (LAMP_ORDER[bestLamp] ?? 0)}段階（ベスト {bestLamp}）</span>
                )}
              </p>
            )}
          </div>
        )}
        <div className="form">
          <label>
            目標スコア
            <input
              type="number"
              min={0}
              max={1000000}
              inputMode="numeric"
              value={targetScore}
              onChange={(e) => setTargetScore(e.target.value)}
              placeholder="例：990000"
            />
          </label>
          <label>
            目標ランプ
            <select value={targetLamp} onChange={(e) => setTargetLamp(e.target.value)}>
              {TARGET_LAMPS.map((l) => (
                <option key={l} value={l}>{l === '' ? '（指定なし）' : l}</option>
              ))}
            </select>
          </label>
          <div className="row wrap">
            <button type="button" className="primary" onClick={doSaveTarget}>目標を保存</button>
            {target && <button type="button" onClick={doDeleteTarget}>目標を削除</button>}
          </div>
          {targetMsg && <p className="muted">{targetMsg}</p>}
        </div>
      </div>
      <div className="card">
        <h2>スコア遷移</h2>
        {points.length === 0 ? (
          <p className="muted">記録がありません。</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2b3a30' : '#d7e2da'} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis domain={['dataMin - 5000', 1000000]} tick={{ fontSize: 11 }} width={64} />
              <Tooltip contentStyle={dark ? { background: '#171f1a', border: '1px solid #2b3a30', color: '#e8f1ea' } : undefined} />
              <Line type="monotone" dataKey="score" name="スコア" stroke={dark ? '#6ddc99' : '#0b7a43'} strokeWidth={2} dot />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <h2>履歴</h2>
      <ScoreList items={[...items].reverse()} />
    </div>
  )
}
