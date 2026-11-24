import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { getChartHistory, type ChartHistory } from '../lib/api'
import { ScoreList, fmtDate } from '../components/ScoreList'

export function ChartPage() {
  const { chartId } = useParams<{ chartId: string }>()
  const [data, setData] = useState<ChartHistory | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!chartId) return
    getChartHistory(decodeURIComponent(chartId))
      .then(setData)
      .catch((e) => setError(e.message))
  }, [chartId])

  if (error) return <p className="warn">{error}</p>
  if (!data) return <p className="muted">読み込み中…</p>

  const chart = data.chart
  const title = chart.song_title || chart.title || '(曲名不明)'
  const points = data.items.map((s) => ({
    t: s.played_at,
    date: fmtDate(s.played_at),
    score: s.score,
    ex: s.ex_score,
  }))

  return (
    <div>
      <h1>{title}</h1>
      <p className="muted">
        {chart.artist || ''} / {chart.play_style} {chart.difficulty} Lv.{chart.level ?? '?'}
      </p>
      <div className="card">
        <h2>スコア遷移</h2>
        {points.length === 0 ? (
          <p className="muted">記録がありません。</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis domain={['dataMin - 5000', 1000000]} tick={{ fontSize: 11 }} width={64} />
              <Tooltip />
              <Line type="monotone" dataKey="score" name="スコア" stroke="#2563eb" strokeWidth={2} dot />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <h2>履歴</h2>
      <ScoreList items={[...data.items].reverse()} />
    </div>
  )
}
