import { useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueue } from '../lib/queue'
import { ResultCard } from '../components/ResultCard'
import { getApiToken } from '../lib/api'

export function HomePage() {
  const { items, processing, lastResults, enqueue, remove, processNow, clearResults } = useQueue()
  const [params] = useSearchParams()
  const shared = params.get('shared') === '1'
  const fileRef = useRef<HTMLInputElement>(null)

  const onFiles = async (files: FileList | null) => {
    if (!files) return
    for (const f of Array.from(files)) {
      await enqueue(f, f.name, 'upload')
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div>
      <h1>DDR Score Manager</h1>
      {shared && <p className="notice">共有された画像を受け付けました。送信キューに入っています。</p>}
      {!getApiToken() && (
        <p className="warn">APIトークンが未設定です。先に「設定」画面でトークンを保存してください。</p>
      )}

      <div className="card">
        <h2>リザルト写真を送る</h2>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => onFiles(e.target.files)}
        />
        <p className="muted">送信前に自動で長辺1000px・WebPに変換されます。オフライン時はキューに残り、オンライン復帰で自動送信します。</p>
      </div>

      <div className="card">
        <h2>送信キュー（{items.length}件）{processing && <span className="muted"> 送信中…</span>}</h2>
        {items.length === 0 && <p className="muted">キューは空です。</p>}
        <ul className="queue-list">
          {items.map((i) => (
            <li key={i.id}>
              <span>{i.name}</span>
              <span className="muted">
                {i.status === 'error' ? `再試行待ち（一時的なエラーのため自動で再送します）: ${i.error || ''}` : i.status === 'sending' ? '送信中' : '待機中'}
              </span>
              <button type="button" onClick={() => remove(i.id)}>削除</button>
            </li>
          ))}
        </ul>
        {items.length > 0 && (
          <button type="button" onClick={() => processNow()}>今すぐ再送</button>
        )}
      </div>

      {lastResults.length > 0 && (
        <div>
          <h2>登録結果</h2>
          {lastResults.map((r) => (
            <ResultCard key={r.score.id} result={r} />
          ))}
          <button type="button" onClick={clearResults}>結果カードを閉じる</button>
        </div>
      )}
    </div>
  )
}
