import { Fragment, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { StatsResponse } from '../lib/api'
import { useIsDark } from '../lib/theme'

type Graphs = StatsResponse['graphs']

function tooltipStyle(dark: boolean) {
  return dark ? { background: '#171f1a', border: '1px solid #2b3a30', color: '#e8f1ea' } : undefined
}

/* ---- Monthly plays stacked by level band ---- */

const LEVEL_BANDS: { key: string; label: string; match: (lv: number) => boolean; color: string }[] = [
  { key: 'b12', label: '〜12', match: (lv) => lv <= 12, color: '#9ca3af' },
  { key: 'b13', label: '13', match: (lv) => lv === 13, color: '#38bdf8' },
  { key: 'b14', label: '14', match: (lv) => lv === 14, color: '#34d399' },
  { key: 'b15', label: '15', match: (lv) => lv === 15, color: '#a3e635' },
  { key: 'b16', label: '16', match: (lv) => lv === 16, color: '#fbbf24' },
  { key: 'b17', label: '17', match: (lv) => lv === 17, color: '#fb923c' },
  { key: 'b18', label: '18', match: (lv) => lv === 18, color: '#f87171' },
  { key: 'b19', label: '19', match: (lv) => lv === 19, color: '#c084fc' },
]

export function LevelMonthlyChart({ monthly, rows }: { monthly: StatsResponse['monthly']; rows: Graphs['level_monthly'] }) {
  const dark = useIsDark()
  const data = monthly.map((m) => {
    const rec: Record<string, number | string> = { label: `${Number(m.month.slice(5))}月` }
    for (const b of LEVEL_BANDS) rec[b.key] = 0
    for (const r of rows) {
      if (r.month !== m.month) continue
      const band = LEVEL_BANDS.find((b) => b.match(r.level))
      if (band) rec[band.key] = (rec[band.key] as number) + r.plays
    }
    return rec
  })
  const usedBands = LEVEL_BANDS.filter((b) => data.some((d) => (d[b.key] as number) > 0))
  if (usedBands.length === 0) return <p className="muted">データがまだありません。</p>
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2b3a30' : '#d7e2da'} />
        <XAxis dataKey="label" />
        <YAxis allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle(dark)} />
        <Legend />
        {usedBands.map((b) => (
          <Bar key={b.key} dataKey={b.key} name={`Lv${b.label}`} stackId="lv" fill={b.color} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ---- Judgment composition per play day (100% stacked) ---- */

const JUDGE_SERIES = [
  { key: 'marvelous', label: 'Marvelous', color: '#f2b705' },
  { key: 'perfect', label: 'Perfect', color: '#ff5d8f' },
  { key: 'great', label: 'Great', color: '#2fbf71' },
  { key: 'good', label: 'Good', color: '#3f8cff' },
  { key: 'miss', label: 'Miss', color: '#b9c0c7' },
] as const

export function JudgeTrendChart({ days }: { days: Graphs['judge_daily'] }) {
  const dark = useIsDark()
  const usable = days
    .map((d) => {
      const total = JUDGE_SERIES.reduce((a, j) => a + d[j.key], 0)
      return { d, total }
    })
    .filter((x) => x.total > 0)
    .slice(-24)
  if (usable.length === 0) return <p className="muted">判定データのあるプレイがまだありません。</p>
  const data = usable.map(({ d, total }) => {
    const rec: Record<string, number | string> = {
      label: `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8, 10))}`,
    }
    for (const j of JUDGE_SERIES) rec[j.key] = Math.round((d[j.key] / total) * 1000) / 10
    return rec
  })
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2b3a30' : '#d7e2da'} />
        <XAxis dataKey="label" interval="preserveStartEnd" />
        <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} width={44} />
        <Tooltip
          contentStyle={tooltipStyle(dark)}
          formatter={(v) => (v == null ? '—' : `${v}%`)}
        />
        <Legend />
        {JUDGE_SERIES.map((j) => (
          <Bar key={j.key} dataKey={j.key} name={j.label} stackId="judge" fill={j.color} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ---- Coverage map: level x difficulty, cleared share ---- */

const COVERAGE_DIFFS: { key: string; short: string; color: string }[] = [
  { key: 'BEGINNER', short: 'b', color: '#2f9df4' },
  { key: 'BASIC', short: 'B', color: '#f2b705' },
  { key: 'DIFFICULT', short: 'D', color: '#e5484d' },
  { key: 'EXPERT', short: 'E', color: '#43b02a' },
  { key: 'CHALLENGE', short: 'C', color: '#8e44ad' },
]

export function CoverageMap({ cells }: { cells: Graphs['coverage'] }) {
  const [style, setStyle] = useState('SP')
  const mine = cells.filter((c) => c.play_style === style)
  const levels = [...new Set(mine.map((c) => c.level))].sort((a, b) => b - a)
  if (levels.length === 0) return <p className="muted">データがまだありません。</p>
  const cellOf = (level: number, diff: string) => mine.find((c) => c.level === level && c.difficulty === diff)
  return (
    <div>
      <div className="level-quick" role="group" aria-label="スタイル">
        {['SP', 'DP'].map((s) => (
          <button
            key={s}
            type="button"
            className={style === s ? 'level-quick-btn active' : 'level-quick-btn'}
            onClick={() => setStyle(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="coverage-grid">
        <div className="cov-head" />
        {COVERAGE_DIFFS.map((d) => (
          <div key={d.key} className="cov-head" style={{ color: d.color }}>{d.short}</div>
        ))}
        {levels.map((lv) => (
          <Fragment key={lv}>
            <div className="cov-lv">Lv{lv}</div>
            {COVERAGE_DIFFS.map((d) => {
              const cell = cellOf(lv, d.key)
              if (!cell || cell.total === 0) {
                return <div key={`${lv}-${d.key}`} className="cov-cell empty">—</div>
              }
              const ratio = cell.cleared / cell.total
              return (
                <div
                  key={`${lv}-${d.key}`}
                  className="cov-cell"
                  style={{
                    background: `rgba(81, 221, 149, ${(0.1 + 0.8 * ratio).toFixed(2)})`,
                    color: ratio >= 0.55 ? '#052e1b' : undefined,
                  }}
                  title={`${style} Lv${lv} ${d.key}: クリア ${cell.cleared} / 全 ${cell.total}譜面（プレイ済み ${cell.played}）`}
                >
                  <span className="cov-pct">{Math.round(ratio * 100)}%</span>
                  <span className="cov-num">{cell.cleared}/{cell.total}</span>
                </div>
              )
            })}
          </Fragment>
        ))}
      </div>
      <p className="muted">セルの数字は「クリア済み譜面数 / 全譜面数」、色の濃さはクリア率です。</p>
    </div>
  )
}
