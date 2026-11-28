import { useEffect, useState } from 'react'
import { fetchReviewImageObjectUrl } from '../lib/api'

interface ReviewImageProps {
  scoreId: string
  hasImage?: number
  label?: string
}

/**
 * Displays a compact thumbnail of the uploaded result image (when stored in KV)
 * and opens a full-screen zoomable modal on click.
 */
export function ReviewImage({ scoreId, hasImage, label = '読み取り画像' }: ReviewImageProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!hasImage) {
      setUrl(null)
      return
    }
    let active = true
    let createdUrl: string | null = null
    fetchReviewImageObjectUrl(scoreId).then((res) => {
      if (!active) {
        if (res) URL.revokeObjectURL(res)
        return
      }
      createdUrl = res
      setUrl(res)
    })
    return () => {
      active = false
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [scoreId, hasImage])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!hasImage || !url) return null

  return (
    <>
      <button
        type="button"
        className="review-img-thumb-btn"
        onClick={() => setOpen(true)}
        title="リザルト画像を拡大表示"
      >
        <img src={url} alt={label} className="review-img-thumb" />
        <span>画像を見る</span>
      </button>
      {open && (
        <div
          className="review-img-modal"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onClick={() => setOpen(false)}
        >
          <div className="review-img-modal-inner" onClick={(e) => e.stopPropagation()}>
            <div className="review-img-modal-bar">
              <span className="muted">{label}（ピンチやスクロールで拡大確認できます）</span>
              <button type="button" onClick={() => setOpen(false)}>閉じる</button>
            </div>
            <div className="review-img-scroll">
              <img src={url} alt={label} className="review-img-full" />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
