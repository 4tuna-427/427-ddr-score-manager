import { useState, type ReactNode } from 'react'
import { searchSongs, type SongSearchItem } from '../lib/api'
import { diffLabel } from './DiffBadge'

interface SongSearchPanelProps {
  initialQuery?: string
  busy?: boolean
  onSelectChart: (chartId: string) => void
  onError?: (msg: string) => void
  emptyMessage?: string
  footer?: ReactNode
}

/** Shared song-search and chart-selection panel used in ReviewCard and ScoreDetailPage. */
export function SongSearchPanel({
  initialQuery = '',
  busy = false,
  onSelectChart,
  onError,
  emptyMessage = '該当する曲が見つかりません。',
  footer,
}: SongSearchPanelProps) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<SongSearchItem[]>([])
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)

  const doSearch = async () => {
    setSearching(true)
    onError?.('')
    try {
      const r = await searchSongs(query)
      setResults(r.items)
      setSearched(true)
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  return (
    <div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void doSearch() }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="曲名を入力して検索"
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={busy || searching}>検索</button>
      </form>
      {searched && results.length === 0 && emptyMessage && (
        <p className="muted">{emptyMessage}</p>
      )}
      <ul className="link-list">
        {results.map((song) => (
          <li key={song.song_id}>
            <div>
              <strong>{song.title}</strong> <span className="muted">{song.artist || ''}</span>
            </div>
            <div className="row wrap">
              {song.charts.map((c) => (
                <button
                  key={c.chart_id}
                  type="button"
                  disabled={busy || searching}
                  onClick={() => onSelectChart(c.chart_id)}
                >
                  {diffLabel(c.play_style, c.difficulty, c.level)}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {footer}
    </div>
  )
}
