import { useState } from 'react'
import { getApiBaseUrl, getApiToken, setApiBaseUrl, setApiToken } from '../lib/api'

export function SettingsPage() {
  const [token, setToken] = useState(getApiToken())
  const [base, setBase] = useState(getApiBaseUrl())
  const [saved, setSaved] = useState(false)

  const save = () => {
    setApiToken(token.trim())
    setApiBaseUrl(base.trim())
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div>
      <h1>設定</h1>
      <div className="card form">
        <label>
          APIトークン
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="X-API-Token" autoComplete="off" />
        </label>
        <label>
          APIベースURL（空なら相対 /api）
          <input type="url" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://your-worker.example.workers.dev" />
        </label>
        <button type="button" onClick={save}>保存</button>
        {saved && <span className="muted">保存しました</span>}
      </div>
      <p className="muted">トークンとベースURLはこの端末の localStorage にのみ保存されます。</p>
    </div>
  )
}
