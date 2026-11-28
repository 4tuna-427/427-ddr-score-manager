import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  createCustomSong,
  deleteScore,
  linkChart,
  listScores,
  patchScore,
  relinkScores,
  resolveReview,
  correctMasterNotes,
  searchSongs,
  selectPlayer,
  type Score,
  type SongSearchItem,
} from '../lib/api'
import { DiffBadge, diffLabel } from '../components/DiffBadge'
import { fmtDate } from '../components/ScoreList'
import { ReviewImage } from '../components/ReviewImage'
import { ReviewReasonBadges } from '../components/ReviewReasonBadges'

type FilterTab = 'all' | 'song' | 'score' | 'waiting'

const DIFFS = ['BEGINNER', 'BASIC', 'DIFFICULT', 'EXPERT', 'CHALLENGE'] as const
const MASTER_REPO_URL = 'https://github.com/4tuna-427/ddr-song-data'

function hasReason(score: Score, codes: string[]): boolean {
  return (score.review_reasons ?? []).some((r) => codes.includes(r.code))
}

function isMasterRelated(score: Score): boolean {
  return (score.review_reasons ?? []).some((r) => {
    if (
      r.code === 'unlinked_song' ||
      r.code === 'difficulty_mismatch' ||
      r.code === 'level_mismatch' ||
      r.code === 'judge_sum_mismatch' ||
      r.code === 'ok_exceeds_max' ||
      r.code === 'max_combo_exceeds_notes'
    ) {
      return true
    }
    if (r.code === 'ex_invalid' && r.detail?.reason === 'exceeds_max_ex') {
      return true
    }
    return false
  })
}

function buildMasterIssueUrl(score: Score): string {
  const titleName = score.song_title || score.raw_title || '(曲名不明)'
  const issueTitle = `[マスタ修正] ${titleName} (${score.play_style} ${score.difficulty})`

  const reasonsLines = (score.review_reasons ?? []).map((r) => {
    const detail = r.detail ? ` (${JSON.stringify(r.detail)})` : ''
    return `- \`${r.code}\`${detail}`
  })

  const lines = [
    '## マスタ修正依頼',
    '',
    'スコア登録時の検算でマスタデータとの不一致が発生しました。',
    '',
    '### 楽曲・譜面情報',
    `- 曲名 (マスタ): ${score.song_title ?? '未紐付け'}`,
    `- 曲名 (読取): ${score.raw_title ?? '—'}`,
    `- song_id: \`${score.song_id ?? 'null'}\``,
    `- chart_id: \`${score.chart_id ?? 'null'}\``,
    `- スタイル / 難易度: ${score.play_style} ${score.difficulty}`,
    `- レベル (読取 vs マスタ): Lv${score.level ?? '?'} vs Lv${score.chart_level ?? '?'}`,
    '',
    '### 要確認理由',
    ...(reasonsLines.length > 0 ? reasonsLines : ['- (なし)']),
    '',
    '### 参考スコア・判定内訳',
    `- Score: ${score.score.toLocaleString()} / EX: ${score.ex_score ?? '—'} (マスタ max_ex: ${score.chart_max_ex ?? '—'})`,
    `- Marvelous: ${score.marvelous ?? '—'} / Perfect: ${score.perfect ?? '—'} / Great: ${score.great ?? '—'} / Good: ${score.good ?? '—'} / O.K.: ${score.ok ?? '—'} / Miss: ${score.miss ?? '—'}`,
    `- Max Combo: ${score.max_combo ?? '—'} (マスタ notes: ${score.chart_notes ?? '—'}, freeze: ${score.chart_freeze ?? '—'}, shock: ${score.chart_shock ?? '—'})`,
  ]

  const params = new URLSearchParams({
    title: issueTitle,
    body: lines.join('\n'),
  })
  return `${MASTER_REPO_URL}/issues/new?${params.toString()}`
}

function matchesTab(score: Score, tab: FilterTab): boolean {
  if (tab === 'all') return true
  if (tab === 'waiting') return score.review_status === 'waiting_master'
  if (tab === 'song') {
    return (
      score.review_status !== 'waiting_master' &&
      hasReason(score, ['unlinked_song', 'difficulty_mismatch', 'level_mismatch'])
    )
  }
  return (
    score.review_status !== 'waiting_master' &&
    hasReason(score, [
      'ex_mismatch',
      'ex_invalid',
      'judge_sum_mismatch',
      'ok_exceeds_max',
      'max_combo_exceeds_notes',
      'player_unresolved',
    ])
  )
}

