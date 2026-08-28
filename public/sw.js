/* Service worker tối thiểu.

   Bài học: cache trang HTML là nguồn gốc của việc "deploy rồi mà vẫn thấy bản cũ".
   Nên ở đây HTML KHÔNG BAO GIỜ được cache — chỉ cache ảnh biểu tượng và manifest,
   là những thứ gần như không đổi. CSS đi kèm số phiên bản trong đường dẫn nên
   đổi file là đổi luôn địa chỉ, không cần cache thông minh.

   Mọi thứ dưới /api và /k luôn đi thẳng ra mạng — cache dữ liệu chấm công là sai,
   nhân viên sẽ thấy trạng thái cũ. */

const CACHE = 'tram-truc-v4';
const SHELL = ['/icon-192.png', '/icon-512.png', '/icon-180.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())      // bản mới thay bản cũ ngay, không chờ đóng tab
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Nhận lệnh từ trang: có bản mới thì kích hoạt ngay */
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/k/')) return;

  // HTML và CSS: LUÔN lấy từ mạng, không đụng tới cache.
  // Đây là chỗ trước đây gây ra việc phải Ctrl+Shift+R sau mỗi lần deploy.
  const laTrang = req.mode === 'navigate'
    || url.pathname === '/' || url.pathname === '/admin'
    || url.pathname.endsWith('.html') || url.pathname.endsWith('.css');

  if (laTrang) {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() =>
      new Response('<h1>Mất mạng</h1><p>Kết nối lại rồi tải lại trang.</p>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 })));
    return;
  }

  // Ảnh biểu tượng và manifest: có sẵn thì lấy ngay, chưa có thì tải rồi cất
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});

/* Bấm vào thông báo thì đưa app đang mở lên trước, chưa mở thì mở mới. */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('/');
    })
  );
});
