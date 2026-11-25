import { useEffect, useState } from 'react'
import { fetchJacketObjectUrl } from '../lib/api'

/** Song jacket thumbnail, loaded through the authenticated Worker endpoint.
 * Renders nothing until the image is available, so lists stay clean for
 * songs without a jacket. */
export default function JacketThumb({ songId, hasJacket, size = 44 }: {
  songId: string
  hasJacket?: number | null
  size?: number
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!hasJacket) return
    let alive = true
    fetchJacketObjectUrl(songId).then((u) => { if (alive) setUrl(u) })
    return () => { alive = false }
  }, [songId, hasJacket])
  if (!url) return null
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
