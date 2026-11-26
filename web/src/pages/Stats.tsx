import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { getCloseCalls, getStats, getTargets, getVersus, type AchievementBucket, type CloseCall, type StatsResponse, type Target, type VersusResponse } from '../lib/api'
import { useIsDark } from '../lib/theme'
import { DiffBadge } from '../components/DiffBadge'
import { CoverageMap, JudgeTrendChart, LevelMonthlyChart } from '../components/StatGraphs'
import { fmtDate } from '../components/ScoreList'

const LAMP_ORDER: Record<string, number> = { FAILED: 0, CLEAR: 1, LIFE4: 2, FC: 3, GFC: 4, PFC: 5, MFC: 6 }

/** JST calendar date "YYYY-MM-DD" for an epoch-ms timestamp. */
function jstDateString(ms: number): string {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

/** Day-of-week (0=Sunday) of a JST date string. */
function jstDayOfWeek(date: string): number {
  return new Date(Date.parse(`${date}T00:00:00+09:00`) + 9 * 3600 * 1000).getUTCDay()
}

function CalendarHeatmap({ calendar }: { calendar: { date: string; plays: number }[] }) {
  const byDate = new Map(calendar.map((d) => [d.date, d.plays]))
  const endMs = Date.parse(`${jstDateString(Date.now())}T00:00:00+09:00`)
  const days: { date: string; plays: number }[] = []
  for (let i = 364; i >= 0; i--) {
    const date = jstDateString(endMs - i * 86400000)
    days.push({ date, plays: byDate.get(date) ?? 0 })
  }
  // Pad so the first column starts on Sunday (JST).
  const pad = jstDayOfWeek(days[0].date)
  const cells: ({ date: string; plays: number } | null)[] = [...Array(pad).fill(null), ...days]
  const level = (plays: number) => (plays === 0 ? 0 : plays <= 2 ? 1 : plays <= 5 ? 2 : 3)
  return (
    <div>
      <div className="cal-grid">
        {cells.map((c, i) =>
          c === null ? (
            <span key={`pad-${i}`} className="cal-cell cal-pad" />
          ) : (
            <span
              key={c.date}
              className={`cal-cell cal-${level(c.plays)}`}
              title={`${c.date}：${c.plays}プレイ`}
            />
          ),
        )}
      </div>
      <p className="muted">直近1年（JST）。色が濃いほどプレイ数が多い日です。</p>
    </div>
  )
}

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
  const [targets, setTargets] = useState<Target[] | null>(null)
  const [versus, setVersus] = useState<VersusResponse | null>(null)

  useEffect(() => {
    getStats()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : '読み込みに失敗しました'))
    getCloseCalls().then((r) => setCloseCalls(r.items)).catch(() => setCloseCalls([]))
    getTargets().then((r) => setTargets(r.items)).catch(() => setTargets([]))
    getVersus().then(setVersus).catch(() => setVersus({ opponents: [], recent: [] }))
  }, [])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">読み込み中…</p>

  const t = data.totals
  const levels = data.by_level.filter((r) => r.play_style === style)
  const monthly = data.monthly.map((m) => ({ ...m, label: m.month.slice(2) }))
  const exByLevel = new Map(data.ex_rate_by_level.map((r) => [`${r.play_style}|${r.level}`, r]))

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
          <ul className="update-list cap-list">
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

      <section className="card">
        <h3>設定中の目標</h3>
        {targets === null ? (
          <p className="muted">読み込み中…</p>
        ) : targets.length === 0 ? (
          <p className="muted">設定中の目標はありません。譜面ページから目標を設定できます。</p>
        ) : (
          <ul className="update-list cap-list">
            {targets.map((tg) => {
              const scoreOk = tg.target_score != null && tg.best_score != null && tg.best_score >= tg.target_score
              const lampOk =
                tg.target_lamp != null &&
                tg.best_lamp != null &&
                (LAMP_ORDER[tg.best_lamp] ?? -1) >= (LAMP_ORDER[tg.target_lamp] ?? 99)
              return (
                <li key={tg.chart_id}>
                  <Link to={`/charts/${encodeURIComponent(tg.chart_id)}`}>
                    <span className="update-title">{tg.song_title || '(曲名不明)'}</span>
                    <DiffBadge style={tg.play_style} difficulty={tg.difficulty} level={tg.level} />
                    <span className="update-score">
                      {tg.target_score != null && (
                        <span>
                          {tg.target_score.toLocaleString()}：
                          {tg.best_score == null ? (
                            <span className="muted">未プレイ</span>
                          ) : scoreOk ? (
                            <span className="diff up">達成</span>
                          ) : (
                            <span>あと{(tg.target_score - tg.best_score).toLocaleString()}点</span>
                          )}
                        </span>
                      )}
                      {tg.target_score != null && tg.target_lamp != null && ' / '}
                      {tg.target_lamp != null && (
                        <span>
                          {tg.target_lamp}：
                          {tg.best_lamp == null ? (
                            <span className="muted">未プレイ</span>
                          ) : lampOk ? (
                            <span className="diff up">達成</span>
                          ) : (
                            <span>あと{(LAMP_ORDER[tg.target_lamp] ?? 0) - (LAMP_ORDER[tg.best_lamp] ?? 0)}段階</span>
                          )}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              )
            })}
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
            <tr><th>Lv</th><th>プレイ済み</th><th>クリア</th><th>FC</th><th>PFC</th><th>MFC</th><th>EXスコア率</th></tr>
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
                <td>{exByLevel.get(`${r.play_style}|${r.level}`)?.avg_ex_rate != null ? `${exByLevel.get(`${r.play_style}|${r.level}`)!.avg_ex_rate}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">EXスコア率は譜面ごとのベストEXスコア率の平均（ノーツ数がある譜面のみ）。</p>
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
        <h3>月別平均EXスコア率</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={monthly} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2b3a30' : '#d7e2da'} />
            <XAxis dataKey="label" />
            <YAxis domain={['auto', 100]} tickFormatter={(v: number) => `${v}%`} width={48} />
            <Tooltip
              contentStyle={dark ? { background: '#171f1a', border: '1px solid #2b3a30', color: '#e8f1ea' } : undefined}
              formatter={(v) => (v == null ? '—' : `${v}%`)}
            />
            <Line type="monotone" dataKey="avg_ex_rate" name="平均EXスコア率" stroke={dark ? '#6ddc99' : '#0b7a43'} strokeWidth={2} dot connectNulls />
          </LineChart>
        </ResponsiveContainer>
        <p className="muted">ノーツ数がある譜面のプレイのみ対象。月内に該当プレイが無い月は線が途切れます。</p>
      </section>

      <section className="card">
        <h3>プレイカレンダー</h3>
        <CalendarHeatmap calendar={data.calendar} />
      </section>

      <section className="card">
        <h3>グラフで見る</h3>
        <h4>月別・レベル帯のプレイ数</h4>
        <LevelMonthlyChart monthly={data.monthly} rows={data.graphs.level_monthly} />
        <h4>判定の割合の推移（プレイ日ごと・直近24日分）</h4>
        <JudgeTrendChart days={data.graphs.judge_daily} />
        <p className="muted">判定割合は OK（フリーズ）を除く5判定での割合です。</p>
        <h4>制覇マップ（レベル × 難易度）</h4>
        <CoverageMap cells={data.graphs.coverage} />
      </section>

      <section className="card">
        <h3>フレア目標</h3>
        {data.flare.targets.map((t) => (
          <div key={`${t.level}-${t.min_rank}`} className="flare-target">
            <h4>
              Lv{t.level} フレア{t.min_rank}クリア：
              <span className="flare-target-count">達成 {t.achieved_count}譜面</span>
              <span className="muted">（あと少し {t.candidate_count}譜面）</span>{' '}
              <Link to={`/browse?level=${t.level}`}>Lv{t.level}の譜面一覧</Link>
            </h4>
            {t.achieved.length > 0 && (
              <ul className="update-list cap-list">
                {t.achieved.map((a) => (
                  <li key={a.chart_id}>
                    <Link to={`/charts/${encodeURIComponent(a.chart_id)}`}>
                      <span className="update-title">{a.title || '(曲名不明)'}</span>
                      <DiffBadge style={a.play_style} difficulty={a.chart_id.split('|')[2] || ''} level={t.level} />
                      <span className="update-score">フレア {a.flare_rank}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {t.candidates.length > 0 && (
              <>
                <p className="muted">あと少し（クリア済み・目標ランク未満、近い順）：</p>
                <ul className="update-list cap-list">
                  {t.candidates.map((cand) => (
                    <li key={cand.chart_id}>
                      <Link to={`/charts/${encodeURIComponent(cand.chart_id)}`}>
                        <span className="update-title">{cand.title || '(曲名不明)'}</span>
                        <DiffBadge style={cand.play_style} difficulty={cand.chart_id.split('|')[2] || ''} level={t.level} />
                        <span className="update-score">
                          現在 {cand.best_flare_rank ? `フレア ${cand.best_flare_rank}` : '通常ゲージ'}クリア
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {t.achieved_count === 0 && t.candidate_count === 0 && (
              <p className="muted">このレベルのクリア記録がまだありません。</p>
            )}
          </div>
        ))}
        {data.flare.charts_with_flare > 0 && (
          <>
            <h4>フレアランク別 達成譜面数（クリアした最高ランク）</h4>
            <table className="level-table">
              <thead>
                <tr><th>フレアランク</th><th>譜面数</th></tr>
              </thead>
              <tbody>
                {data.flare.by_rank.map((r) => (
                  <tr key={r.flare_rank}>
                    <td className="lv-cell">{r.flare_rank}</td>
                    <td>{r.charts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <p className="muted">
          目標は現在の目標（16EX / 17EX / 17IX / 18IX）。EXクリアはIXの目標も達成扱いです。「あと少し」はそのレベルをクリア済みで目標ランクに届いていない譜面です。
        </p>
      </section>

      <section className="card">
        <h3>対戦履歴</h3>
        {versus === null ? (
          <p className="muted">読み込み中…</p>
        ) : versus.opponents.length === 0 ? (
          <p className="muted">対戦記録がありません。</p>
        ) : (
          <>
            <table className="level-table">
              <thead>
                <tr><th>相手</th><th>対戦数</th><th>勝</th><th>敗</th><th>分</th><th>直近</th></tr>
              </thead>
              <tbody>
                {versus.opponents.map((o) => (
                  <tr key={o.name}>
                    <td>{o.name}</td>
                    <td>{o.plays}</td>
                    <td>{o.wins}</td>
                    <td>{o.losses}</td>
                    <td>{o.draws}</td>
                    <td>{fmtDate(o.last_played_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="update-list cap-list">
              {versus.recent.map((r) => (
                <li key={r.score_id}>
                  <Link to={`/scores/${r.score_id}`}>
                    <span className="update-title">{r.song_title || '(曲名不明)'}</span>
                    <span className="muted"> vs {r.opponent}</span>
                    <span className="update-score">
                      {r.my_score != null ? r.my_score.toLocaleString() : '—'} - {r.opp_score != null ? r.opp_score.toLocaleString() : '—'}
                      <span className={r.result === 'win' ? 'diff up' : r.result === 'loss' ? 'diff down' : 'muted'}>
                        {r.result === 'win' ? '勝ち' : r.result === 'loss' ? '負け' : r.result === 'draw' ? '引き分け' : '不明'}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}
