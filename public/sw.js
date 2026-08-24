/* Service worker tối thiểu.
   Chỉ cache phần vỏ giao diện. Mọi thứ dưới /api và /k luôn đi thẳng ra mạng —
   cache dữ liệu chấm công là sai, nhân viên sẽ thấy trạng thái cũ. */
const CACHE = 'tram-truc-v2';
const SHELL = ['/', '/app.css', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/k/')) return;

  // Ưu tiên mạng, hỏng mạng mới lấy bản đã cache -> nhân viên vẫn mở được app khi sóng chập chờn
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});

/* Bấm vào thông báo thì đưa app đang mở lên trước, chưa mở thì mở mới.
   Nhờ vậy nhân viên chạm thông báo là vào thẳng thẻ điểm danh. */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow('/');
    })
  );
});
