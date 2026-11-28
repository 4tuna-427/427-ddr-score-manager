import { lazy, Suspense } from 'react'
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { QueueProvider } from './lib/queue'
import { HomePage } from './pages/Home'
import { HistoryPage } from './pages/History'
import { ReviewPage } from './pages/Review'
import { SettingsPage } from './pages/Settings'
import { BrowsePage } from './pages/Browse'
import { ScoreDetailPage } from './pages/ScoreDetail'

const ChartPage = lazy(() => import('./pages/Chart').then((m) => ({ default: m.ChartPage })))
const StatsPage = lazy(() => import('./pages/Stats').then((m) => ({ default: m.StatsPage })))

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
        <nav className="bottom-nav">
          <NavLink to="/" end>ホーム</NavLink>
          <NavLink to="/history">履歴</NavLink>
          <NavLink to="/browse">楽曲</NavLink>
          <NavLink to="/stats">統計</NavLink>
          <NavLink to="/review">要確認</NavLink>
          <NavLink to="/settings">設定</NavLink>
        </nav>
      </BrowserRouter>
    </QueueProvider>
  )
}
