import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { QueueProvider } from './lib/queue'
import { getApiToken, listScores } from './lib/api'
import { HomePage } from './pages/Home'
import { HistoryPage } from './pages/History'
import { ReviewPage } from './pages/Review'
import { SettingsPage } from './pages/Settings'
import { BrowsePage } from './pages/Browse'
import { ScoreDetailPage } from './pages/ScoreDetail'

const ChartPage = lazy(() => import('./pages/Chart').then((m) => ({ default: m.ChartPage })))
const StatsPage = lazy(() => import('./pages/Stats').then((m) => ({ default: m.StatsPage })))

function BottomNav() {
  const { pathname } = useLocation()
  const [reviewCount, setReviewCount] = useState(0)

  useEffect(() => {
    if (!getApiToken()) {
      setReviewCount(0)
      return
    }
    let alive = true
    listScores({ limit: 1, needsReview: true })
      .then((r) => { if (alive) setReviewCount(r.total) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [pathname])

  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail
      if (typeof detail === 'number') setReviewCount(detail)
    }
    window.addEventListener('ddr:review-changed', onChanged)
    return () => window.removeEventListener('ddr:review-changed', onChanged)
  }, [])

  return (
    <nav className="bottom-nav">
      <NavLink to="/" end>ホーム</NavLink>
      <NavLink to="/history">履歴</NavLink>
      <NavLink to="/browse">楽曲</NavLink>
      <NavLink to="/stats">統計</NavLink>
      <NavLink to="/review">
        要確認{reviewCount > 0 && <span className="nav-badge">{reviewCount > 99 ? '99+' : reviewCount}</span>}
      </NavLink>
      <NavLink to="/settings">設定</NavLink>
    </nav>
  )
}

export default function App() {
  return (
    <QueueProvider>
      <BrowserRouter>
        <header className="app-header">
          <div className="wordmark">DDR <em>SCORE</em> MANAGER</div>
          <div className="bar" />
        </header>
        <main className="container">
          <Suspense fallback={<p className="muted">読み込み中…</p>}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/upload" element={<HomePage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/scores/:id" element={<ScoreDetailPage />} />
              <Route path="/charts/:chartId" element={<ChartPage />} />
              <Route path="/browse" element={<BrowsePage />} />
              <Route path="/stats" element={<StatsPage />} />
              <Route path="/review" element={<ReviewPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Suspense>
        </main>
        <BottomNav />
      </BrowserRouter>
    </QueueProvider>
  )
}