interface ReviewCardProps {
  score: Score
  onReload: () => Promise<void>
  onError: (msg: string) => void
}

function ReviewCard({ score, onReload, onError }: ReviewCardProps) {
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<'none' | 'search' | 'custom' | 'edit'>('none')

  // Song search state
  const [query, setQuery] = useState(score.raw_title || score.song_title || '')
  const [searchResults, setSearchResults] = useState<SongSearchItem[]>([])
  const [searched, setSearched] = useState(false)

  // Custom song registration state
  const [customTitle, setCustomTitle] = useState(score.raw_title || '')
  const [customArtist, setCustomArtist] = useState('')
  const [customStyle, setCustomStyle] = useState<'SP' | 'DP'>(score.play_style === 'DP' ? 'DP' : 'SP')
  const [customDiff, setCustomDiff] = useState<string>(
    (DIFFS as readonly string[]).includes(score.difficulty) ? score.difficulty : 'EXPERT',
  )
  const [customLevel, setCustomLevel] = useState(score.level != null ? String(score.level) : '')

  // Inline manual edit state
  const [editForm, setEditForm] = useState(() => ({
    score: score.score != null ? String(score.score) : '',
    ex_score: score.ex_score != null ? String(score.ex_score) : '',
    marvelous: score.marvelous != null ? String(score.marvelous) : '',
    perfect: score.perfect != null ? String(score.perfect) : '',
    great: score.great != null ? String(score.great) : '',
    good: score.good != null ? String(score.good) : '',
    ok: score.ok != null ? String(score.ok) : '',
    miss: score.miss != null ? String(score.miss) : '',
    level: score.level != null ? String(score.level) : '',
    difficulty: score.difficulty || '',
  }))

  let rawExt: { player_1?: { dancer_name?: string | null }; player_2?: { dancer_name?: string | null } } | null = null
  try {
    rawExt = score.raw_extraction ? JSON.parse(score.raw_extraction) : null
  } catch { /* ignore */ }

  const reasons = score.review_reasons ?? []
  const exMismatch = reasons.find((r) => r.code === 'ex_mismatch')
  const calcEx = typeof exMismatch?.detail?.calc_ex === 'number' ? exMismatch.detail.calc_ex : null
  const levelMismatch = reasons.find((r) => r.code === 'level_mismatch')
  const masterLevel = typeof levelMismatch?.detail?.master_level === 'number' ? levelMismatch.detail.master_level : null
  // Surplus judge-sum mismatch: the server attaches the master notes
  // value this play proves (implied_notes) — present only when the
  // read exceeds the identity and the EX cross-check matched, i.e.
  // when correcting the master from this play is sound.
  const judgeMismatch = reasons.find((r) => r.code === 'judge_sum_mismatch')
  const impliedNotes =
    score.ex_check === 'match' && typeof judgeMismatch?.detail?.implied_notes === 'number'
      ? judgeMismatch.detail.implied_notes
      : null
  const isUnlinkedSong = reasons.some((r) => r.code === 'unlinked_song')
  const isDiffMismatch = reasons.some((r) => r.code === 'difficulty_mismatch')
  const isPlayerUnresolved = reasons.some((r) => r.code === 'player_unresolved')
  const isWaiting = score.review_status === 'waiting_master'
  const masterRelated = isMasterRelated(score)

  const openMasterIssue = () => {
    window.open(buildMasterIssueUrl(score), '_blank', 'noopener,noreferrer')
    if (!isWaiting) {
      void runAction(() => patchScore(score.id, { review_status: 'waiting_master' }))
    }
  }

  const runAction = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    onError('')
    try {
      await fn()
      await onReload()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doSearch = async () => {
    setBusy(true)
    try {
      const r = await searchSongs(query)
      setSearchResults(r.items)
      setSearched(true)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitCustomSong = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!customTitle.trim()) return
    const lvNum = customLevel.trim() === '' ? null : parseInt(customLevel, 10)
    await runAction(() =>
      createCustomSong({
        title: customTitle.trim(),
        artist: customArtist.trim() || undefined,
        play_style: customStyle,
        difficulty: customDiff,
        level: lvNum != null && Number.isFinite(lvNum) ? lvNum : null,
        score_id: score.id,
      }),
    )
  }

  const submitManualEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s))
    const payload: Record<string, unknown> = {
      score: Number(editForm.score) || 0,
      ex_score: numOrNull(editForm.ex_score),
      marvelous: numOrNull(editForm.marvelous),
      perfect: numOrNull(editForm.perfect),
      great: numOrNull(editForm.great),
      good: numOrNull(editForm.good),
      ok: numOrNull(editForm.ok),
      miss: numOrNull(editForm.miss),
      level: numOrNull(editForm.level),
      difficulty: editForm.difficulty.trim() || score.difficulty,
    }
    await runAction(async () => {
      await patchScore(score.id, payload)
      setPanel('none')
    })
  }

  const onDelete = async () => {
    const label = score.raw_title || score.song_title || '(曲名不明)'
    if (!window.confirm(`「${label}」の記録を削除しますか？元に戻せません。`)) return
    await runAction(() => deleteScore(score.id))
  }

  return (
    <article className="card review-card">
      <div className="review-card-head">
        <div className="review-card-title-block">
          <Link to={`/scores/${score.id}`} className="review-card-title">
            {score.song_title || score.raw_title || '(曲名不明)'}
          </Link>
          {score.raw_title && score.song_title && score.raw_title !== score.song_title && (
            <div className="muted">読取曲名: {score.raw_title}</div>
          )}
          <div className="review-card-meta">
            <DiffBadge style={score.play_style} difficulty={score.difficulty} level={score.level} />
            <span className="muted">{fmtDate(score.played_at)}</span>
          </div>
        </div>
        <div className="review-card-right">
          <div className="review-card-score">{score.score.toLocaleString()}</div>
          {score.ex_score != null && <div className="muted">EX {score.ex_score.toLocaleString()}</div>}
          <ReviewImage scoreId={score.id} hasImage={score.has_review_image} />
        </div>
      </div>

      <ReviewReasonBadges reasons={reasons} reviewStatus={score.review_status} />

      <div className="review-quick-bar">
        {calcEx != null && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => runAction(() => patchScore(score.id, { ex_score: calcEx }))}
          >
            計算値 ({calcEx.toLocaleString()}) でEX修正
          </button>
        )}

        {masterLevel != null && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => runAction(() => patchScore(score.id, { level: masterLevel }))}
          >
            マスタLv (Lv{masterLevel}) に合わせる
          </button>
        )}

        {isPlayerUnresolved && rawExt?.player_1 && rawExt?.player_2 && (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => runAction(() => selectPlayer(score.id, 1))}
            >
              1Pを採用 ({rawExt.player_1.dancer_name || '1P'})
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => runAction(() => selectPlayer(score.id, 2))}
            >
              2Pを採用 ({rawExt.player_2.dancer_name || '2P'})
            </button>
          </>
        )}

        {isDiffMismatch && (score.song_charts ?? []).length > 0 && (
          <div className="review-subblock">
            <span className="muted">一致した曲の譜面から選択：</span>
            <div className="review-actions">
              {(score.song_charts ?? []).map((ch) => (
                <button
                  key={ch.chart_id}
                  type="button"
                  disabled={busy}
                  onClick={() => runAction(() => linkChart(score.id, ch.chart_id))}
                >
                  {diffLabel(ch.play_style, ch.difficulty, ch.level)}
                </button>
              ))}
            </div>
          </div>
        )}

        {(score.candidates ?? []).map((cand) => (
          <button
            key={cand.chart_id}
            type="button"
            disabled={busy}
            onClick={() => runAction(() => linkChart(score.id, cand.chart_id))}
          >
            候補: {cand.title}（{Math.round(cand.score * 100)}%）
          </button>
        ))}

        <button
          type="button"
          disabled={busy}
          onClick={() => setPanel((p) => (p === 'search' ? 'none' : 'search'))}
        >
          {panel === 'search' ? '検索を閉じる' : score.chart_id ? '別の曲・譜面に変更' : '曲名で検索して紐付け'}
        </button>

        {(isUnlinkedSong || isDiffMismatch) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setPanel((p) => (p === 'custom' ? 'none' : 'custom'))}
          >
            {panel === 'custom' ? '仮登録を閉じる' : '仮の楽曲を登録'}
          </button>
        )}

        {masterRelated && (
          <>
            {impliedNotes != null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction(() => correctMasterNotes(score.id))}
              >
                マスタ notes を {impliedNotes} に修正
              </button>
            )}
            <button type="button" disabled={busy} onClick={openMasterIssue}>
              マスタ修正を報告 (GitHub)
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                runAction(() =>
                  patchScore(score.id, { review_status: isWaiting ? null : 'waiting_master' }),
                )
              }
            >
              {isWaiting ? '更新待ちを解除' : 'マスタ更新待ちにする'}
            </button>
          </>
        )}

        {score.chart_id && (
          <button
            type="button"
            disabled={busy}
            onClick={() => runAction(() => resolveReview(score.id))}
          >
            このまま確定
          </button>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => setPanel((p) => (p === 'edit' ? 'none' : 'edit'))}
        >
          {panel === 'edit' ? '修正フォームを閉じる' : '数値を手動修正'}
        </button>
      </div>

      {panel === 'search' && (
        <div className="review-panel">
          <div className="row">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="曲名を入力して検索"
              style={{ flex: 1 }}
            />
            <button type="button" disabled={busy} onClick={doSearch}>検索</button>
          </div>
          {searched && searchResults.length === 0 && (
            <p className="muted">該当する曲が見つかりません。「仮の楽曲を登録」または「マスタ更新待ち」を使えます。</p>
          )}
          <ul className="link-list">
            {searchResults.map((song) => (
              <li key={song.song_id}>
                <div>
                  <strong>{song.title}</strong> <span className="muted">{song.artist || ''}</span>
                </div>
                <div className="row wrap">
                  {song.charts.map((c) => (
                    <button
                      key={c.chart_id}
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runAction(async () => {
                          await linkChart(score.id, c.chart_id)
                          setPanel('none')
                        })
                      }
                    >
                      {diffLabel(c.play_style, c.difficulty, c.level)}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => setPanel('custom')}>
              見つからない場合は「仮の楽曲を登録」
            </button>
          </div>
        </div>
      )}

      {panel === 'custom' && (
        <form className="review-panel form" onSubmit={submitCustomSong}>
          <p className="muted">マスタ未収録の新曲などを仮登録して、この記録と紐付けます。</p>
          <label>
            曲名（必須）
            <input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} required />
          </label>
          <label>
            アーティスト（任意）
            <input value={customArtist} onChange={(e) => setCustomArtist(e.target.value)} />
          </label>
          <div className="review-edit-grid">
            <label>
              プレイスタイル
              <select value={customStyle} onChange={(e) => setCustomStyle(e.target.value as 'SP' | 'DP')}>
                <option value="SP">SP</option>
                <option value="DP">DP</option>
              </select>
            </label>
            <label>
              難易度
              <select value={customDiff} onChange={(e) => setCustomDiff(e.target.value)}>
                {DIFFS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label>
              レベル
              <input
                type="number"
                inputMode="numeric"
                value={customLevel}
                onChange={(e) => setCustomLevel(e.target.value)}
                placeholder="16"
              />
            </label>
          </div>
          <button type="submit" className="primary" disabled={busy}>登録してリンク</button>
        </form>
      )}

      {panel === 'edit' && (
        <form className="review-panel" onSubmit={submitManualEdit}>
          <div className="review-edit-grid">
            <label>
              スコア
              <input
                inputMode="numeric"
                value={editForm.score}
                onChange={(e) => setEditForm((f) => ({ ...f, score: e.target.value }))}
              />
            </label>
            <label>
              EXスコア
              <input
                inputMode="numeric"
                value={editForm.ex_score}
                onChange={(e) => setEditForm((f) => ({ ...f, ex_score: e.target.value }))}
              />
            </label>
            <label>
              レベル
              <input
                inputMode="numeric"
                value={editForm.level}
                onChange={(e) => setEditForm((f) => ({ ...f, level: e.target.value }))}
              />
            </label>
            <label>
              難易度
              <input
                value={editForm.difficulty}
                onChange={(e) => setEditForm((f) => ({ ...f, difficulty: e.target.value }))}
              />
            </label>
            <label>
              Marvelous
              <input
                inputMode="numeric"
                value={editForm.marvelous}
                onChange={(e) => setEditForm((f) => ({ ...f, marvelous: e.target.value }))}
              />
            </label>
            <label>
              Perfect
              <input
                inputMode="numeric"
                value={editForm.perfect}
                onChange={(e) => setEditForm((f) => ({ ...f, perfect: e.target.value }))}
              />
            </label>
            <label>
              Great
              <input
                inputMode="numeric"
                value={editForm.great}
                onChange={(e) => setEditForm((f) => ({ ...f, great: e.target.value }))}
              />
            </label>
            <label>
              Good
              <input
                inputMode="numeric"
                value={editForm.good}
                onChange={(e) => setEditForm((f) => ({ ...f, good: e.target.value }))}
              />
            </label>
            <label>
              O.K.
              <input
                inputMode="numeric"
                value={editForm.ok}
                onChange={(e) => setEditForm((f) => ({ ...f, ok: e.target.value }))}
              />
            </label>
            <label>
              Miss
              <input
                inputMode="numeric"
                value={editForm.miss}
                onChange={(e) => setEditForm((f) => ({ ...f, miss: e.target.value }))}
              />
            </label>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="submit" className="primary" disabled={busy}>保存して再検算</button>
            <button type="button" onClick={() => setPanel('none')}>キャンセル</button>
          </div>
        </form>
      )}

      <div className="review-card-foot">
        <Link to={`/scores/${score.id}`} className="muted">すべての項目を編集 →</Link>
        <button type="button" className="danger-link" disabled={busy} onClick={onDelete}>
          削除
        </button>
      </div>
    </article>
  )
}

export function ReviewPage() {
  const [items, setItems] = useState<Score[]>([])
  const [total, setTotal] = useState(0)
  const [tab, setTab] = useState<FilterTab>('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [relinkMsg, setRelinkMsg] = useState('')
  const [relinking, setRelinking] = useState(false)

  const load = useCallback(async (offset = 0, append = false) => {
    setLoading(true)
    try {
      const r = await listScores({ limit: 100, offset, needsReview: true })
      setItems((prev) => (append ? [...prev, ...r.items] : r.items))
      setTotal(r.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(0, false) }, [load])

  const counts = useMemo(
    () => ({
      all: items.length,
      song: items.filter((i) => matchesTab(i, 'song')).length,
      score: items.filter((i) => matchesTab(i, 'score')).length,
      waiting: items.filter((i) => matchesTab(i, 'waiting')).length,
    }),
    [items],
  )

  const filtered = useMemo(() => items.filter((i) => matchesTab(i, tab)), [items, tab])

  const doRelink = async () => {
    setRelinking(true)
    setRelinkMsg('')
    try {
      const r = await relinkScores()
      setRelinkMsg(
        `再マッチング：${r.checked}件中 ${r.linked}件リンク（残り${r.remaining}件）／再検算：${r.rechecked ?? 0}件中 ${r.resolved ?? 0}件解決`,
      )
      await load(0, false)
    } catch (e) {
      setRelinkMsg(`再マッチング・再検算に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRelinking(false)
    }
  }

  return (
    <div>
      <div className="review-header">
        <h1>要確認 {total > 0 && <span className="badge">{total}件</span>}</h1>
        <button type="button" className="primary" onClick={doRelink} disabled={relinking}>
          {relinking ? '再マッチング・再検算中…' : '再マッチング・再検算'}
        </button>
      </div>
      <p className="muted">
        読み取りエラーや検算不一致の記録です。原因を確認し、ワンタップ修正または手動修正してください。
      </p>
      {relinkMsg && <p className="notice">{relinkMsg}</p>}
      {error && <p className="warn">{error}</p>}

      <div className="review-tabs" role="tablist" aria-label="要確認フィルタ">
        {([
          ['all', 'すべて', counts.all],
          ['song', '曲・難易度', counts.song],
          ['score', 'EX・判定', counts.score],
          ['waiting', 'マスタ更新待ち', counts.waiting],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`review-tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label} <span className="review-tab-count">{count}</span>
          </button>
        ))}
      </div>

      {loading && items.length === 0 && <p className="muted">読み込み中…</p>}
      {!loading && filtered.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {items.length === 0
              ? '要確認の記録はありません。'
              : 'このカテゴリの要確認記録はありません。'}
          </p>
        </div>
      )}

      {filtered.map((item) => (
        <ReviewCard key={item.id} score={item} onReload={() => load(0, false)} onError={setError} />
      ))}
      {items.length < total && (
        <button type="button" onClick={() => load(items.length, true)} disabled={loading}>
          {loading ? '読み込み中…' : `もっと見る（残り ${(total - items.length).toLocaleString()} 件）`}
        </button>
      )}
    </div>
  )
}
