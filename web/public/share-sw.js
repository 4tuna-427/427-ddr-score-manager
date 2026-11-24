/* Share Target handler: loaded into the generated Service Worker via workbox.importScripts.
   Intercepts POST /share, stores the shared file in IndexedDB (same DB/store as the app queue),
   then redirects to /upload?shared=1 with 303. */
;(function () {
  var DB_NAME = 'ddr-score-manager'
  var STORE = 'queue'

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = function () {
        var db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = function () { resolve(req.result) }
      req.onerror = function () { reject(req.error) }
    })
  }

  function putItem(item) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(item)
        tx.oncomplete = function () { resolve() }
        tx.onerror = function () { reject(tx.error) }
      })
    })
  }

  self.addEventListener('fetch', function (event) {
    var url = new URL(event.request.url)
    if (event.request.method !== 'POST' || url.pathname !== '/share') return
    event.respondWith(
      (async function () {
        try {
          var formData = await event.request.formData()
          var file = formData.get('file')
          if (file && typeof file === 'object') {
            var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
            await putItem({
              id: id,
              blob: file,
              name: file.name || 'shared.jpg',
              type: file.type || 'image/jpeg',
              createdAt: Date.now(),
              status: 'pending',
              source: 'share',
            })
          }
        } catch (e) {
          /* fall through to redirect so the user still lands in the app */
        }
        return Response.redirect('/upload?shared=1', 303)
      })()
    )
  })
})()
