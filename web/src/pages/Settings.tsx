import { useState } from 'react'
import { fetchExportBlob, getApiBaseUrl, getApiToken, setApiBaseUrl, setApiToken } from '../lib/api'

export function SettingsPage() {
  const [token, setToken] = useState(getApiToken())
  const [base, setBase] = useState(getApiBaseUrl())
  const [saved, setSaved] = useState(false)
  const [exportMsg, setExportMsg] = useState('')

  const doExport = async () => {
    try {
      const blob = await fetchExportBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ddr-scores-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      setExportMsg('エクスポートしました')
    } catch (e) {
      setExportMsg(`エクスポートに失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

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
        <button type="button" className="primary" onClick={save}>保存</button>
        {saved && <span className="muted">保存しました</span>}
      </div>
      <p className="muted">トークンとベースURLはこの端末の localStorage にのみ保存されます。</p>
      <div className="card form">
        <h2>データのバックアップ</h2>
        <p className="muted">登録済みスコア全件を JSON ファイルでダウンロードします。</p>
        <button type="button" className="primary" onClick={doExport}>スコアをエクスポート（JSON）</button>
        {exportMsg && <span className="muted">{exportMsg}</span>}
      </div>
    </div>
  )
}
