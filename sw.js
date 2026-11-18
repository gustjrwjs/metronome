// 오프라인 캐시. 네트워크 우선이라 VERSION을 안 올려도 새 파일이 반영됩니다(올리면 옛 캐시를 정리).
const VERSION = 'metronome-v6';
const FILES = ['./', 'index.html', 'metronome.js', 'themes.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// 네트워크 우선, 실패하면 캐시 (오프라인에서도 동작)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    // no-cache: 브라우저 HTTP 캐시의 옛 파일 대신 항상 서버에 새 버전 확인
    fetch(e.request, { cache: 'no-cache' }).then((r) => {
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
