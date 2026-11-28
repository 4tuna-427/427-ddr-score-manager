import { useEffect, useState } from 'react'
import { fetchJacketObjectUrl } from '../lib/api'

/** Song jacket thumbnail, loaded through the authenticated Worker endpoint.
 * Renders nothing until the image is available unless `placeholder` is true,
 * in which case a fixed-size placeholder box is kept for layout alignment. */
export default function JacketThumb({ songId, hasJacket, size = 44, placeholder = false }: {
  songId: string
  hasJacket?: number | null
  size?: number
  placeholder?: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!hasJacket) {
      setUrl(null)
      return
    }
    let alive = true
    fetchJacketObjectUrl(songId).then((u) => { if (alive) setUrl(u) })
    return () => { alive = false }
  }, [songId, hasJacket])
  if (!url) {
    if (!placeholder) return null
    return (
      <span
        className="jacket-thumb jacket-thumb-placeholder"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    )
  }
  return (
    <img
      className="jacket-thumb"
      src={url}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      loading="lazy"
    />
  )
}
