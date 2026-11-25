import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { getCloseCalls, getStats, type AchievementBucket, type CloseCall, type StatsResponse } from '../lib/api'
import { useIsDark } from '../lib/theme'
import { DiffBadge } from '../components/DiffBadge'

function LampCounts({ b }: { b: AchievementBucket }) {
  return (
    <span className="lamp-counts">
      クリア {b.clear} · FC {b.fc} · GFC {b.gfc} · PFC {b.pfc} · MFC {b.mfc}
    </span>
  )
}

function Progress({ played, total }: { played: number; total: number }) {
  const pct = total > 0 ? Math.round((played / total) * 1000) / 10 : 0
  return (
    <span className="stat-progress">
      <span className="stat-progress-bar">
        <span className="stat-progress-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="muted">
        {played} / {total}（{pct}%）
      </span>
    </span>
  )
}

export function StatsPage() {
  const dark = useIsDark()
  const [data, setData] = useState<StatsResponse | null>(null)
  const [error, setError] = useState('')
  const [style, setStyle] = useState<'SP' | 'DP'>('SP')
  const [closeCalls, setCloseCalls] = useState<CloseCall[] | null>(null)

  useEffect(() => {
    getStats()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : '読み込みに失敗しました'))
    getCloseCalls().then((r) => setCloseCalls(r.items)).catch(() => setCloseCalls([]))
  }, [])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">読み込み中…</p>

  const t = data.totals
  const levels = data.by_level.filter((r) => r.play_style === style)
  const monthly = data.monthly.map((m) => ({ ...m, label: m.month.slice(2) }))

  return (
    <div>
      <h2>統計・達成状況</h2>

      <section className="card">
        <h3>あと少しリスト</h3>
        {closeCalls === null ? (
          <p className="muted">読み込み中…</p>
        ) : closeCalls.length === 0 ? (
          <p className="muted">AAA・次ランプまで僅差の譜面はありません。</p>
        ) : (
          <ul className="update-list">
            {closeCalls.map((cc) => (
              <li key={`${cc.chart_id}-${cc.kind}`}>
                <Link to={`/charts/${encodeURIComponent(cc.chart_id)}`}>
                  <span className="update-title">{cc.song_title || '(曲名不明)'}</span>
                  <DiffBadge style={cc.play_style} difficulty={cc.difficulty} level={cc.level} />
                  <span className="update-score">
                    {cc.kind === 'aaa'
                      ? `AAAまであと ${cc.gap.toLocaleString()}点`
                      : `${cc.next_lamp}まであと ${cc.gap}判定`}
                    <span className="muted">（{cc.score.toLocaleString()}・{cc.clear_lamp || '—'}）</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="stat-tiles">
        <div className="stat-tile"><span className="stat-tile-num">{t.plays}</span><span className="stat-tile-label">総プレイ数</span></div>
        <div className="stat-tile"><span className="stat-tile-num">{t.play_days}</span><span className="stat-tile-label">プレイ日数</span></div>
        <div className="stat-tile"><span className="stat-tile-num">{t.played}</span><span className="stat-tile-label">プレイ済み譜面</span></div>
        <div className="stat-tile"><span className="stat-tile-num">{t.aaa}</span><span className="stat-tile-label">AAA譜面</span></div>
        <div className="stat-tile"><span className="stat-tile-num">{t.pfc}</span><span className="stat-tile-label">PFC譜面</span></div>
        <div className="stat-tile"><span className="stat-tile-num">{t.mfc}</span><span className="stat-tile-label">MFC譜面</span></div>
        <div className="stat-tile"><span className="stat-tile-num">{t.max_clear_level ?? '—'}</span><span className="stat-tile-label">最大クリアレベル</span></div>
        <div className="stat-tile"><span className="stat-tile-num">{t.clear}</span><span className="stat-tile-label">クリア譜面</span></div>
      </div>

      <section className="card">
        <h3>レベル別達成状況</h3>
        <div className="segmented">
          <button type="button" className={style === 'SP' ? 'active' : ''} onClick={() => setStyle('SP')}>SP</button>
          <button type="button" className={style === 'DP' ? 'active' : ''} onClick={() => setStyle('DP')}>DP</button>
        </div>
        <table className="level-table">
          <thead>
            <tr><th>Lv</th><th>プレイ済み</th><th>クリア</th><th>FC</th><th>PFC</th><th>MFC</th></tr>
          </thead>
          <tbody>
            {levels.map((r) => (
              <tr key={`${r.play_style}-${r.level}`}>
                <td className="lv-cell">{r.level}</td>
                <td><Progress played={r.played} total={r.total_charts} /></td>
                <td>{r.clear}</td>
                <td>{r.fc}</td>
                <td>{r.pfc}</td>
                <td>{r.mfc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>カテゴリ別達成状況</h3>
        {data.by_category.map((c) => (
          <div key={c.category} className="cat-row">
            <span className={`badge cat-${c.category.toLowerCase()}`}>{c.category}</span>
            <Progress played={c.played} total={c.total_charts} />
            <LampCounts b={c} />
          </div>
        ))}
      </section>

      <section className="card">
        <h3>月別推移（直近12か月）</h3>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={monthly} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2b3a30' : '#d7e2da'} />
            <XAxis dataKey="label" />
            <YAxis allowDecimals={false} />
            <Tooltip contentStyle={dark ? { background: '#171f1a', border: '1px solid #2b3a30', color: '#e8f1ea' } : undefined} />
            <Bar dataKey="plays" name="プレイ数" fill="#51dd95" />
            <Bar dataKey="pb_updates" name="自己ベスト更新" fill={dark ? '#c9f7dd' : '#0b7a43'} />
          </BarChart>
        </ResponsiveContainer>
      </section>
    </div>
  )
}
