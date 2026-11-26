import type { ReviewReason } from '../lib/api'

interface ReviewReasonBadgesProps {
  reasons?: ReviewReason[]
  reviewStatus?: string | null
}

function fmtNum(v: unknown): string {
  return typeof v === 'number' ? v.toLocaleString() : '—'
}

export function describeReason(r: ReviewReason): { label: string; detail: string; tone: 'song' | 'score' | 'player' } {
  const d = r.detail ?? {}
  switch (r.code) {
    case 'unlinked_song':
      return {
        label: '楽曲未特定・未登録',
        detail: 'マスタに該当する曲名が見つかりませんでした。候補から紐付けるか、仮登録・更新待ちにできます。',
        tone: 'song',
      }
    case 'difficulty_mismatch':
      return {
        label: '難易度・譜面不整合',
        detail: '曲名は一致しましたが、読み取った難易度の譜面がマスタに存在しません。正しい譜面を選び直してください。',
        tone: 'song',
      }
    case 'level_mismatch':
      return {
        label: 'レベル不一致',
        detail: `読取 Lv${d.extracted_level ?? '?'} ≠ マスタ Lv${d.master_level ?? '?'}（誤読または難易度違いの可能性があります）`,
        tone: 'song',
      }
    case 'ex_mismatch': {
      const diff = typeof d.diff === 'number' ? (d.diff > 0 ? `+${d.diff}` : String(d.diff)) : '?'
      return {
        label: 'EXスコア不一致',
        detail: `読取 ${fmtNum(d.ex_score)} ≠ 判定計算 ${fmtNum(d.calc_ex)}（差 ${diff}）`,
        tone: 'score',
      }
    }
    case 'ex_invalid': {
      if (d.reason === 'exceeds_max_ex') {
        return {
          label: 'EXスコア超過',
          detail: `読取 ${fmtNum(d.ex_score)} が譜面の理論最大EX (${fmtNum(d.max_ex)}) を超えています。`,
          tone: 'score',
        }
      }
      if (d.reason === 'negative') {
        return {
          label: 'EXスコア異常',
          detail: `EXスコアが負の値 (${fmtNum(d.ex_score)}) になっています。`,
          tone: 'score',
        }
      }
      return {
        label: 'EXスコア欠損',
        detail: `スコア (${fmtNum(d.score)}) に対してEXスコアが未入力または0です。`,
        tone: 'score',
      }
    }
    case 'judge_sum_mismatch':
      return {
        label: '判定合計不一致',
        detail: `読取合計 ${fmtNum(d.judge_sum)} ≠ マスタ総ノーツ ${fmtNum(d.expected)}`,
        tone: 'score',
      }
    case 'ok_exceeds_max':
      return {
        label: 'O.K.数超過',
        detail: `読取 O.K. (${fmtNum(d.ok)}) が譜面の最大O.K.数 (${fmtNum(d.max_ok)}) を超えています。`,
        tone: 'score',
      }
    case 'max_combo_exceeds_notes':
      return {
        label: 'MAX COMBO超過',
        detail: `読取 MAX COMBO (${fmtNum(d.max_combo)}) が譜面の最大コンボ数 (${fmtNum(d.max_notes)}) を超えています。`,
        tone: 'score',
      }
    case 'player_unresolved':
      return {
        label: 'プレイヤー未確定',
        detail: 'バーサス結果で1P/2Pの自動判別ができませんでした。自分の側を選択してください。',
        tone: 'player',
      }
  }
}

export function ReviewReasonBadges({ reasons, reviewStatus }: ReviewReasonBadgesProps) {
  if ((!reasons || reasons.length === 0) && reviewStatus !== 'waiting_master') return null
  return (
    <div className="review-reasons">
      {reviewStatus === 'waiting_master' && (
        <div className="reason-item reason-waiting">
          <span className="reason-pill waiting">マスタ更新待ち</span>
          <span className="reason-detail">次回のマスタ自動更新時に自動で再マッチングされます。</span>
        </div>
      )}
      {(reasons ?? []).map((r, i) => {
        const info = describeReason(r)
        return (
          <div key={`${r.code}-${i}`} className={`reason-item reason-${info.tone}`}>
            <span className={`reason-pill ${info.tone}`}>{info.label}</span>
            <span className="reason-detail">{info.detail}</span>
          </div>
        )
      })}
    </div>
  )
}
