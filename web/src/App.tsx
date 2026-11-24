import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { QueueProvider } from './lib/queue'
import { HomePage } from './pages/Home'
import { HistoryPage } from './pages/History'
import { ReviewPage } from './pages/Review'
import { SettingsPage } from './pages/Settings'
import { BrowsePage } from './pages/Browse'
import { ScoreDetailPage } from './pages/ScoreDetail'
import { ChartPage } from './pages/Chart'

export default function App() {
  return (
    <QueueProvider>
      <BrowserRouter>
        <main className="container">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/upload" element={<HomePage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/scores/:id" element={<ScoreDetailPage />} />
            <Route path="/charts/:chartId" element={<ChartPage />} />
            <Route path="/browse" element={<BrowsePage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
        <nav className="bottom-nav">
          <NavLink to="/" end>ホーム</NavLink>
          <NavLink to="/history">履歴</NavLink>
          <NavLink to="/browse">楽曲</NavLink>
          <NavLink to="/review">要確認</NavLink>
          <NavLink to="/settings">設定</NavLink>
        </nav>
      </BrowserRouter>
    </QueueProvider>
  )
}
